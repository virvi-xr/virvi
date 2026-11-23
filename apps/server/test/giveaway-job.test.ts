import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { and, asc, eq } from 'drizzle-orm'
import { Wallet, parseEther } from 'ethers'
import { GIVEAWAY_GAS_PER_ITEM } from '@virvixr/shared'
import { config } from '../src/config.js'
import { db } from '../src/db/connection.js'
import { giveawayClaimMints, giveawayClaims, giveawayItems, giveaways, giveawayTxs, subscriptions } from '../src/db/schema.js'
import { recordJobFailure } from '../src/errors/record.js'
import { GIVEAWAY_TRANSFER_GAS, GiveawayRpcError } from '../src/giveaways/chain.js'
import { newGiveawayWallet } from '../src/giveaways/keys.js'
import { GIVEAWAY_REPLACED_AFTER_BLOCKS, resetGiveawayJobState, runGiveawayJob } from '../src/giveaways/job.js'
import { resetDb } from './helpers/db.js'
import { createUser, type TestUser } from './helpers/factories.js'
import { giveawaysOn, senderOf, type FakeGiveawayChain } from './helpers/giveaways-fake.js'

vi.mock('../src/errors/record.js', async (orig) => ({
  ...(await orig<typeof import('../src/errors/record.js')>()),
  recordJobFailure: vi.fn(),
}))

const MIN = 60_000
const T0 = new Date('2026-12-01T12:00:00Z')
const at = (ms: number) => new Date(T0.getTime() + ms)
const pol = (s: string) => parseEther(s)
const lc = (s: string) => s.toLowerCase()
const addr = () => Wallet.createRandom().address
const C1 = addr()
const C2 = addr()

type GiveawayRow = typeof giveaways.$inferSelect

