import { AbiCoder, Interface, JsonRpcProvider, Network, getAddress, keccak256, type BaseWallet } from 'ethers'
import type { GiveawayChain } from '@virvixr/shared'
import { config } from '../config.js'
import { BEAT_MIN_PRIORITY_FEE_WEI, broadcastDown } from '../beats/chain.js'
import { DCL_COLLECTION_ABI } from './abi.js'

/**
 * The giveaway chain client (LIV-194): reads Decentraland collection contracts and signs and sends the per-giveaway
 * wallets' transactions (issueTokens mints and POL transfers) on one chain. Signers (an ethers Wallet, or any BaseWallet) are
 * passed per call; the client holds no key. The sending policy (nonces, fee bumps, retries) belongs to the minting job, not here.
 *
 * Privacy: errors never carry the RPC payload (calldata holds visitors' wallets), only an operation name, an ethers code
 * and, for reverts, the collection's revert string when it is one of its fixed `function: CODE` strings.
 */

export const collectionInterface = new Interface(DCL_COLLECTION_ABI)

export type GiveawayFees = { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }
/** The node's fees as the sign calls would use them, with the latest base fee (null when the node gives none). */
export type GiveawayFeeData = GiveawayFees & { baseFeePerGas: bigint | null }
export type GiveawayItemState = { approved: boolean; completed: boolean; canMint: boolean; remaining: bigint; rarity: string }
export type GiveawayIssue = { beneficiary: string; tokenId: string; itemId: string }
export type GiveawayReceipt = { ok: boolean; blockNumber: number; feeWei: bigint; issues: GiveawayIssue[] }
export type GiveawayLog = { address: string; topics: readonly string[]; data: string }
export type GiveawayRevertReason = 'not_minter' | 'sold_out' | 'not_approved'

/** The lowest tip the default fee path signs with (the same floor as BEATs: Polygon and Amoy reject tips under ~25-30 gwei). */
export const GIVEAWAY_MIN_PRIORITY_FEE_WEI = BEAT_MIN_PRIORITY_FEE_WEI
/** A plain POL transfer's gas. */
export const GIVEAWAY_TRANSFER_GAS = 21_000n

const CHAIN_ID: Record<GiveawayChain, number> = { polygon: 137, 'polygon-amoy': 80002 }

export interface GiveawayChainClient {
  readonly chain: GiveawayChain
  balanceWei(address: string): Promise<bigint>
  nonce(address: string, tag: 'latest' | 'pending'): Promise<number>
  /** The node's fees (what the sign calls use when given none): the tip at least GIVEAWAY_MIN_PRIORITY_FEE_WEI and
   * maxFeePerGas = max(the node's maxFee, 2 × latest base fee + tip). */
  feeData(): Promise<GiveawayFeeData>
  /** A collection item's state for one minter. `canMint`: a global minter, or an item allowance above 0. */
  itemState(contract: string, itemId: string, minter: string): Promise<GiveawayItemState>
  /**
   * Signs `issueTokens(wallets, itemIds)` (wallets[i] gets one of itemIds[i]) from `signer` at this nonce.
   * - Fees: as given, else feeData().
   * - Gas limit: as given (a replacement must pass the original's), else the node's estimate plus 20%. A reverting
   *   estimate throws GiveawayRevert (see revertReason).
   */
  signMint(signer: BaseWallet, contract: string, wallets: string[], itemIds: string[], nonce: number, fees?: GiveawayFees, gasLimit?: bigint):
    Promise<{ raw: string; hash: string; gasLimit: bigint; fees: GiveawayFees }>
  /** Signs a plain POL transfer (gas limit 21000) from `signer` at this nonce. Fees as given, else feeData(). */
  signTransfer(signer: BaseWallet, to: string, valueWei: bigint, nonce: number, fees?: GiveawayFees): Promise<{ raw: string; hash: string; fees: GiveawayFees }>
  /** Sends a signed transaction. "Already known", or "nonce too low" when this exact transaction is on chain, is success. */
  broadcast(raw: string): Promise<void>
  /** The mined transaction (null when not yet): its status, block, fee paid, and the Issue logs of the contract it called. */
  receipt(hash: string): Promise<GiveawayReceipt | null>
  latestBlock(): Promise<number>
}

