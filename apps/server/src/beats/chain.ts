import { Interface, JsonRpcProvider, Network, Wallet, getAddress, keccak256 } from 'ethers'
import type { BeatChain } from '@virvixr/shared'
import { BEAT_CHAIN_INFO } from '@virvixr/shared'
import { config } from '../config.js'
import { VIRVI_BEAT_ABI } from './abi.js'

/**
 * The BEAT chain client (LIV-11): reads the VirviBeat contract and signs and sends the minter's transactions on one
 * chain. The sending policy (nonces, gas headroom, fee bumps, retries) belongs to the minting job, not here.
 *
 * Secrets and privacy: the minter key lives only inside the ethers Wallet in a private field; only its address is
 * exposed. Errors never carry the RPC payload (calldata holds visitors' wallets), only an operation name, an ethers
 * code and, for reverts, the decoded custom error name.
 */

export const beatInterface = new Interface(VIRVI_BEAT_ABI)

export type BeatCall =
  | { kind: 'create'; tokenId: bigint; tradeable: boolean }
  | { kind: 'mint'; tokenId: bigint; wallets: string[] }
  | { kind: 'close'; tokenId: bigint }

export type BeatFees = { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }
export type BeatLog = { address: string; topics: readonly string[]; data: string }
export type BeatReceipt = { ok: boolean; blockNumber: number; logs: BeatLog[] }
export type BeatSigned = { raw: string; hash: string; fees: BeatFees; gasLimit: bigint }

/** The lowest tip the default fee path signs with, on both chains (Polygon and Amoy reject tips under ~25-30 gwei). */
export const BEAT_MIN_PRIORITY_FEE_WEI = 30_000_000_000n

export interface BeatChainClient {
  readonly chain: BeatChain
  readonly minterAddress: string
  /** The minter's POL balance. */
  balanceWei(): Promise<bigint>
  nonce(tag: 'latest' | 'pending'): Promise<number>
  /** True when the address has code (a contract, or an EIP-7702 delegated wallet). */
  codeAt(address: string): Promise<boolean>
  /** The node's gas estimate for the call from the minter, nothing added. Throws BeatRevert when it reverts. */
  estimate(call: BeatCall): Promise<bigint>
  /**
   * Signs the call at this nonce. The result carries the fees and gas limit it used.
   * - Fees: as given when passed; otherwise from the node, with the tip at least BEAT_MIN_PRIORITY_FEE_WEI and
   *   maxFeePerGas = max(the node's maxFee, 2 × latest base fee + tip).
   * - Gas limit: as given when passed; otherwise `estimate(call)`. A replacement (same nonce, bumped fees) must pass
   *   the original's gasLimit, so it never re-estimates against state the original may already have changed.
   */
  sign(call: BeatCall, nonce: number, fees?: BeatFees, gasLimit?: bigint): Promise<BeatSigned>
  /** Sends a signed transaction. "Already known", or "nonce too low" when this exact transaction is on chain, is success. */
  broadcast(raw: string): Promise<void>
  receipt(hash: string): Promise<BeatReceipt | null>
  latestBlock(): Promise<number>
  isMinted(tokenId: bigint, wallet: string): Promise<boolean>
  exists(tokenId: bigint): Promise<boolean>
  /** The wallets of this contract's `MintSkipped` logs among a receipt's logs (checksummed). */
  skippedIn(logs: BeatLog[]): string[]
}

/** A call reverted. `name` is the contract's custom error name ('UnknownBeat', 'InsufficientGas', ...) or 'unknown'. */
export class BeatRevert extends Error {
  constructor(name: string) {
    super(`BEAT call reverted: ${name}`)
    this.name = name
  }
}

/** An RPC call failed for a reason other than a revert. `code` is the ethers error code (NONCE_EXPIRED,
 * REPLACEMENT_UNDERPRICED, INSUFFICIENT_FUNDS, NETWORK_ERROR, ...) or 'UNKNOWN_ERROR'. */
export class BeatRpcError extends Error {
  constructor(readonly op: string, readonly code: string) {
    super(`BEAT RPC ${op} failed (${code})`)
    this.name = 'BeatRpcError'
  }
}

const codeOf = (err: any) => (typeof err?.code === 'string' ? err.code : 'UNKNOWN_ERROR')

/** Runs `fn`, turning any failure into a payload-free BeatRpcError (ethers' messages echo arguments, i.e. wallets). */
function safely<T>(op: string, fn: () => T): T {
  try { return fn() } catch (err) {
    if (err instanceof BeatRpcError || err instanceof BeatRevert) throw err
    throw new BeatRpcError(op, codeOf(err))
  }
}