describe('giveaway minting job (LIV-194)', () => {
  let chain: FakeGiveawayChain
  let off: () => void
  let host: TestUser
  let tank: Wallet
  const prevBilling = config.billingEnabled

  beforeEach(async () => {
    await resetDb()
    resetGiveawayJobState()
    vi.mocked(recordJobFailure).mockClear()
    tank = Wallet.createRandom() as unknown as Wallet
    ;({ chain, off } = giveawaysOn())
    ;(config as any).billingEnabled = true
    host = await createUser({ wallet: addr() })
  })
  afterEach(() => {
    off()
    ;(config as any).billingEnabled = prevBilling
  })

  const withTank = () => { ;(config as any).giveaways = { ...config.giveaways, gasKey: tank.privateKey } }
  const paid = (status: 'active' | 'canceled' = 'active') => db.insert(subscriptions).values({ userId: host.id, tier: 'creator', status })

  /** An enabled Polygon giveaway with its own sealed wallet and these items (contract, item id). */
  async function giveaway(o: { items?: [string, string][]; balance?: bigint; set?: Partial<typeof giveaways.$inferInsert> } = {}) {
    const w = newGiveawayWallet()
    const [g] = await db.insert(giveaways).values({
      ownerId: host.id, name: 'G', chain: 'polygon', enabled: true, walletAddress: w.address, walletKeyEnc: w.keyEnc, ...o.set,
    }).returning()
    for (const [contractAddress, itemId] of o.items ?? [[C1, '1']]) await db.insert(giveawayItems).values({ giveawayId: g.id, contractAddress, itemId })
    chain.setBalance(w.address, o.balance ?? pol('1'))
    return g
  }
  let claimN = 0
  /** A queued claim with one mint row per contract of the giveaway's items. */
  async function claim(g: GiveawayRow, wallet = addr()) {
    const [c] = await db.insert(giveawayClaims).values({
      giveawayId: g.id, wallet: lc(wallet), consentVersion: 1, status: 'waiting', claimedAt: new Date(T0.getTime() - 60 * MIN + claimN++ * 1000),
    }).returning()
    const contracts = new Set((await db.select().from(giveawayItems).where(eq(giveawayItems.giveawayId, g.id))).map((i) => i.contractAddress!))
    for (const contractAddress of contracts) await db.insert(giveawayClaimMints).values({ claimId: c.id, contractAddress })
    return c
  }
  const claimOf = async (id: string) => (await db.select().from(giveawayClaims).where(eq(giveawayClaims.id, id)))[0]
  const mintsOf = (id: string) => db.select().from(giveawayClaimMints).where(eq(giveawayClaimMints.claimId, id)).orderBy(asc(giveawayClaimMints.contractAddress))
  const giveawayOf = async (id: string) => (await db.select().from(giveaways).where(eq(giveaways.id, id)))[0]
  const txs = () => db.select().from(giveawayTxs).orderBy(asc(giveawayTxs.createdAt))
  /** Mines what is pending and adds Polygon's 3 confirmations. */
  const confirm = () => { chain.mine(); chain.advance(3) }

  it('1. happy path: two waiting claims go in one mint and are sent with token ids once it confirms', async () => {
    const g = await giveaway()
    const a = await claim(g), b = await claim(g)
    await runGiveawayJob(T0)
    expect(chain.signs).toHaveLength(1)
    expect(chain.signs[0]).toMatchObject({ kind: 'mint', from: lc(g.walletAddress!), wallets: [a.wallet, b.wallet], itemIds: ['1', '1'] })
    expect(chain.pool.size).toBe(1)
    const [t] = await txs()
    expect(t).toMatchObject({ kind: 'mint', status: 'sent', contractAddress: C1, nonce: 0, covered: false, txHash: chain.signs[0].hash })
    expect((await claimOf(a.id)).status).toBe('minting')
    expect((await mintsOf(a.id))[0]).toMatchObject({ status: 'minting', txId: t.id })

    // Mined but not yet 3 blocks deep: still open
    chain.mine()
    chain.advance(2)
    await runGiveawayJob(at(MIN))
    expect((await claimOf(a.id)).status).toBe('minting')
    chain.advance(1)
    await runGiveawayJob(at(2 * MIN))
    const [done] = await txs()
    expect(done).toMatchObject({ status: 'confirmed', feeWei: (chain.signs[0].gasLimit * chain.gasPriceWei).toString() })
    for (const c of [a, b]) {
      expect(await claimOf(c.id)).toMatchObject({ status: 'sent', sentAt: at(2 * MIN) })
      expect((await mintsOf(c.id))[0].status).toBe('sent')
    }
    expect((await mintsOf(a.id))[0].tokenIds).toEqual(['1'])
    expect((await mintsOf(b.id))[0].tokenIds).toEqual(['2'])
    // The item's stored supply is refreshed (the visitor open check reads it)
    const [item] = await db.select().from(giveawayItems).where(eq(giveawayItems.giveawayId, g.id))
    expect(item).toMatchObject({ remaining: 98, mintState: 'ready' })
    expect(chain.signs).toHaveLength(1)
  })

  it('2. crash between sign and broadcast: the next pass broadcasts the same raw, signed once', async () => {
    const g = await giveaway()
    const a = await claim(g)
    chain.broadcastError = () => new Error('process died')
    await runGiveawayJob(T0)
    const [t] = await txs()
    expect(t).toMatchObject({ status: 'sending', rawTx: chain.signs[0].raw })
    expect(chain.pool.size).toBe(0)
    chain.broadcastError = null
    await runGiveawayJob(at(MIN))
    expect(chain.signs).toHaveLength(1)
    expect(chain.broadcasts).toEqual([chain.signs[0].raw])
    expect((await txs())[0].status).toBe('sent')
    confirm()
    await runGiveawayJob(at(2 * MIN))
    expect((await claimOf(a.id)).status).toBe('sent')
    expect(chain.signs).toHaveLength(1)
  })

  it('3. not minter: paused not_minter with claims waiting, then minted and unpaused once the minter is back', async () => {
    const g = await giveaway()
    const a = await claim(g)
    chain.setItem(C1, '1', { canMint: false })
    await runGiveawayJob(T0)
    expect(await giveawayOf(g.id)).toMatchObject({ pausedReason: 'not_minter', pausedAt: T0 })
    expect((await claimOf(a.id)).status).toBe('waiting')
    expect(chain.signs).toHaveLength(0)
    chain.setItem(C1, '1', { canMint: true })
    await runGiveawayJob(at(MIN))
    expect(await giveawayOf(g.id)).toMatchObject({ pausedReason: null, pausedAt: null })
    confirm()
    await runGiveawayJob(at(2 * MIN))
    expect((await claimOf(a.id)).status).toBe('sent')
  })

  it('4. sold out: with 1 left and 2 waiting, the first is minted and the second fails sold_out', async () => {
    const g = await giveaway()
    const a = await claim(g), b = await claim(g)
    chain.setItem(C1, '1', { remaining: 1n })
    await runGiveawayJob(T0)
    expect(chain.signs).toHaveLength(1)
    expect(chain.signs[0].wallets).toEqual([a.wallet])
    expect(await claimOf(b.id)).toMatchObject({ status: 'failed', failReason: 'sold_out' })
    expect((await mintsOf(b.id))[0].status).toBe('failed')
    confirm()
    await runGiveawayJob(at(MIN))
    expect((await claimOf(a.id)).status).toBe('sent')
    const [item] = await db.select().from(giveawayItems).where(eq(giveawayItems.giveawayId, g.id))
    expect(item).toMatchObject({ remaining: 0, mintState: 'sold_out' })
  })

  it('5. low gas, free owner: paused low_gas and no tank transaction', async () => {
    withTank()
    chain.setBalance(tank.address, pol('100'))
    const g = await giveaway({ balance: 0n })
    const a = await claim(g)
    await runGiveawayJob(T0)
    expect((await giveawayOf(g.id)).pausedReason).toBe('low_gas')
    expect(await txs()).toHaveLength(0)
    expect(chain.pool.size).toBe(0)
    expect((await claimOf(a.id)).status).toBe('waiting')
    expect((await mintsOf(a.id))[0]).toMatchObject({ status: 'waiting', txId: null })
  })

  it('6. low gas, paid owner: a top-up from the tank, then a covered mint', async () => {
    withTank()
    await paid()
    chain.setBalance(tank.address, pol('100'))
    const g = await giveaway({ balance: 0n })
    const a = await claim(g)
    await runGiveawayJob(T0)
    const [top] = await txs()
    const perClaim = GIVEAWAY_GAS_PER_ITEM * chain.maxFeePerGas
    expect(top).toMatchObject({ kind: 'topup', status: 'sent', fromAddress: tank.address, toAddress: g.walletAddress, valueWei: (perClaim * 50n).toString() })
    // The mint signed to size the gas need was dropped unsent; the top-up is the tank's transfer
    const transfer = chain.signs.find((x) => x.kind === 'transfer')!
    expect(senderOf(transfer.raw)).toBe(lc(tank.address))
    expect(chain.broadcasts).toEqual([transfer.raw])
    expect((await giveawayOf(g.id)).pausedReason).toBeNull()
    expect((await claimOf(a.id)).status).toBe('waiting')
    confirm()
    await runGiveawayJob(at(MIN))
    const mint = (await txs()).find((t) => t.kind === 'mint')
    expect(mint).toMatchObject({ status: 'sent', covered: true })
    expect((await txs()).find((t) => t.kind === 'topup')!.status).toBe('confirmed')
    confirm()
    await runGiveawayJob(at(2 * MIN))
    expect((await claimOf(a.id)).status).toBe('sent')
  })

  it('6b. a top-up is capped at 5 POL', async () => {
    withTank()
    await paid()
    chain.setBalance(tank.address, pol('100'))
    chain.maxFeePerGas = 10_000_000_000_000n // 10,000 gwei: 50 claims' worth is 60 POL
    const g = await giveaway({ balance: 0n })
    await claim(g)
    await runGiveawayJob(T0)
    expect((await txs())[0]).toMatchObject({ kind: 'topup', valueWei: pol('5').toString() })
  })

  it('7. plan lapsed: no top-up, paused low_gas', async () => {
    withTank()
    await paid('canceled')
    chain.setBalance(tank.address, pol('100'))
    const g = await giveaway({ balance: 0n })
    await claim(g)
    await runGiveawayJob(T0)
    expect(await txs()).toHaveLength(0)
    expect((await giveawayOf(g.id)).pausedReason).toBe('low_gas')
  })

  it('8. tank below its floor: no top-up, one job failure an hour, paused low_gas', async () => {
    withTank()
    await paid()
    chain.setBalance(tank.address, config.giveaways.tankMinWeiByChain.polygon + pol('0.1'))
    const g = await giveaway({ balance: 0n })
    await claim(g)
    await runGiveawayJob(T0)
    await runGiveawayJob(at(MIN))
    expect(await txs()).toHaveLength(0)
    expect((await giveawayOf(g.id)).pausedReason).toBe('low_gas')
    const tankLow = () => vi.mocked(recordJobFailure).mock.calls.filter((c) => c[0] === 'giveaway_tank_low')
    expect(tankLow()).toHaveLength(1)
    await runGiveawayJob(at(61 * MIN))
    expect(tankLow()).toHaveLength(2)
  })

  it('9. two contracts: the claim is sent only after both mints confirm', async () => {
    const g = await giveaway({ items: [[C1, '1'], [C2, '7']] })
    const a = await claim(g)
    await runGiveawayJob(T0)
    expect(chain.signs).toHaveLength(1)
    confirm()
    await runGiveawayJob(at(MIN))
    expect(chain.signs).toHaveLength(2)
    expect(new Set(chain.signs.map((s) => lc(s.to)))).toEqual(new Set([lc(C1), lc(C2)]))
    expect(chain.signs[1].nonce).toBe(1)
    expect((await claimOf(a.id)).status).toBe('minting')
    expect((await mintsOf(a.id)).map((m) => m.status).sort()).toEqual(['minting', 'sent'])
    confirm()
    await runGiveawayJob(at(2 * MIN))
    expect((await claimOf(a.id)).status).toBe('sent')
    expect((await mintsOf(a.id)).every((m) => m.status === 'sent' && m.tokenIds?.length === 1)).toBe(true)
  })

  it('10. delete: Virvi unspent 0.5 goes back to the tank, then the giveaway is deleted and its key nulled', async () => {
    withTank()
    const g = await giveaway({ balance: pol('0.5'), set: { enabled: false, deleteState: 'returning' } })
    await db.insert(giveawayTxs).values({
      giveawayId: g.id, chain: 'polygon', kind: 'topup', fromAddress: tank.address, toAddress: g.walletAddress!, status: 'confirmed', valueWei: pol('0.5').toString(),
    })
    const present = (await db.insert(giveawayClaims).values({ giveawayId: g.id, wallet: lc(addr()), consentVersion: 1, status: 'present' }).returning())[0]
    await runGiveawayJob(T0)
    const ret = (await txs()).find((t) => t.kind === 'return')!
    const gas = GIVEAWAY_TRANSFER_GAS * chain.maxFeePerGas
    expect(ret).toMatchObject({ status: 'sent', fromAddress: g.walletAddress, toAddress: tank.address, valueWei: (pol('0.5') - gas).toString() })
    expect(await claimOf(present.id)).toBeUndefined()
    expect((await giveawayOf(g.id)).deletedAt).toBeNull()
    confirm()
    await runGiveawayJob(at(MIN))
    expect(chain.balance(tank.address)).toBe(pol('0.5') - gas)
    const after = await giveawayOf(g.id)
    expect(after.deletedAt).toEqual(at(MIN))
    expect(after.walletKeyEnc).toBeNull()
    expect((await txs()).filter((t) => t.kind === 'return')).toHaveLength(1)
  })

  it('10b. a giveaway past its end with nothing queued returns the float but stays', async () => {
    withTank()
    const g = await giveaway({ balance: pol('2'), set: { endsAt: at(-MIN) } })
    await db.insert(giveawayTxs).values({
      giveawayId: g.id, chain: 'polygon', kind: 'topup', fromAddress: tank.address, toAddress: g.walletAddress!, status: 'confirmed', valueWei: pol('0.5').toString(),
    })
    await runGiveawayJob(T0)
    const gas = GIVEAWAY_TRANSFER_GAS * chain.maxFeePerGas
    expect((await txs()).find((t) => t.kind === 'return')).toMatchObject({ valueWei: (pol('0.5') - gas).toString() })
    confirm()
    await runGiveawayJob(at(MIN))
    await runGiveawayJob(at(2 * MIN))
    expect((await txs()).filter((t) => t.kind === 'return')).toHaveLength(1)
    expect((await giveawayOf(g.id)).deletedAt).toBeNull()
  })

  it('10c. a withdraw queued on a giveaway being deleted is finished first, then the float goes back', async () => {
    withTank()
    const hostWallet = addr()
    const g = await giveaway({ balance: pol('1.5'), set: { enabled: false, deleteState: 'returning' } })
    await db.insert(giveawayTxs).values([
      { giveawayId: g.id, chain: 'polygon', kind: 'topup', fromAddress: tank.address, toAddress: g.walletAddress!, status: 'confirmed', valueWei: pol('0.5').toString() },
      { giveawayId: g.id, chain: 'polygon', kind: 'withdraw', fromAddress: g.walletAddress!, toAddress: hostWallet, status: 'sending', valueWei: pol('0.9').toString() },
    ])
    await runGiveawayJob(T0)
    expect(chain.signs).toHaveLength(1)
    expect(chain.signs[0]).toMatchObject({ kind: 'transfer', valueWei: pol('0.9') })
    confirm()
    await runGiveawayJob(at(MIN))
    expect(chain.signs).toHaveLength(2)
    expect(lc(chain.signs[1].to)).toBe(lc(tank.address))
    confirm()
    await runGiveawayJob(at(2 * MIN))
    expect((await giveawayOf(g.id)).deletedAt).not.toBeNull()
    expect(chain.balance(hostWallet)).toBe(pol('0.9'))
  })

  it('11. withdraw row: signed and broadcast for the amount stored', async () => {
    const hostWallet = addr()
    const g = await giveaway({ balance: pol('1') })
    const [w] = await db.insert(giveawayTxs).values({
      giveawayId: g.id, chain: 'polygon', kind: 'withdraw', fromAddress: g.walletAddress!, toAddress: hostWallet, status: 'sending', valueWei: pol('0.7').toString(),
    }).returning()
    await runGiveawayJob(T0)
    expect(chain.signs).toHaveLength(1)
    expect(chain.signs[0]).toMatchObject({ kind: 'transfer', from: lc(g.walletAddress!), valueWei: pol('0.7'), nonce: 0 })
    expect(lc(chain.signs[0].to)).toBe(lc(hostWallet))
    const [row] = await db.select().from(giveawayTxs).where(eq(giveawayTxs.id, w.id))
    expect(row).toMatchObject({ status: 'sent', rawTx: chain.signs[0].raw, nonce: 0, valueWei: pol('0.7').toString() })
    confirm()
    await runGiveawayJob(at(MIN))
    expect((await db.select().from(giveawayTxs).where(eq(giveawayTxs.id, w.id)))[0].status).toBe('confirmed')
    expect(chain.balance(hostWallet)).toBe(pol('0.7'))
  })

  it('11b. a withdraw that no longer fits beside Virvi float is lowered; one with nothing left fails', async () => {
    const hostWallet = addr()
    const g = await giveaway({ balance: pol('1') })
    await db.insert(giveawayTxs).values({
      giveawayId: g.id, chain: 'polygon', kind: 'topup', fromAddress: addr(), toAddress: g.walletAddress!, status: 'confirmed', valueWei: pol('0.4').toString(),
    })
    const [w] = await db.insert(giveawayTxs).values({
      giveawayId: g.id, chain: 'polygon', kind: 'withdraw', fromAddress: g.walletAddress!, toAddress: hostWallet, status: 'sending', valueWei: pol('0.9').toString(),
    }).returning()
    await runGiveawayJob(T0)
    const fits = pol('1') - pol('0.4') - GIVEAWAY_TRANSFER_GAS * chain.maxFeePerGas
    expect(chain.signs[0].valueWei).toBe(fits)
    expect((await db.select().from(giveawayTxs).where(eq(giveawayTxs.id, w.id)))[0].valueWei).toBe(fits.toString())

    const g2 = await giveaway({ balance: pol('0.4') })
    await db.insert(giveawayTxs).values({
      giveawayId: g2.id, chain: 'polygon', kind: 'topup', fromAddress: addr(), toAddress: g2.walletAddress!, status: 'confirmed', valueWei: pol('0.4').toString(),
    })
    const [w2] = await db.insert(giveawayTxs).values({
      giveawayId: g2.id, chain: 'polygon', kind: 'withdraw', fromAddress: g2.walletAddress!, toAddress: hostWallet, status: 'sending', valueWei: pol('0.1').toString(),
    }).returning()
    await runGiveawayJob(at(MIN))
    expect((await db.select().from(giveawayTxs).where(eq(giveawayTxs.id, w2.id)))[0]).toMatchObject({ status: 'failed', lastError: 'nothing_to_send', rawTx: null })
    expect(chain.signs).toHaveLength(1)
  })

  it('reprices an unconfirmed mint after 3 minutes: same nonce and gas limit, fees up 15%', async () => {
    const g = await giveaway()
    const a = await claim(g)
    await runGiveawayJob(T0)
    await runGiveawayJob(at(2 * MIN))
    expect(chain.signs).toHaveLength(1)
    await runGiveawayJob(at(3 * MIN))
    expect(chain.signs).toHaveLength(2)
    const [s0, s1] = chain.signs
    expect(s1).toMatchObject({ nonce: s0.nonce, gasLimit: s0.gasLimit, wallets: s0.wallets })
    expect(s1.fees.maxFeePerGas).toBe((s0.fees.maxFeePerGas * 115n + 99n) / 100n)
    const [t] = await txs()
    expect(t.txHashes).toEqual([s0.hash, s1.hash])
    confirm()
    await runGiveawayJob(at(4 * MIN))
    expect((await txs())[0]).toMatchObject({ status: 'confirmed', txHash: s1.hash })
    expect((await claimOf(a.id)).status).toBe('sent')
  })

  it('a mint that reverts on chain for a lost minter pauses the giveaway and puts its claims back', async () => {
    const g = await giveaway()
    const a = await claim(g)
    await runGiveawayJob(T0)
    chain.setItem(C1, '1', { canMint: false })
    confirm()
    await runGiveawayJob(at(MIN))
    expect((await txs())[0].status).toBe('failed')
    expect((await giveawayOf(g.id)).pausedReason).toBe('not_minter')
    expect((await claimOf(a.id)).status).toBe('waiting')
    expect((await mintsOf(a.id))[0]).toMatchObject({ status: 'waiting', txId: null })
  })

  it('a dead RPC pauses the chain as rpc_down after 10 passes, with one job failure, and recovers', async () => {
    const g = await giveaway()
    await claim(g)
    chain.down = true
    for (let i = 0; i < 9; i++) await runGiveawayJob(at(i * MIN))
    expect((await giveawayOf(g.id)).pausedReason).toBeNull()
    await runGiveawayJob(at(9 * MIN))
    expect((await giveawayOf(g.id)).pausedReason).toBe('rpc_down')
    await runGiveawayJob(at(10 * MIN))
    expect(vi.mocked(recordJobFailure).mock.calls.filter((c) => c[0] === 'giveaway_rpc')).toHaveLength(1)
    chain.down = false
    await runGiveawayJob(at(11 * MIN))
    expect((await giveawayOf(g.id)).pausedReason).toBeNull()
    expect(chain.signs).toHaveLength(1)
  })

  it('a broadcast refused while the RPC is unreachable keeps the row and its nonce', async () => {
    const g = await giveaway()
    await claim(g)
    chain.broadcastError = () => new GiveawayRpcError('broadcast', 'UNKNOWN_ERROR')
    await runGiveawayJob(T0)
    for (let i = 1; i < 12; i++) await runGiveawayJob(at(i * 10 * MIN))
    const [t] = await txs()
    expect(t).toMatchObject({ status: 'sending', nonce: 0 })
    expect(chain.signs).toHaveLength(1)
    chain.broadcastError = null
    await runGiveawayJob(at(1000 * MIN))
    expect((await txs())[0].status).toBe('sent')
  })

  it('a receipt served late (nonce used, no receipt on one pass) confirms normally on the next, with nothing requeued', async () => {
    const g = await giveaway()
    const a = await claim(g)
    await runGiveawayJob(T0)
    confirm()
    chain.hiddenReceipts.add(chain.signs[0].hash)
    await runGiveawayJob(at(MIN))
    const [t] = await txs()
    expect(t).toMatchObject({ status: 'sent', replacedSeenBlock: chain.block })
    expect((await mintsOf(a.id))[0]).toMatchObject({ status: 'minting', txId: t.id })
    chain.hiddenReceipts.clear()
    await runGiveawayJob(at(2 * MIN))
    expect((await txs())[0].status).toBe('confirmed')
    expect((await claimOf(a.id)).status).toBe('sent')
    expect(chain.signs).toHaveLength(1)
  })

  it('a nonce used with no receipt of ours for good: the claims fail for a human, never minted again', async () => {
    const g = await giveaway()
    const a = await claim(g)
    await runGiveawayJob(T0)
    confirm()
    chain.hiddenReceipts.add(chain.signs[0].hash)
    await runGiveawayJob(at(MIN))
    chain.advance(GIVEAWAY_REPLACED_AFTER_BLOCKS - 1)
    await runGiveawayJob(at(2 * MIN))
    expect((await txs())[0].status).toBe('sent')
    chain.advance(1)
    await runGiveawayJob(at(3 * MIN))
    expect((await txs())[0]).toMatchObject({ status: 'failed', lastError: 'replaced' })
    expect(await claimOf(a.id)).toMatchObject({ status: 'failed', failReason: 'replaced' })
    expect((await mintsOf(a.id))[0].status).toBe('failed')
    for (let i = 4; i < 8; i++) await runGiveawayJob(at(i * MIN))
    expect(chain.signs).toHaveLength(1)
    expect(vi.mocked(recordJobFailure).mock.calls.filter((c) => c[0] === 'giveaway_replaced')).toHaveLength(1)
  })

  it('a mint whose bumped fee no longer fits is rebroadcast as signed, reported once, and a paid owner gets a top-up meanwhile', async () => {
    withTank()
    await paid()
    chain.setBalance(tank.address, pol('100'))
    const need = GIVEAWAY_GAS_PER_ITEM * chain.maxFeePerGas
    const g = await giveaway({ balance: need * 13n / 10n })
    const a = await claim(g)
    await runGiveawayJob(T0)
    expect(chain.signs).toHaveLength(1)
    chain.maxFeePerGas *= 2n // the bump would be 200 gwei: more than the wallet holds
    await runGiveawayJob(at(3 * MIN))
    const mintRaw = chain.signs[0].raw
    expect(chain.broadcasts.filter((r) => r === mintRaw)).toHaveLength(2)
    const top = (await txs()).find((t) => t.kind === 'topup')
    expect(top).toMatchObject({ status: 'sent', fromAddress: tank.address, toAddress: g.walletAddress })
    expect(chain.signs.filter((s) => s.kind === 'mint')).toHaveLength(1)
    await runGiveawayJob(at(6 * MIN))
    expect(vi.mocked(recordJobFailure).mock.calls.filter((c) => c[0] === 'giveaway_reprice')).toHaveLength(1)
    confirm()
    await runGiveawayJob(at(7 * MIN))
    expect((await claimOf(a.id)).status).toBe('sent')
  })

  it('an uncovered mint never spends Virvi float: a lapsed owner whose wallet holds only the float is paused low_gas', async () => {
    withTank()
    await paid('canceled')
    chain.setBalance(tank.address, pol('100'))
    const g = await giveaway({ balance: pol('0.5') })
    await db.insert(giveawayTxs).values({
      giveawayId: g.id, chain: 'polygon', kind: 'topup', fromAddress: tank.address, toAddress: g.walletAddress!, status: 'confirmed', valueWei: pol('0.5').toString(),
    })
    const a = await claim(g)
    await runGiveawayJob(T0)
    expect((await giveawayOf(g.id)).pausedReason).toBe('low_gas')
    expect((await txs()).filter((t) => t.kind !== 'topup' || t.status !== 'confirmed')).toHaveLength(0)
    expect(chain.broadcasts).toHaveLength(0)
    expect((await claimOf(a.id)).status).toBe('waiting')
  })

  it('a broadcast refused for funds keeps the row, pauses low_gas, and goes out (unpaused) once it can', async () => {
    const g = await giveaway()
    await claim(g)
    chain.broadcastError = () => new GiveawayRpcError('broadcast', 'INSUFFICIENT_FUNDS')
    await runGiveawayJob(T0)
    expect((await txs())[0]).toMatchObject({ status: 'sending', lastError: 'INSUFFICIENT_FUNDS', attempts: 0, nextAttemptAt: null })
    expect((await giveawayOf(g.id)).pausedReason).toBe('low_gas')
    chain.broadcastError = null
    await runGiveawayJob(at(MIN))
    expect((await txs())[0].status).toBe('sent')
    expect((await giveawayOf(g.id)).pausedReason).toBeNull()
    expect(chain.signs).toHaveLength(1)
  })

  it('claims whose contract has no items any more fail item_removed rather than wait forever', async () => {
    const g = await giveaway()
    const a = await claim(g)
    await db.delete(giveawayItems).where(eq(giveawayItems.giveawayId, g.id))
    await runGiveawayJob(T0)
    expect(await claimOf(a.id)).toMatchObject({ status: 'failed', failReason: 'item_removed' })
    expect((await mintsOf(a.id))[0].status).toBe('failed')
    expect(chain.signs).toHaveLength(0)
  })

  it('a disabled giveaway mints nothing', async () => {
    const g = await giveaway({ set: { enabled: false } })
    await claim(g)
    await runGiveawayJob(T0)
    expect(chain.signs).toHaveLength(0)
    expect(await db.select().from(giveawayTxs).where(and(eq(giveawayTxs.giveawayId, g.id)))).toHaveLength(0)
  })
})
