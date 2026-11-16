import { BEAT_GAS_PER_RECIPIENT } from '../src/beats/abi.js'
import { describe, it, expect, afterEach } from 'vitest'
import { inspect } from 'node:util'
import { Wallet, ZeroAddress, getAddress, keccak256 } from 'ethers'
import { config } from '../src/config.js'
import {
  BEAT_MIN_PRIORITY_FEE_WEI, BeatRevert, BeatRpcError, beatChainClient, beatChainClientOn, setBeatChainClientForTests,
} from '../src/beats/chain.js'
import { fakeBeatChain } from './helpers/fake-beat-chain.js'

const CONTRACT = getAddress('0x01d871870cbbdde934526e17637c0cfef0b3b38b')
const saved = { ...config.beats, contracts: { ...config.beats.contracts } }
const setBeats = (b: Partial<typeof config.beats>) => Object.assign(config.beats, b)

afterEach(() => {
  Object.assign(config.beats, saved, { contracts: { ...saved.contracts } })
  setBeatChainClientForTests('polygon-amoy', null)
  setBeatChainClientForTests('polygon', null)
})

describe('beatChainClient', () => {
  it('is null when BEATs are off, without a key, or without a contract for the chain', () => {
    const key = Wallet.createRandom().privateKey
    setBeats({ enabled: false, minterKey: key, contracts: { 'polygon-amoy': CONTRACT } })
    expect(beatChainClient('polygon-amoy')).toBeNull()
    setBeats({ enabled: true, minterKey: null, contracts: { 'polygon-amoy': CONTRACT } })
    expect(beatChainClient('polygon-amoy')).toBeNull()
    setBeats({ enabled: true, minterKey: key, contracts: { 'polygon-amoy': CONTRACT } })
    expect(beatChainClient('polygon')).toBeNull()
    expect(beatChainClient('polygon-amoy')).not.toBeNull()
  })

  it('derives the minter address from the key and never exposes the key', () => {
    const w = Wallet.createRandom()
    setBeats({ enabled: true, minterKey: w.privateKey, contracts: { 'polygon-amoy': CONTRACT } })
    const c = beatChainClient('polygon-amoy')!
    expect(c.minterAddress).toBe(w.address)
    expect(c.chain).toBe('polygon-amoy')
    const hex = w.privateKey.slice(2).toLowerCase()
    expect(JSON.stringify(c).toLowerCase()).not.toContain(hex)
    expect(inspect(c, { depth: 10, showHidden: true }).toLowerCase()).not.toContain(hex)
    expect(Object.values(c).map(String).join(' ').toLowerCase()).not.toContain(hex)
  })

  it('is built once per chain, and tests can replace it', () => {
    setBeats({ enabled: true, minterKey: Wallet.createRandom().privateKey, contracts: { 'polygon-amoy': CONTRACT } })
    expect(beatChainClient('polygon-amoy')).toBe(beatChainClient('polygon-amoy'))
    const fake = fakeBeatChain()
    setBeatChainClientForTests('polygon-amoy', fake)
    expect(beatChainClient('polygon-amoy')).toBe(fake)
  })

  it('signs offline with explicit fees and gas, and the hash is keccak256(raw)', async () => {
    setBeats({ enabled: true, minterKey: Wallet.createRandom().privateKey, contracts: { 'polygon-amoy': CONTRACT } })
    const c = beatChainClient('polygon-amoy')!
    const fees = { maxFeePerGas: 50n * 10n ** 9n, maxPriorityFeePerGas: 30n * 10n ** 9n }
    const s = await c.sign({ kind: 'create', tokenId: 7n, tradeable: false }, 3, fees, 100_000n)
    expect(s.hash).toBe(keccak256(s.raw))
    expect(s.fees).toEqual(fees)
    expect(s.gasLimit).toBe(100_000n)
  })
})

const GWEI = 10n ** 9n

/** A stand-in for the ethers provider: only the methods a test needs, counting estimateGas calls. */
function stubProvider(over: Record<string, (...a: any[]) => any> = {}) {
  const calls = { estimateGas: 0 }
  const p: any = {
    estimateGas: async () => { calls.estimateGas++; return 90_000n },
    getFeeData: async () => ({ gasPrice: 31n * GWEI, maxFeePerGas: 3n * GWEI, maxPriorityFeePerGas: 1n * GWEI }),
    getBlock: async () => ({ baseFeePerGas: 1n * GWEI }),
    broadcastTransaction: async () => ({}),
    getTransaction: async () => null,
    ...over,
  }
  return { p, calls }
}
const rpcError = (code: string, message: string) => Object.assign(new Error(message), { code, info: { error: { message } } })