/** The calldata for a call. A bad argument (say, a malformed wallet) throws BeatRpcError('encode', ...) without it. */
export function encodeBeatCall(call: BeatCall): string {
  return safely('encode', () => {
    switch (call.kind) {
      case 'create': return beatInterface.encodeFunctionData('createBeat', [call.tokenId, call.tradeable])
      case 'mint': return beatInterface.encodeFunctionData('mintTo', [call.tokenId, call.wallets])
      case 'close': return beatInterface.encodeFunctionData('closeBeat', [call.tokenId])
    }
  })
}

const MINT_SKIPPED = beatInterface.getEvent('MintSkipped')!.topicHash

/** The wallets of `contract`'s MintSkipped logs among these logs, checksummed. Other contracts' logs are ignored. */
export function skippedIn(contract: string, logs: BeatLog[]): string[] {
  const out: string[] = []
  for (const l of logs) {
    if (l.address.toLowerCase() !== contract.toLowerCase() || l.topics[0]?.toLowerCase() !== MINT_SKIPPED) continue
    if (l.topics.length !== 3) continue
    out.push(getAddress('0x' + l.topics[2].slice(-40)))
  }
  return out
}

/** The revert data of an ethers CALL_EXCEPTION, wherever the node put it. */
function revertData(err: any): string | null {
  for (const d of [err?.data, err?.info?.error?.data, err?.info?.error?.data?.data, err?.error?.data]) {
    if (typeof d === 'string' && /^0x[0-9a-fA-F]*$/.test(d)) return d
  }
  return null
}

/** The custom error name for some revert data, or 'unknown'. */
export function revertName(data: string | null): string {
  if (!data || data.length < 10) return 'unknown'
  try { return beatInterface.parseError(data)?.name ?? 'unknown' } catch { return 'unknown' }
}

/** The node's own message for a failed request, for classification only (never put in an error). */
function rpcMessage(err: any): string {
  const parts = [err?.info?.error?.message, err?.error?.message, err?.shortMessage]
  return parts.filter((p) => typeof p === 'string').join(' | ')
}

/** The ethers code, with any refusal for lack of funds as INSUFFICIENT_FUNDS: ethers maps the usual node message to it,
 * but some nodes word it so ethers doesn't, and the job pauses for low gas on this code alone. */
function noFundsCode(err: any): string {
  const code = codeOf(err)
  return code === 'INSUFFICIENT_FUNDS' || /insufficient funds/i.test(rpcMessage(err)) ? 'INSUFFICIENT_FUNDS' : code
}

class RpcBeatChain implements BeatChainClient {
  readonly minterAddress: string
  readonly #wallet: Wallet
  readonly #provider: JsonRpcProvider
  readonly #contract: string

  constructor(readonly chain: BeatChain, provider: JsonRpcProvider, contract: string, minterKey: string) {
    this.#provider = provider
    this.#contract = getAddress(contract)
    this.#wallet = new Wallet(minterKey)
    this.minterAddress = this.#wallet.address
  }