/** A collection call reverted. `reason` is the collection's revert string (`_issueToken: ITEM_EXHAUSTED`, ...) or 'unknown'. */
export class GiveawayRevert extends Error {
  readonly reason: string
  constructor(reason: string) {
    const r = SAFE_REASON.test(reason) ? reason : 'unknown'
    super(`Collection call reverted: ${r}`)
    this.name = 'GiveawayRevert'
    this.reason = r
  }
}

/** An RPC call failed for a reason other than a revert. `code` is the ethers error code (NONCE_EXPIRED,
 * INSUFFICIENT_FUNDS, NETWORK_ERROR, ...) or 'UNKNOWN_ERROR'. `down` (broadcast only): the RPC couldn't be reached or
 * gave no JSON-RPC error, as opposed to refusing the transaction. */
export class GiveawayRpcError extends Error {
  constructor(readonly op: string, readonly code: string, readonly down = false) {
    super(`Giveaway RPC ${op} failed (${code})`)
    this.name = 'GiveawayRpcError'
  }
}

/** The collection's revert strings are `function: CODE`; anything else is not kept (it could echo arguments). */
const SAFE_REASON = /^_?[A-Za-z]+: [A-Z_]+$/

const REASONS: [RegExp, GiveawayRevertReason][] = [
  [/: CALLER_CAN_NOT_MINT$/, 'not_minter'],
  [/: ITEM_EXHAUSTED$/, 'sold_out'],
  [/: MINT_NOT_ALLOWED$/, 'not_approved'],
]

const codeOf = (err: any) => (typeof err?.code === 'string' ? err.code : 'UNKNOWN_ERROR')

/** Runs `fn`, turning any failure into a payload-free GiveawayRpcError (ethers' messages echo arguments, i.e. wallets). */
function safely<T>(op: string, fn: () => T): T {
  try { return fn() } catch (err) {
    if (err instanceof GiveawayRpcError || err instanceof GiveawayRevert) throw err
    throw new GiveawayRpcError(op, codeOf(err))
  }
}

/** The revert data of an ethers CALL_EXCEPTION, wherever the node put it. */
function revertData(err: any): string | null {
  for (const d of [err?.data, err?.info?.error?.data, err?.info?.error?.data?.data, err?.error?.data]) {
    if (typeof d === 'string' && /^0x[0-9a-fA-F]*$/.test(d)) return d
  }
  return null
}

const ERROR_STRING = '0x08c379a0'

/** The Error(string) revert string of a failed call, from its revert data or ethers' decoded reason; '' when none. */
function revertString(err: any): string {
  const data = revertData(err)
  if (data && data.toLowerCase().startsWith(ERROR_STRING) && data.length > 10) {
    try { return String(AbiCoder.defaultAbiCoder().decode(['string'], '0x' + data.slice(10))[0]) } catch { /* fall through */ }
  }
  return typeof err?.reason === 'string' ? err.reason : ''
}

/** What a failed collection call means for a giveaway: the caller isn't a minter, the item is sold out, or the
 * collection isn't approved for minting. Null for anything else. Takes a GiveawayRevert or a raw ethers error. */
export function revertReason(e: unknown): GiveawayRevertReason | null {
  if (e instanceof GiveawayRpcError) return null
  const reason = e instanceof GiveawayRevert ? e.reason : revertString(e)
  return REASONS.find(([re]) => re.test(reason))?.[1] ?? null
}

/** The node's own message for a failed request, for classification only (never put in an error). */
function rpcMessage(err: any): string {
  const parts = [err?.info?.error?.message, err?.error?.message, err?.shortMessage]
  return parts.filter((p) => typeof p === 'string').join(' | ')
}

/** The ethers code, with any refusal for lack of funds as INSUFFICIENT_FUNDS (some nodes word it so ethers doesn't). */
function noFundsCode(err: any): string {
  const code = codeOf(err)
  return code === 'INSUFFICIENT_FUNDS' || /insufficient funds/i.test(rpcMessage(err)) ? 'INSUFFICIENT_FUNDS' : code
}

const ISSUE = collectionInterface.getEvent('Issue')!.topicHash