describe('the gas budget (contracts/test/Budget.t.sol proves it on the real contract)', () => {
  it('BEAT_GAS_PER_RECIPIENT is RECEIVER_GAS * 64/63 + GUARD_RESERVE, the PER the forge test pins', () => {
    expect(BEAT_GAS_PER_RECIPIENT).toBe(131_904n)
  })
})

describe('the RPC client against a stub provider', () => {
  const key = Wallet.createRandom().privateKey

  it('floors the default tip at 30 gwei and lifts maxFee to 2 × base + tip; explicit fees are used as given', async () => {
    const { p } = stubProvider()
    const c = beatChainClientOn('polygon', p, CONTRACT, key)
    const s = await c.sign({ kind: 'close', tokenId: 1n }, 0)
    expect(s.fees.maxPriorityFeePerGas).toBe(BEAT_MIN_PRIORITY_FEE_WEI)
    expect(s.fees.maxFeePerGas).toBe(2n * GWEI + BEAT_MIN_PRIORITY_FEE_WEI)
    const low = { maxFeePerGas: 2n * GWEI, maxPriorityFeePerGas: 1n * GWEI }
    expect((await c.sign({ kind: 'close', tokenId: 1n }, 0, low)).fees).toEqual(low)
    // A node asking for more than the floor wins
    const { p: high } = stubProvider({ getFeeData: async () => ({ gasPrice: null, maxFeePerGas: 500n * GWEI, maxPriorityFeePerGas: 40n * GWEI }) })
    const h = await beatChainClientOn('polygon', high, CONTRACT, key).sign({ kind: 'close', tokenId: 1n }, 0)
    expect(h.fees).toEqual({ maxFeePerGas: 500n * GWEI, maxPriorityFeePerGas: 40n * GWEI })
  })

  it('returns the gas limit it used, and a replacement signed with it never re-estimates', async () => {
    const { p, calls } = stubProvider()
    const c = beatChainClientOn('polygon-amoy', p, CONTRACT, key)
    const call = { kind: 'mint' as const, tokenId: 1n, wallets: [Wallet.createRandom().address] }
    const first = await c.sign(call, 4)
    expect(first.gasLimit).toBe(90_000n)
    expect(calls.estimateGas).toBe(1)
    const bumped = { maxFeePerGas: first.fees.maxFeePerGas * 2n, maxPriorityFeePerGas: first.fees.maxPriorityFeePerGas * 2n }
    const again = await c.sign(call, 4, bumped, first.gasLimit)
    expect(calls.estimateGas).toBe(1)
    expect(again.gasLimit).toBe(90_000n)
    expect(again.hash).not.toBe(first.hash)
  })

  it('treats "already known" as sent, and "nonce too low" as sent only when the node has this exact tx', async () => {
    const signer = beatChainClientOn('polygon-amoy', stubProvider().p, CONTRACT, key)
    const s = await signer.sign({ kind: 'close', tokenId: 1n }, 0, { maxFeePerGas: 50n * GWEI, maxPriorityFeePerGas: 30n * GWEI }, 60_000n)

    const known = stubProvider({ broadcastTransaction: async () => { throw rpcError('UNKNOWN_ERROR', 'already known') } })
    await expect(beatChainClientOn('polygon-amoy', known.p, CONTRACT, key).broadcast(s.raw)).resolves.toBeUndefined()

    const tooLow = (found: unknown) => stubProvider({
      broadcastTransaction: async () => { throw rpcError('NONCE_EXPIRED', 'nonce too low') },
      getTransaction: async () => found,
    }).p
    await expect(beatChainClientOn('polygon-amoy', tooLow({ hash: s.hash }), CONTRACT, key).broadcast(s.raw)).resolves.toBeUndefined()
    await expect(beatChainClientOn('polygon-amoy', tooLow(null), CONTRACT, key).broadcast(s.raw))
      .rejects.toMatchObject({ name: 'BeatRpcError', code: 'NONCE_EXPIRED' })
    await expect(beatChainClientOn('polygon-amoy', tooLow({ hash: '0x' + '11'.repeat(32) }), CONTRACT, key).broadcast(s.raw))
      .rejects.toMatchObject({ code: 'NONCE_EXPIRED' })

    const other = stubProvider({ broadcastTransaction: async () => { throw rpcError('UNKNOWN_ERROR', 'boom 0xdeadbeef') } })
    const err = await beatChainClientOn('polygon-amoy', other.p, CONTRACT, key).broadcast(s.raw).catch((e) => e)
    expect(err).toBeInstanceOf(BeatRpcError)
    expect(err.message).not.toContain('deadbeef')
  })

  it('fix round I-1: a broadcast error is "down" only for transport failures; a JSON-RPC refusal never is', async () => {
    const signer = beatChainClientOn('polygon-amoy', stubProvider().p, CONTRACT, key)
    const s = await signer.sign({ kind: 'close', tokenId: 1n }, 0, { maxFeePerGas: 1n, maxPriorityFeePerGas: 1n }, 50_000n)
    const fail = async (e: unknown) => beatChainClientOn('polygon-amoy', stubProvider({ broadcastTransaction: async () => { throw e } }).p, CONTRACT, key)
      .broadcast(s.raw).catch((x) => x as BeatRpcError)
    const bare = (code: string, extra: Record<string, unknown> = {}) => Object.assign(new Error('x'), { code, ...extra })
    // Transport: no JSON-RPC error body
    expect((await fail(bare('NETWORK_ERROR'))).down).toBe(true)
    expect((await fail(bare('TIMEOUT'))).down).toBe(true)
    expect((await fail(bare('SERVER_ERROR', { info: { responseStatus: '503 Service Unavailable' } }))).down).toBe(true)
    // Refusals: the node answered with an error
    const refused = [
      rpcError('UNKNOWN_ERROR', 'tx fee (10.07 ether) exceeds the configured cap (1.00 ether)'),
      rpcError('UNKNOWN_ERROR', 'transaction underpriced'),
      rpcError('UNKNOWN_ERROR', 'exceeds block gas limit'),
      rpcError('UNKNOWN_ERROR', 'max fee per gas less than block base fee'),
      rpcError('SERVER_ERROR', 'intrinsic gas too low'),
      bare('UNKNOWN_ERROR', { error: { code: -32000, message: 'some refusal' } }),
    ]
    for (const e of refused) {
      const got = await fail(e)
      expect([got.code, got.down], (e as Error).message).toEqual([(e as { code: string }).code, false])
    }
  })

  it('reports a broadcast refused for lack of funds as INSUFFICIENT_FUNDS, by ethers code or by the node message', async () => {
    const signer = beatChainClientOn('polygon-amoy', stubProvider().p, CONTRACT, key)
    const s = await signer.sign({ kind: 'close', tokenId: 1n }, 0, { maxFeePerGas: 50n * GWEI, maxPriorityFeePerGas: 30n * GWEI }, 60_000n)
    for (const [code, message] of [['INSUFFICIENT_FUNDS', 'insufficient funds'], ['UNKNOWN_ERROR', 'insufficient funds for gas * price + value: balance 0'], ['SERVER_ERROR', 'Insufficient funds for gas']]) {
      const p = stubProvider({ broadcastTransaction: async () => { throw rpcError(code, message) } }).p
      const err = await beatChainClientOn('polygon-amoy', p, CONTRACT, key).broadcast(s.raw).catch((e) => e)
      expect(err, message).toMatchObject({ name: 'BeatRpcError', code: 'INSUFFICIENT_FUNDS' })
      expect(err.message).not.toContain('balance 0')
    }
  })

  it('throws a payload-free BeatRpcError for a malformed wallet in a mint', async () => {
    const c = beatChainClientOn('polygon-amoy', stubProvider().p, CONTRACT, key)
    const bad = '0x' + 'ab'.repeat(19) + 'zz'
    for (const attempt of [
      () => c.estimate({ kind: 'mint', tokenId: 1n, wallets: [bad] }),
      () => c.sign({ kind: 'mint', tokenId: 1n, wallets: [bad] }, 0, { maxFeePerGas: 1n, maxPriorityFeePerGas: 1n }, 1n),
      () => c.isMinted(1n, bad),
    ]) {
      const err = await attempt().catch((e) => e)
      expect(err).toBeInstanceOf(BeatRpcError)
      expect(err.op).toBe('encode')
      expect(err.message).not.toContain(bad.slice(2, 20))
      expect(JSON.stringify(err)).not.toContain(bad.slice(2, 20))
    }
  })
})

