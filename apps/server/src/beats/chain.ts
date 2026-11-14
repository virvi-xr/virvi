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
export type BeatSigned = { raw: string; hash: string; fees: BeatFees }

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
  /** Signs the call at this nonce. Fees default to the node's fee data; the gas limit defaults to `estimate(call)`. */
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

export function encodeBeatCall(call: BeatCall): string {
  switch (call.kind) {
    case 'create': return beatInterface.encodeFunctionData('createBeat', [call.tokenId, call.tradeable])
    case 'mint': return beatInterface.encodeFunctionData('mintTo', [call.tokenId, call.wallets])
    case 'close': return beatInterface.encodeFunctionData('closeBeat', [call.tokenId])
  }
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

const codeOf = (err: any) => (typeof err?.code === 'string' ? err.code : 'UNKNOWN_ERROR')

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
      throw new BeatRpcError(op, codeOf(err))
    }
  }

  async #view(fn: string, args: unknown[]): Promise<any> {
    const data = beatInterface.encodeFunctionData(fn, args)
    const out = await this.#rpc(fn, () => this.#provider.call({ to: this.#contract, data }))
    return beatInterface.decodeFunctionResult(fn, out)[0]
  }

  balanceWei() { return this.#rpc('balance', () => this.#provider.getBalance(this.minterAddress)) }
  // Raw requests for nonces, the block number and the tx lookup in broadcast: ethers caches identical provider reads
  // (and the block number) briefly, which would hand back a stale value right after a transaction lands.
  async nonce(tag: 'latest' | 'pending') {
    return Number(await this.#rpc('nonce', () => this.#provider.send('eth_getTransactionCount', [this.minterAddress, tag])))
  }
  async codeAt(address: string) { return (await this.#rpc('code', () => this.#provider.getCode(address))) !== '0x' }
  async latestBlock() { return Number(await this.#rpc('block', () => this.#provider.send('eth_blockNumber', []))) }
  async isMinted(tokenId: bigint, wallet: string) { return Boolean(await this.#view('minted', [tokenId, wallet])) }
  async exists(tokenId: bigint) { return Boolean(await this.#view('exists', [tokenId])) }
  skippedIn(logs: BeatLog[]) { return skippedIn(this.#contract, logs) }

  async estimate(call: BeatCall): Promise<bigint> {
    try {
      return await this.#provider.estimateGas({ from: this.minterAddress, to: this.#contract, data: encodeBeatCall(call) })
    } catch (err: any) {
      if (codeOf(err) === 'CALL_EXCEPTION') throw new BeatRevert(revertName(revertData(err)))
      throw new BeatRpcError('estimate', codeOf(err))
    }
  }

  async sign(call: BeatCall, nonce: number, fees?: BeatFees, gasLimit?: bigint): Promise<BeatSigned> {
    const f = fees ?? await this.#feeData()
    const gas = gasLimit ?? await this.estimate(call)
    const raw = await this.#wallet.signTransaction({
      type: 2, chainId: BigInt(BEAT_CHAIN_INFO[this.chain].chainId), to: this.#contract, data: encodeBeatCall(call),
      nonce, gasLimit: gas, maxFeePerGas: f.maxFeePerGas, maxPriorityFeePerGas: f.maxPriorityFeePerGas, value: 0n,
    })
    return { raw, hash: keccak256(raw), fees: f }
  }

  async #feeData(): Promise<BeatFees> {
    const d = await this.#rpc('fees', () => this.#provider.getFeeData())
    const maxFeePerGas = d.maxFeePerGas ?? d.gasPrice
    const maxPriorityFeePerGas = d.maxPriorityFeePerGas ?? d.gasPrice
    if (maxFeePerGas == null || maxPriorityFeePerGas == null) throw new BeatRpcError('fees', 'MISSING_FEE_DATA')
    return { maxFeePerGas, maxPriorityFeePerGas }
  }

  async broadcast(raw: string): Promise<void> {
    try {
      await this.#provider.broadcastTransaction(raw)
    } catch (err) {
      const code = codeOf(err)
      if (/already known|known transaction|already imported/i.test(rpcMessage(err))) return
      if (code === 'NONCE_EXPIRED') {
        const mine = await this.#rpc('broadcast', () => this.#provider.send('eth_getTransactionByHash', [keccak256(raw)]))
        if (mine) return
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

/** A client for any RPC endpoint and contract (the anvil test uses this; the server uses beatChainClient). */
export function createBeatChainClient(opts: { chain: BeatChain; rpcUrl: string; contract: string; minterKey: string }): BeatChainClient {
  const provider = new JsonRpcProvider(opts.rpcUrl, Network.from(BEAT_CHAIN_INFO[opts.chain].chainId), { staticNetwork: true })
  return new RpcBeatChain(opts.chain, provider, opts.contract, opts.minterKey)
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

/** Tests put a fake in for a chain; null removes it and forgets the built client, so the next call reads config again. */
export function setBeatChainClientForTests(chain: BeatChain, client: BeatChainClient | null): void {
  built.delete(chain)
  if (client) overrides.set(chain, client)
  else overrides.delete(chain)
}
