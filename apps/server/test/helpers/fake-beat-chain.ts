import { Transaction, Wallet, ZeroAddress, getAddress, hexlify, keccak256, randomBytes } from 'ethers'
import type { BeatChain } from '@virvixr/shared'
import { BEAT_CHAIN_INFO } from '@virvixr/shared'
import {
  BeatRevert, BeatRpcError, beatInterface, encodeBeatCall, skippedIn,
  type BeatCall, type BeatChainClient, type BeatFees, type BeatLog, type BeatReceipt, type BeatReissuedLog, type BeatSigned,
} from '../../src/beats/chain.js'

/**
 * An in-memory VirviBeat chain for tests (LIV-11), implementing BeatChainClient. Transactions are really signed (by a
 * random minter wallet unless `minterKey` is given), so hashes are keccak256(raw) and nonces, fees and calldata are
 * decoded from the raw bytes just as a node would.
 *
 * Model:
 * - `broadcast` puts a tx in the mempool; nothing is mined until `mine(n)`. `nonce('latest')` counts mined txs;
 *   `nonce('pending')` also counts mempool txs whose nonces continue on from it.
 * - `mine(n)` mines n blocks. The first block takes every mempool tx whose nonce is next in line; each runs the
 *   contract's rules and gets a receipt (`ok: false` when it reverts; the nonce is used either way).
 * - Contract rules: unknown id → UnknownBeat, closed → BeatClosedError, 0 or >200 wallets → BatchTooLarge, id 0 →
 *   ZeroId, existing id → BeatExists. Mints skip the zero address, wallets already minted and repeats in the list.
 *   Wallets with code that reject (`rejectReceiver`) are skipped with a MintSkipped log and stay un-minted.
 * - Gas: `gasFor(call)` is what `estimate` returns (60k + 35k per plain wallet + 130k per wallet with code). A mined
 *   tx whose gas limit is below that reverts with InsufficientGas when the mint has a wallet with code (the contract's
 *   guard), else with 'unknown' (out of gas), and uses its whole gas limit.
 * - Money: `broadcast` throws INSUFFICIENT_FUNDS when the balance is below gasLimit × maxFeePerGas. Mining charges gas
 *   used × min(maxFeePerGas, baseFee + tip), with baseFee from `baseFeeWei` (default 30 gwei).
 * - Re-broadcasting a tx that's in the mempool or mined resolves (as "already known" / "nonce too low" for the same
 *   hash would). Another tx at a mined nonce throws BeatRpcError NONCE_EXPIRED; one at a pending tx's nonce replaces
 *   it when both fees are at least 10% higher, else throws REPLACEMENT_UNDERPRICED.
 * - `sign` without fees uses `setFees` as given (the real client's tip floor isn't modelled); the result carries the
 *   gas limit used, and passing it back never re-estimates.
 */