describe('fakeBeatChain', () => {
  const A = Wallet.createRandom().address
  const B = Wallet.createRandom().address
  const C = Wallet.createRandom().address

  it('signs with hash = keccak256(raw), and a re-broadcast of a known tx resolves', async () => {
    const f = fakeBeatChain()
    const s = await f.sign({ kind: 'create', tokenId: 1n, tradeable: true }, 0)
    expect(s.hash).toBe(keccak256(s.raw))
    await f.broadcast(s.raw)
    await expect(f.broadcast(s.raw)).resolves.toBeUndefined() // already known
    f.mine()
    await expect(f.broadcast(s.raw)).resolves.toBeUndefined() // nonce too low, same hash
    expect(await f.exists(1n)).toBe(true)
    expect(f.isTradeable(1n)).toBe(true)
  })

  it('tracks latest and pending nonces and mines in nonce order', async () => {
    const f = fakeBeatChain()
    f.createdBeat(5n)
    const a = await f.sign({ kind: 'mint', tokenId: 5n, wallets: [A] }, 0)
    const b = await f.sign({ kind: 'mint', tokenId: 5n, wallets: [B] }, 1)
    await f.broadcast(b.raw)
    expect(await f.nonce('pending')).toBe(0) // a gap: nonce 0 is missing
    await f.broadcast(a.raw)
    expect(await f.nonce('latest')).toBe(0)
    expect(await f.nonce('pending')).toBe(2)
    expect(await f.receipt(a.hash)).toBeNull()
    f.mine()
    expect(await f.nonce('latest')).toBe(2)
    expect(await f.receipt(a.hash)).toMatchObject({ ok: true, blockNumber: 101 })
    expect(await f.isMinted(5n, A)).toBe(true)
    expect(await f.isMinted(5n, B)).toBe(true)
    expect(await f.latestBlock()).toBe(101)
  })

  it('rejects a different tx at a used nonce, and replaces a pending one only with 10% higher fees', async () => {
    const f = fakeBeatChain()
    f.createdBeat(5n)
    const call = { kind: 'mint' as const, tokenId: 5n, wallets: [A] }
    const fees = { maxFeePerGas: 100n, maxPriorityFeePerGas: 50n }
    const first = await f.sign(call, 0, fees)
    await f.broadcast(first.raw)
    const same = await f.sign(call, 0, { maxFeePerGas: 105n, maxPriorityFeePerGas: 52n })
    await expect(f.broadcast(same.raw)).rejects.toMatchObject({ code: 'REPLACEMENT_UNDERPRICED' })
    const bumped = await f.sign(call, 0, { maxFeePerGas: 125n, maxPriorityFeePerGas: 63n })
    await f.broadcast(bumped.raw)
    expect(f.mempool().map((t) => t.hash)).toEqual([bumped.hash])
    f.mine()
    const late = await f.sign(call, 0, { maxFeePerGas: 200n, maxPriorityFeePerGas: 100n })
    await expect(f.broadcast(late.raw)).rejects.toBeInstanceOf(BeatRpcError)
    await expect(f.broadcast(late.raw)).rejects.toMatchObject({ code: 'NONCE_EXPIRED' })
  })

  it('applies the skip rules and reports MintSkipped for rejecting receivers', async () => {
    const f = fakeBeatChain({ rejectingWallets: [C] })
    f.createdBeat(9n, { minted: [B] })
    expect(await f.codeAt(C)).toBe(true)
    expect(await f.codeAt(A)).toBe(false)
    const s = await f.sign({ kind: 'mint', tokenId: 9n, wallets: [A, A, ZeroAddress, B, C] }, 0)
    await f.broadcast(s.raw)
    f.mine()
    const r = (await f.receipt(s.hash))!
    expect(r.ok).toBe(true)
    expect(f.skippedIn(r.logs)).toEqual([C])
    expect(f.mintedCount(9n)).toBe(2) // B before, A now
    expect(await f.isMinted(9n, C)).toBe(false)
  })

  it('reverts unknown and closed ids, empty batches, and scripted reverts', async () => {
    const f = fakeBeatChain()
    await expect(f.estimate({ kind: 'mint', tokenId: 1n, wallets: [A] })).rejects.toMatchObject({ name: 'UnknownBeat' })
    f.createdBeat(1n, { closed: true })
    await expect(f.estimate({ kind: 'mint', tokenId: 1n, wallets: [A] })).rejects.toMatchObject({ name: 'BeatClosedError' })
    await expect(f.estimate({ kind: 'create', tokenId: 1n, tradeable: false })).rejects.toMatchObject({ name: 'BeatExists' })
    f.createdBeat(2n)
    await expect(f.estimate({ kind: 'mint', tokenId: 2n, wallets: [] })).rejects.toMatchObject({ name: 'BatchTooLarge' })
    f.revertForWallet(B, 'Boom')
    await expect(f.estimate({ kind: 'mint', tokenId: 2n, wallets: [A, B] })).rejects.toBeInstanceOf(BeatRevert)
    f.revertForWallet(B, null)
    f.revertNext('Scripted', { kind: 'mint' })
    // Signing with an explicit gas limit skips the estimate, so the scripted revert hits the mined tx
    const s = await f.sign({ kind: 'mint', tokenId: 2n, wallets: [A] }, 0, undefined, 200_000n)
    await f.broadcast(s.raw)
    f.mine()
    expect(await f.receipt(s.hash)).toMatchObject({ ok: false })
    expect(f.revertReason(s.hash)).toBe('Scripted')
    expect(await f.nonce('latest')).toBe(1)
  })

  it('reverts a mint to a wallet with code when the gas limit is short', async () => {
    const f = fakeBeatChain({ codeWallets: [C] })
    f.createdBeat(3n)
    const call = { kind: 'mint' as const, tokenId: 3n, wallets: [A, C] }
    expect(await f.estimate(call)).toBe(f.gasFor(call))
    const s = await f.sign(call, 0, undefined, f.gasFor(call) - 1n)
    await f.broadcast(s.raw)
    f.mine()
    expect(f.revertReason(s.hash)).toBe('InsufficientGas')
    expect(await f.isMinted(3n, A)).toBe(false)
  })

  it('reverts a short mint with no code wallets as unknown, using its whole gas limit', async () => {
    const f = fakeBeatChain()
    f.createdBeat(3n)
    const call = { kind: 'mint' as const, tokenId: 3n, wallets: [A] }
    const s = await f.sign(call, 0, { maxFeePerGas: 100n * GWEI, maxPriorityFeePerGas: 30n * GWEI }, f.gasFor(call) - 1n)
    await f.broadcast(s.raw)
    f.mine()
    expect(f.revertReason(s.hash)).toBe('unknown')
    expect(f.minedTxs()[0].gasUsed).toBe(f.gasFor(call) - 1n)
  })

  it('refuses a tx the balance cannot cover, and charges gas used at the effective price', async () => {
    const f = fakeBeatChain({ balanceWei: 10n ** 18n, baseFeeWei: 20n * GWEI })
    f.createdBeat(3n)
    const call = { kind: 'mint' as const, tokenId: 3n, wallets: [A] }
    const fees = { maxFeePerGas: 100n * GWEI, maxPriorityFeePerGas: 30n * GWEI }
    const s = await f.sign(call, 0, fees, 1_000_000n)
    f.setBalance(1_000_000n * fees.maxFeePerGas - 1n)
    await expect(f.broadcast(s.raw)).rejects.toMatchObject({ name: 'BeatRpcError', code: 'INSUFFICIENT_FUNDS' })
    f.setBalance(10n ** 18n)
    await f.broadcast(s.raw)
    f.mine()
    expect(f.minedTxs()[0].gasUsed).toBe(f.gasFor(call))
    expect(await f.balanceWei()).toBe(10n ** 18n - f.gasFor(call) * 50n * GWEI)
  })

  it('drops txs, fails broadcasts and goes down on request', async () => {
    const f = fakeBeatChain()
    f.createdBeat(4n)
    const s = await f.sign({ kind: 'close', tokenId: 4n }, 0)
    f.dropNext()
    await f.broadcast(s.raw)
    expect(f.mempool()).toEqual([])
    await f.broadcast(s.raw)
    f.drop(s.hash)
    f.mine(3)
    expect(await f.receipt(s.hash)).toBeNull()
    expect(await f.latestBlock()).toBe(103)
    f.failBroadcast('NETWORK_ERROR')
    await expect(f.broadcast(s.raw)).rejects.toMatchObject({ code: 'NETWORK_ERROR' })
    await f.broadcast(s.raw)
    f.mine()
    expect(f.isClosed(4n)).toBe(true)
    f.setDown(true)
    await expect(f.latestBlock()).rejects.toBeInstanceOf(BeatRpcError)
  })
})