  async #rpc<T>(op: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn()
    } catch (err) {
      if (err instanceof BeatRpcError || err instanceof BeatRevert) throw err
      throw new BeatRpcError(op, codeOf(err))
    }
  }

  async #view(fn: string, args: unknown[]): Promise<any> {
    const data = safely('encode', () => beatInterface.encodeFunctionData(fn, args))
    const out = await this.#rpc(fn, () => this.#provider.call({ to: this.#contract, data }))
    return safely('decode', () => beatInterface.decodeFunctionResult(fn, out)[0])
  }

  balanceWei() { return this.#rpc('balance', () => this.#provider.getBalance(this.minterAddress)) }
  nonce(tag: 'latest' | 'pending') { return this.#rpc('nonce', () => this.#provider.getTransactionCount(this.minterAddress, tag)) }
  async codeAt(address: string) { return (await this.#rpc('code', () => this.#provider.getCode(address))) !== '0x' }
  latestBlock() { return this.#rpc('block', () => this.#provider.getBlockNumber()) }
  async isMinted(tokenId: bigint, wallet: string) { return Boolean(await this.#view('minted', [tokenId, wallet])) }
  async exists(tokenId: bigint) { return Boolean(await this.#view('exists', [tokenId])) }
  skippedIn(logs: BeatLog[]) { return skippedIn(this.#contract, logs) }

  async estimate(call: BeatCall): Promise<bigint> {
    const data = encodeBeatCall(call)
    try {
      return await this.#provider.estimateGas({ from: this.minterAddress, to: this.#contract, data })
    } catch (err: any) {
      if (codeOf(err) === 'CALL_EXCEPTION') throw new BeatRevert(revertName(revertData(err)))
      throw new BeatRpcError('estimate', noFundsCode(err))
    }
  }

  async sign(call: BeatCall, nonce: number, fees?: BeatFees, gasLimit?: bigint): Promise<BeatSigned> {
    const data = encodeBeatCall(call)
    const f = fees ?? await this.#feeData()
    const gas = gasLimit ?? await this.estimate(call)
    const raw = await this.#rpc('sign', () => this.#wallet.signTransaction({
      type: 2, chainId: BigInt(BEAT_CHAIN_INFO[this.chain].chainId), to: this.#contract, data,
      nonce, gasLimit: gas, maxFeePerGas: f.maxFeePerGas, maxPriorityFeePerGas: f.maxPriorityFeePerGas, value: 0n,
    }))
    return { raw, hash: keccak256(raw), fees: f, gasLimit: gas }
  }

  /** The node's fees (eth_maxPriorityFeePerGas and the latest base fee, through ethers' getFeeData), with the tip
   * raised to the floor and maxFee to at least 2 × base fee + tip. */
  async #feeData(): Promise<BeatFees> {
    const [d, block] = await this.#rpc('fees', () => Promise.all([this.#provider.getFeeData(), this.#provider.getBlock('latest')]))
    const nodeTip = d.maxPriorityFeePerGas ?? d.gasPrice ?? 0n
    const tip = nodeTip > BEAT_MIN_PRIORITY_FEE_WEI ? nodeTip : BEAT_MIN_PRIORITY_FEE_WEI
    const base = block?.baseFeePerGas
    const floor = base != null ? 2n * base + tip : tip
    const nodeMax = d.maxFeePerGas ?? d.gasPrice ?? 0n
    if (base == null && nodeMax === 0n && nodeTip === 0n) throw new BeatRpcError('fees', 'MISSING_FEE_DATA')
    return { maxFeePerGas: nodeMax > floor ? nodeMax : floor, maxPriorityFeePerGas: tip }
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
      throw new BeatRpcError('broadcast', code)
    }
  }

  async receipt(hash: string): Promise<BeatReceipt | null> {
    const r = await this.#rpc('receipt', () => this.#provider.getTransactionReceipt(hash))
    if (!r) return null
    return {
      ok: r.status === 1, blockNumber: r.blockNumber,
      logs: r.logs.map((l) => ({ address: l.address, topics: [...l.topics], data: l.data })),
    }
  }
}

/**
 * A client for any RPC endpoint and contract (the anvil test uses this; the server uses beatChainClient).
 * - The network is a plain `new Network(name, chainId)`, not ethers' registered one, whose Polygon entry fetches fees
 *   from the Polygon gas station and fails when that's down; fees come from the node.
 * - `cacheTimeout: -1` turns off ethers' 250ms sharing of identical reads, so a nonce, receipt or block number read
 *   right after a transaction lands is never stale.
 */
export function createBeatChainClient(opts: { chain: BeatChain; rpcUrl: string; contract: string; minterKey: string }): BeatChainClient {
  const network = new Network(opts.chain, BEAT_CHAIN_INFO[opts.chain].chainId)
  const provider = new JsonRpcProvider(opts.rpcUrl, network, { staticNetwork: network, cacheTimeout: -1 })
  return beatChainClientOn(opts.chain, provider, opts.contract, opts.minterKey)
}

/** A client over a given provider (unit tests pass a stub). */
export function beatChainClientOn(chain: BeatChain, provider: JsonRpcProvider, contract: string, minterKey: string): BeatChainClient {
  return new RpcBeatChain(chain, provider, contract, minterKey)
}

const built = new Map<BeatChain, BeatChainClient>()
const overrides = new Map<BeatChain, BeatChainClient>()

/** The chain's client, built once from config.beats; null when BEATs are off, or there's no minter key or no contract
 * for that chain. */
export function beatChainClient(chain: BeatChain): BeatChainClient | null {
  const o = overrides.get(chain)
  if (o) return o
  const b = config.beats
  const contract = b.contracts[chain]
  if (!b.enabled || !b.minterKey || !contract) return null
  let c = built.get(chain)
  if (!c) {
    c = createBeatChainClient({ chain, rpcUrl: b.rpc[chain], contract, minterKey: b.minterKey })
    built.set(chain, c)
  }
  return c
}

const CONTRACT_ENV: Record<BeatChain, string> = { 'polygon-amoy': 'BEAT_CONTRACT_POLYGON_AMOY', polygon: 'BEAT_CONTRACT_POLYGON' }

/** The settings a chain still needs before it can mint (empty when it has a client): its contract, the minter key. */
export function beatChainMissing(chain: BeatChain): string[] {
  if (overrides.has(chain)) return []
  const b = config.beats
  return [...(b.contracts[chain] ? [] : [CONTRACT_ENV[chain]]), ...(b.minterKey ? [] : ['BEAT_MINTER_KEY'])]
}

/** Tests put a fake in for a chain; null removes it and forgets the built client, so the next call reads config again. */
export function setBeatChainClientForTests(chain: BeatChain, client: BeatChainClient | null): void {
  built.delete(chain)
  if (client) overrides.set(chain, client)
  else overrides.delete(chain)
}