export interface FakeBeatChain extends BeatChainClient {
  readonly contract: string
  /** The current block number (starts at 100). */
  readonly block: number
  /** Mines `n` blocks (default 1). */
  mine(n?: number): void
  /** Pending txs, in nonce order. */
  mempool(): FakeTx[]
  /** Every mined tx, oldest first. */
  minedTxs(): FakeMinedTx[]
  /** Removes a pending tx (or all of them) without mining it: its receipt stays null and its nonce is free again. */
  drop(hash?: string): void
  /** The next `n` broadcasts resolve but their txs never reach the mempool. */
  dropNext(n?: number): void
  /** The next `n` broadcasts throw BeatRpcError with this code (default 'NETWORK_ERROR'), and don't reach the mempool.
   * `down` (the RPC unreachable, not refusing) defaults to true for NETWORK_ERROR, TIMEOUT and SERVER_ERROR. */
  failBroadcast(code?: string, n?: number, down?: boolean): void
  /** The next `times` (default 1) estimates and mined txs of this kind (or any kind) revert with `name`. */
  revertNext(name: string, opts?: { kind?: BeatCall['kind']; times?: number }): void
  /** Every mint that includes this wallet reverts with `name` (estimate and mined) until cleared with null. */
  revertForWallet(wallet: string, name: string | null): void
  /** Marks a wallet as having code (or not). */
  setCode(wallet: string, hasCode?: boolean): void
  /** A wallet with code whose receiver hook rejects (on=false makes it accept again). Implies setCode. */
  rejectReceiver(wallet: string, on?: boolean): void
  /** Sets up state directly, as if already on chain. */
  createdBeat(tokenId: bigint, opts?: { tradeable?: boolean; closed?: boolean; minted?: string[] }): void
  isClosed(tokenId: bigint): boolean
  isTradeable(tokenId: bigint): boolean
  mintedCount(tokenId: bigint): number
  /** Why a mined tx reverted, or null. */
  revertReason(hash: string): string | null
  setBalance(wei: bigint): void
  /** What `sign` uses when no fees are passed (the node's fee data). */
  setFees(fees: BeatFees): void
  /** While down, every RPC method throws BeatRpcError NETWORK_ERROR. */
  setDown(down: boolean): void
  gasFor(call: BeatCall): bigint
  /** The chain id the "RPC" answers (default the chain's own). */
  setChainId(id: number): void
  /** Whether the contract address has code (default true). */
  setContractCode(has: boolean): void
  /** Whether the minter holds MINTER_ROLE (default true). */
  setMinterRole(has: boolean): void
  /** The base fee feeData reports and mined txs pay. */
  setBaseFee(wei: bigint): void
  /** The holder moved, sold or burned its copy: its balance of the BEAT becomes 0 (it stays `minted`). */
  moveOut(tokenId: bigint, wallet: string): void
  /**
   * The admin Safe runs `reissue(from, to, ids)`, mined in a new block with the contract's rules, all or nothing
   * (ZeroAddress, SameFromAndTo, BatchTooLarge, UnknownBeat, NotMintedTo, AlreadyReplaced, AlreadyMinted,
   * NothingToReplace). Returns the tx hash, or the revert name.
   */
  reissue(from: string, to: string, ids: bigint[]): { hash: string } | { reason: string }
  /** Every replacedBy read of this id throws BeatRpcError (null clears it). */
  failReplacedBy(tokenId: bigint | null): void
}

export type FakeTx = { hash: string; raw: string; nonce: number; call: BeatCall; fees: BeatFees; gasLimit: bigint }
export type FakeMinedTx = FakeTx & { blockNumber: number; ok: boolean; reason: string | null; logs: BeatLog[]; gasUsed: bigint }

export type FakeBeatChainOptions = {
  chain?: BeatChain
  minterKey?: string
  /** The contract address (default FAKE_BEAT_CONTRACT); a second contract on the same chain is another fake. */
  contract?: string
  /** Default 10 POL. */
  balanceWei?: bigint
  /** The base fee mined txs pay (default 30 gwei). */
  baseFeeWei?: bigint
  fees?: BeatFees
  codeWallets?: string[]
  rejectingWallets?: string[]
}

/** The fake chain's default contract, as BEATS_READY configures. */
export const FAKE_BEAT_CONTRACT = getAddress('0x00000000000000000000000000000000000b3a75')
const GWEI = 1_000_000_000n
const lc = (a: string) => a.toLowerCase()

function decodeCall(data: string): BeatCall {
  const tx = beatInterface.parseTransaction({ data })
  if (!tx) throw new Error('fake chain: unknown calldata')
  switch (tx.name) {
    case 'createBeat': return { kind: 'create', tokenId: tx.args[0], tradeable: tx.args[1] }
    case 'mintTo': return { kind: 'mint', tokenId: tx.args[0], wallets: [...tx.args[1]] }
    case 'closeBeat': return { kind: 'close', tokenId: tx.args[0] }
  }
  throw new Error(`fake chain: unsupported call ${tx.name}`)
}

