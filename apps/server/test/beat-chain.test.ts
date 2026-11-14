import { describe, it, expect, afterEach } from 'vitest'
import { inspect } from 'node:util'
import { Wallet, ZeroAddress, getAddress, keccak256 } from 'ethers'
import { config } from '../src/config.js'
import { BeatRevert, BeatRpcError, beatChainClient, setBeatChainClientForTests } from '../src/beats/chain.js'
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