/** The Issue logs of `contract` among these logs: who got which token of which item. Other contracts' logs are ignored. */
export function issuesIn(contract: string, logs: readonly GiveawayLog[]): GiveawayIssue[] {
  const out: GiveawayIssue[] = []
  for (const l of logs) {
    if (l.address.toLowerCase() !== contract.toLowerCase() || l.topics[0]?.toLowerCase() !== ISSUE || l.topics.length !== 4) continue
    out.push({ beneficiary: getAddress('0x' + l.topics[1].slice(-40)), tokenId: BigInt(l.topics[2]).toString(), itemId: BigInt(l.topics[3]).toString() })
  }
  return out
}

class RpcGiveawayChain implements GiveawayChainClient {
  readonly #provider: JsonRpcProvider

  constructor(readonly chain: GiveawayChain, provider: JsonRpcProvider) {
    this.#provider = provider
  }

  async #rpc<T>(op: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn()
    } catch (err) {
      if (err instanceof GiveawayRpcError || err instanceof GiveawayRevert) throw err
      throw new GiveawayRpcError(op, codeOf(err))
    }
  }

  async #view(contract: string, fn: string, args: unknown[]): Promise<any> {
    const data = safely('encode', () => collectionInterface.encodeFunctionData(fn, args))
    const to = safely('encode', () => getAddress(contract))
    const out = await this.#rpc(fn, () => this.#provider.call({ to, data }))
    return safely('decode', () => collectionInterface.decodeFunctionResult(fn, out))
  }

  balanceWei(address: string) { return this.#rpc('balance', () => this.#provider.getBalance(safely('encode', () => getAddress(address)))) }
  nonce(address: string, tag: 'latest' | 'pending') {
    return this.#rpc('nonce', () => this.#provider.getTransactionCount(safely('encode', () => getAddress(address)), tag))
  }
  latestBlock() { return this.#rpc('block', () => this.#provider.getBlockNumber()) }

  async feeData(): Promise<GiveawayFeeData> {
    const [d, block] = await this.#rpc('fees', () => Promise.all([this.#provider.getFeeData(), this.#provider.getBlock('latest')]))
    const nodeTip = d.maxPriorityFeePerGas ?? d.gasPrice ?? 0n
    const tip = nodeTip > GIVEAWAY_MIN_PRIORITY_FEE_WEI ? nodeTip : GIVEAWAY_MIN_PRIORITY_FEE_WEI
    const base = block?.baseFeePerGas
    const floor = base != null ? 2n * base + tip : tip
    const nodeMax = d.maxFeePerGas ?? d.gasPrice ?? 0n
    if (base == null && nodeMax === 0n && nodeTip === 0n) throw new GiveawayRpcError('fees', 'MISSING_FEE_DATA')
    return { maxFeePerGas: nodeMax > floor ? nodeMax : floor, maxPriorityFeePerGas: tip, baseFeePerGas: base ?? null }
  }

  async itemState(contract: string, itemId: string, minter: string): Promise<GiveawayItemState> {
    const id = safely('encode', () => BigInt(itemId))
    const [item, approved, completed, global, allowance] = await Promise.all([
      this.#view(contract, 'items', [id]),
      this.#view(contract, 'isApproved', []),
      this.#view(contract, 'isCompleted', []),
      this.#view(contract, 'globalMinters', [minter]),
      this.#view(contract, 'itemMinters', [id, minter]),
    ])
    const max = BigInt(item.maxSupply)
    const total = BigInt(item.totalSupply)
    return {
      approved: Boolean(approved[0]), completed: Boolean(completed[0]),
      canMint: Boolean(global[0]) || BigInt(allowance[0]) > 0n,
      remaining: max > total ? max - total : 0n, rarity: String(item.rarity),
    }
  }

  async #fees(fees?: GiveawayFees): Promise<GiveawayFees> {
    const d = fees ?? await this.feeData()
    return { maxFeePerGas: d.maxFeePerGas, maxPriorityFeePerGas: d.maxPriorityFeePerGas }
  }

  async #sign(signer: BaseWallet, tx: { to: string; data: string; value: bigint; gasLimit: bigint; nonce: number }, f: GiveawayFees) {
    const raw = await this.#rpc('sign', () => signer.signTransaction({
      type: 2, chainId: BigInt(CHAIN_ID[this.chain]), ...tx, maxFeePerGas: f.maxFeePerGas, maxPriorityFeePerGas: f.maxPriorityFeePerGas,
    }))
    return { raw, hash: keccak256(raw) }
  }

  async signMint(signer: BaseWallet, contract: string, wallets: string[], itemIds: string[], nonce: number, fees?: GiveawayFees, gasLimit?: bigint) {
    const to = safely('encode', () => getAddress(contract))
    const data = safely('encode', () => collectionInterface.encodeFunctionData('issueTokens', [wallets.map((w) => getAddress(w)), itemIds.map((i) => BigInt(i))]))
    const f = await this.#fees(fees)
    let gas = gasLimit
    if (gas === undefined) {
      try {
        gas = (await this.#provider.estimateGas({ from: signer.address, to, data })) * 12n / 10n
      } catch (err) {
        if (codeOf(err) === 'CALL_EXCEPTION') throw new GiveawayRevert(revertString(err))
        throw new GiveawayRpcError('estimate', noFundsCode(err))
      }
    }
    return { ...await this.#sign(signer, { to, data, value: 0n, gasLimit: gas, nonce }, f), gasLimit: gas, fees: f }
  }

  async signTransfer(signer: BaseWallet, to: string, valueWei: bigint, nonce: number, fees?: GiveawayFees) {
    const dest = safely('encode', () => getAddress(to))
    const f = await this.#fees(fees)
    return { ...await this.#sign(signer, { to: dest, data: '0x', value: valueWei, gasLimit: GIVEAWAY_TRANSFER_GAS, nonce }, f), fees: f }
  }

  async broadcast(raw: string): Promise<void> {
    try {
      await this.#provider.broadcastTransaction(raw)
    } catch (err) {
      const code = noFundsCode(err)
      if (/already known|known transaction|already imported/i.test(rpcMessage(err))) return
      if (code === 'NONCE_EXPIRED') {
        const hash = keccak256(raw)
        const found = await this.#rpc('broadcast', () => this.#provider.getTransaction(hash))
        if (found && found.hash.toLowerCase() === hash.toLowerCase()) return
      }
      throw new GiveawayRpcError('broadcast', code, broadcastDown(err))
    }
  }

  async receipt(hash: string): Promise<GiveawayReceipt | null> {
    const r = await this.#rpc('receipt', () => this.#provider.getTransactionReceipt(hash))
    if (!r) return null
    return {
      ok: r.status === 1, blockNumber: r.blockNumber, feeWei: BigInt(r.fee),
      issues: r.to ? issuesIn(r.to, r.logs) : [],
    }
  }
}

/**
 * A client for a chain's RPC (config.giveaways.rpc unless `rpcUrl` is given; the anvil test passes one).
 * - The network is a plain `new Network(name, chainId)`, not ethers' registered one, whose Polygon entry fetches fees
 *   from the Polygon gas station and fails when that's down; fees come from the node.
 * - `cacheTimeout: -1` turns off ethers' 250ms sharing of identical reads, so a nonce, receipt or block number read
 *   right after a transaction lands is never stale.
 */
export function createGiveawayChainClient(chain: GiveawayChain, rpcUrl?: string): GiveawayChainClient {
  const network = new Network(chain, CHAIN_ID[chain])
  const provider = new JsonRpcProvider(rpcUrl ?? config.giveaways.rpc[chain], network, { staticNetwork: network, cacheTimeout: -1 })
  return giveawayChainClientOn(chain, provider)
}

/** A client over a given provider (unit tests pass a stub). */
export function giveawayChainClientOn(chain: GiveawayChain, provider: JsonRpcProvider): GiveawayChainClient {
  return new RpcGiveawayChain(chain, provider)
}

const built = new Map<GiveawayChain, GiveawayChainClient>()
const overrides = new Map<GiveawayChain, GiveawayChainClient>()

/** The chain's client, built once from config.giveaways.rpc. */
export function giveawayChainClient(chain: GiveawayChain): GiveawayChainClient {
  const o = overrides.get(chain)
  if (o) return o
  let c = built.get(chain)
  if (!c) {
    c = createGiveawayChainClient(chain)
    built.set(chain, c)
  }
  return c
}

/** Tests put a fake in for a chain; null removes it and forgets the built client, so the next call reads config again. */
export function setGiveawayChainClientForTests(chain: GiveawayChain, client: GiveawayChainClient | null): void {
  built.delete(chain)
  if (client) overrides.set(chain, client)
  else overrides.delete(chain)
}