export function fakeBeatChain(opts: FakeBeatChainOptions = {}): FakeBeatChain {
  const chain = opts.chain ?? 'polygon-amoy'
  const CONTRACT = getAddress(opts.contract ?? FAKE_BEAT_CONTRACT)
  const wallet = opts.minterKey ? new Wallet(opts.minterKey) : Wallet.createRandom()
  let block = 100
  let balance = opts.balanceWei ?? 10n * 10n ** 18n
  let fees: BeatFees = opts.fees ?? { maxFeePerGas: 60n * GWEI, maxPriorityFeePerGas: 30n * GWEI }
  let baseFee = opts.baseFeeWei ?? 30n * GWEI
  let chainIdNow = BEAT_CHAIN_INFO[chain].chainId
  let contractCode = true
  let minterRole = true
  let down = false
  let minedNonce = 0
  const beats = new Map<string, { tradeable: boolean; closed: boolean; minted: Set<string> }>()
  const code = new Set<string>()
  const rejecting = new Set<string>()
  const pool = new Map<number, FakeTx>() // by nonce
  const mined = new Map<string, FakeMinedTx>()
  const scripted: { name: string; kind?: BeatCall['kind']; times: number }[] = []
  const walletReverts = new Map<string, string>()
  const balances = new Map<string, bigint>() // `${id}:${wallet}`
  const replaced = new Map<string, { to: string; block: number }>() // `${id}:${from}`
  const reissueLogs: Array<{ tokenId: bigint; from: string; to: string; txHash: string; blockNumber: number }> = []
  const bkey = (id: bigint, w: string) => `${id}:${lc(w)}`
  const failingReads = new Set<string>()
  let dropCount = 0
  let failures: { code: string; down: boolean }[] = []

  for (const w of opts.codeWallets ?? []) code.add(lc(w))
  for (const w of opts.rejectingWallets ?? []) { code.add(lc(w)); rejecting.add(lc(w)) }

  const up = (op: string) => { if (down) throw new BeatRpcError(op, 'NETWORK_ERROR') }

  function gasFor(call: BeatCall): bigint {
    if (call.kind !== 'mint') return 60_000n
    let g = 60_000n
    for (const w of call.wallets) g += code.has(lc(w)) ? 130_000n : 35_000n
    return g
  }

  /** Runs the call against state; returns the revert name, or applies it (when `apply`) and returns its logs. */
  function run(call: BeatCall, apply: boolean, gasLimit?: bigint): { reason: string; outOfGas?: boolean } | { logs: BeatLog[] } {
    const i = scripted.findIndex((s) => !s.kind || s.kind === call.kind)
    if (i >= 0) {
      const s = scripted[i]
      if (--s.times <= 0) scripted.splice(i, 1)
      return { reason: s.name }
    }
    const key = call.tokenId.toString()
    const beat = beats.get(key)
    if (call.kind === 'create') {
      if (call.tokenId === 0n) return { reason: 'ZeroId' }
      if (beat) return { reason: 'BeatExists' }
      if (apply) beats.set(key, { tradeable: call.tradeable, closed: false, minted: new Set() })
      return { logs: [] }
    }
    if (!beat) return { reason: 'UnknownBeat' }
    if (beat.closed) return { reason: 'BeatClosedError' }
    if (call.kind === 'close') {
      if (apply) beat.closed = true
      return { logs: [] }
    }
    if (call.wallets.length === 0 || call.wallets.length > 200) return { reason: 'BatchTooLarge' }
    for (const w of call.wallets) {
      const r = walletReverts.get(lc(w))
      if (r) return { reason: r }
    }
    if (gasLimit !== undefined && gasLimit < gasFor(call)) {
      return { reason: call.wallets.some((w) => code.has(lc(w))) ? 'InsufficientGas' : 'unknown', outOfGas: true }
    }
    const logs: BeatLog[] = []
    const minting = new Set<string>()
    for (const w of call.wallets) {
      const a = lc(w)
      if (a === lc(ZeroAddress) || beat.minted.has(a) || minting.has(a)) continue
      if (rejecting.has(a)) {
        const l = beatInterface.encodeEventLog('MintSkipped', [call.tokenId, getAddress(w)])
        logs.push({ address: CONTRACT, topics: l.topics, data: l.data })
        continue
      }
      minting.add(a)
    }
    if (apply) for (const a of minting) { beat.minted.add(a); balances.set(bkey(call.tokenId, a), (balances.get(bkey(call.tokenId, a)) ?? 0n) + 1n) }
    return { logs }
  }

  function pendingNonce(): number {
    let n = minedNonce
    while (pool.has(n)) n++
    return n
  }

  function mineOne() {
    block++
    for (let n = minedNonce; pool.has(n); n = minedNonce) {
      const tx = pool.get(n)!
      pool.delete(n)
      minedNonce++
      const out = run(tx.call, true, tx.gasLimit)
      const ok = 'logs' in out
      const gasUsed = !ok && out.outOfGas ? tx.gasLimit : gasFor(tx.call) < tx.gasLimit ? gasFor(tx.call) : tx.gasLimit
      const paid = baseFee + tx.fees.maxPriorityFeePerGas
      balance -= gasUsed * (paid < tx.fees.maxFeePerGas ? paid : tx.fees.maxFeePerGas)
      mined.set(tx.hash, { ...tx, blockNumber: block, ok, reason: ok ? null : out.reason, logs: ok ? out.logs : [], gasUsed })
    }
  }

  const fake: FakeBeatChain = {
    chain,
    minterAddress: wallet.address,
    contract: CONTRACT,
    get block() { return block },

    async balanceWei() { up('balance'); return balance },
    async nonce(tag) { up('nonce'); return tag === 'latest' ? minedNonce : pendingNonce() },
    async codeAt(address) { up('code'); return code.has(lc(address)) },
    async latestBlock() { up('block'); return block },
    async isMinted(tokenId, w) { up('minted'); return beats.get(tokenId.toString())?.minted.has(lc(w)) ?? false },
    async exists(tokenId) { up('exists'); return beats.has(tokenId.toString()) },
    skippedIn(logs) { return skippedIn(CONTRACT, logs) },
    async feeData() { up('fees'); return { ...fees, baseFeePerGas: baseFee } },
    async chainId() { up('chain_id'); return chainIdNow },
    async contractHasCode() { up('code'); return contractCode },
    async minterHasRole() { up('hasRole'); return minterRole },
    async balanceOf(w, tokenId) { up('balanceOf'); return balances.get(bkey(tokenId, w)) ?? 0n },
    async replacedBy(tokenId, w, tag) {
      up('replacedBy')
      if (failingReads.has(tokenId.toString())) throw new BeatRpcError('replacedBy', 'SERVER_ERROR')
      const r = replaced.get(bkey(tokenId, w))
      return r && r.block <= (tag ?? block) ? getAddress(r.to) : null
    },
    async reissuedLogs(from, to, fromBlock, toBlock): Promise<BeatReissuedLog[]> {
      up('logs')
      return reissueLogs.filter((l) => l.from === lc(from) && l.to === lc(to) && l.blockNumber >= fromBlock && l.blockNumber <= toBlock)
        .map((l) => ({ tokenId: l.tokenId, txHash: l.txHash, blockNumber: l.blockNumber }))
    },

    async estimate(call) {
      up('estimate')
      const out = run(call, false)
      if ('reason' in out) throw new BeatRevert(out.reason)
      return gasFor(call)
    },

    async sign(call, nonce, f, gasLimit): Promise<BeatSigned> {
      const raw0 = f ?? (up('fees'), fees)
      const use = { maxFeePerGas: raw0.maxFeePerGas, maxPriorityFeePerGas: raw0.maxPriorityFeePerGas }
      const gas = gasLimit ?? await fake.estimate(call)
      const raw = await wallet.signTransaction({
        type: 2, chainId: BigInt(BEAT_CHAIN_INFO[chain].chainId), to: CONTRACT, data: encodeBeatCall(call), nonce,
        gasLimit: gas, maxFeePerGas: use.maxFeePerGas, maxPriorityFeePerGas: use.maxPriorityFeePerGas, value: 0n,
      })
      return { raw, hash: keccak256(raw), fees: use, gasLimit: gas }
    },

    async broadcast(raw) {
      up('broadcast')
      if (failures.length) { const f = failures.shift()!; throw new BeatRpcError('broadcast', f.code, f.down) }
      const t = Transaction.from(raw)
      const hash = t.hash!
      if (mined.has(hash) || [...pool.values()].some((p) => p.hash === hash)) return
      if (dropCount > 0) { dropCount--; return }
      if (t.nonce < minedNonce) throw new BeatRpcError('broadcast', 'NONCE_EXPIRED')
      if (balance < t.gasLimit * t.maxFeePerGas!) throw new BeatRpcError('broadcast', 'INSUFFICIENT_FUNDS')
      const tx: FakeTx = {
        hash, raw, nonce: t.nonce, call: decodeCall(t.data), gasLimit: t.gasLimit,
        fees: { maxFeePerGas: t.maxFeePerGas!, maxPriorityFeePerGas: t.maxPriorityFeePerGas! },
      }
      const old = pool.get(t.nonce)
      if (old) {
        const bumped = (a: bigint, b: bigint) => a * 10n >= b * 11n
        if (!bumped(tx.fees.maxFeePerGas, old.fees.maxFeePerGas) || !bumped(tx.fees.maxPriorityFeePerGas, old.fees.maxPriorityFeePerGas)) {
          throw new BeatRpcError('broadcast', 'REPLACEMENT_UNDERPRICED')
        }
      }
      pool.set(t.nonce, tx)
    },

    async receipt(hash): Promise<BeatReceipt | null> {
      up('receipt')
      const m = mined.get(hash)
      return m ? { ok: m.ok, blockNumber: m.blockNumber, logs: m.logs } : null
    },

    mine(n = 1) { for (let i = 0; i < n; i++) mineOne() },
    mempool() { return [...pool.values()].sort((a, b) => a.nonce - b.nonce) },
    minedTxs() { return [...mined.values()] },
    drop(hash) {
      for (const [n, tx] of pool) if (!hash || tx.hash === hash) pool.delete(n)
    },
    dropNext(n = 1) { dropCount += n },
    failBroadcast(c = 'NETWORK_ERROR', n = 1, down = ['NETWORK_ERROR', 'TIMEOUT', 'SERVER_ERROR'].includes(c)) {
      failures = [...failures, ...Array.from({ length: n }, () => ({ code: c, down }))]
    },
    revertNext(name, o = {}) { scripted.push({ name, kind: o.kind, times: o.times ?? 1 }) },
    revertForWallet(w, name) { if (name) walletReverts.set(lc(w), name); else walletReverts.delete(lc(w)) },
    setCode(w, has = true) { if (has) code.add(lc(w)); else { code.delete(lc(w)); rejecting.delete(lc(w)) } },
    rejectReceiver(w, on = true) { if (on) { code.add(lc(w)); rejecting.add(lc(w)) } else rejecting.delete(lc(w)) },
    createdBeat(tokenId, o = {}) {
      beats.set(tokenId.toString(), { tradeable: o.tradeable ?? false, closed: o.closed ?? false, minted: new Set((o.minted ?? []).map(lc)) })
      for (const w of o.minted ?? []) balances.set(bkey(tokenId, w), 1n)
    },
    moveOut(tokenId, w) { balances.set(bkey(tokenId, w), 0n) },
    failReplacedBy(tokenId) { if (tokenId === null) failingReads.clear(); else failingReads.add(tokenId.toString()) },
    reissue(from, to, ids) {
      const f = lc(from)
      const t = lc(to)
      if (f === lc(ZeroAddress) || t === lc(ZeroAddress)) return { reason: 'ZeroAddress' }
      if (f === t) return { reason: 'SameFromAndTo' }
      if (ids.length === 0 || ids.length > 200) return { reason: 'BatchTooLarge' }
      const seen = new Set<string>()
      for (const id of ids) {
        const beat = beats.get(id.toString())
        if (!beat) return { reason: 'UnknownBeat' }
        if (!beat.minted.has(f)) return { reason: 'NotMintedTo' }
        if (replaced.has(bkey(id, f)) || seen.has(id.toString())) return { reason: 'AlreadyReplaced' }
        if (beat.minted.has(t)) return { reason: 'AlreadyMinted' }
        if (beat.tradeable && (balances.get(bkey(id, f)) ?? 0n) === 0n) return { reason: 'NothingToReplace' }
        seen.add(id.toString())
      }
      block++
      const hash = hexlify(randomBytes(32))
      for (const id of ids) {
        const beat = beats.get(id.toString())!
        replaced.set(bkey(id, f), { to: t, block })
        beat.minted.add(t)
        balances.set(bkey(id, t), (balances.get(bkey(id, t)) ?? 0n) + 1n)
        reissueLogs.push({ tokenId: id, from: f, to: t, txHash: hash, blockNumber: block })
      }
      return { hash }
    },
    isClosed(tokenId) { return beats.get(tokenId.toString())?.closed ?? false },
    isTradeable(tokenId) { return beats.get(tokenId.toString())?.tradeable ?? false },
    mintedCount(tokenId) { return beats.get(tokenId.toString())?.minted.size ?? 0 },
    revertReason(hash) { return mined.get(hash)?.reason ?? null },
    setBalance(wei) { balance = wei },
    setFees(f) { fees = f },
    setDown(d) { down = d },
    gasFor,
    setChainId(id) { chainIdNow = id },
    setContractCode(has) { contractCode = has },
    setMinterRole(has) { minterRole = has },
    setBaseFee(wei) { baseFee = wei },
  }
  return fake
}
