import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { parseEther } from 'ethers'
import { GIVEAWAY_GAS_PER_ITEM } from '@virvixr/shared'
import { config } from '../src/config.js'
import { db } from '../src/db/connection.js'
import { giveawayItems, giveaways, giveawayTxs, subscriptions } from '../src/db/schema.js'
import { accounting, fundingView, ownerIsPaid, withdrawableWei } from '../src/giveaways/funding.js'
import { resetDb } from './helpers/db.js'
import { createUser, randomWallet, type TestUser } from './helpers/factories.js'
import { giveawaysOn, type FakeGiveawayChain } from './helpers/giveaways-fake.js'

const pol = (s: string) => parseEther(s)

describe('giveaway funding (LIV-194)', () => {
  let host: TestUser
  let chain: FakeGiveawayChain
  let off: () => void
  const prevBilling = config.billingEnabled

  beforeEach(async () => {
    await resetDb()
    ;({ chain, off } = giveawaysOn())
    ;(config as any).billingEnabled = true
    host = await createUser({ wallet: randomWallet() })
  })
  afterEach(() => {
    off()
    ;(config as any).billingEnabled = prevBilling
  })

  async function giveaway(items = 1) {
    const wallet = randomWallet()
    const [g] = await db.insert(giveaways).values({ ownerId: host.id, name: 'G', walletAddress: wallet, walletKeyEnc: 'v1:x:y:z' }).returning()
    for (let i = 0; i < items; i++) await db.insert(giveawayItems).values({ giveawayId: g.id, contractAddress: randomWallet(), itemId: String(i) })
    return g
  }
  async function tx(g: typeof giveaways.$inferSelect, kind: 'topup' | 'mint' | 'withdraw' | 'return', over: Partial<typeof giveawayTxs.$inferInsert>) {
    await db.insert(giveawayTxs).values({ giveawayId: g.id, chain: 'polygon', kind, fromAddress: randomWallet(), toAddress: g.walletAddress!, status: 'confirmed', ...over })
  }

  describe('withdrawableWei', () => {
    it('counts gas against Virvi top-ups first and never pays out the float', () => {
      const acc = (topUps: string, gas: string) => {
        const topUpsWei = pol(topUps), coveredGasWei = pol(gas)
        return { topUpsWei, coveredGasWei, returnedWei: 0n, virviUnspentWei: topUpsWei > coveredGasWei ? topUpsWei - coveredGasWei : 0n }
      }
      expect(withdrawableWei(pol('2'), acc('1', '0.3'))).toBe(pol('1.3'))
      expect(withdrawableWei(pol('1'), acc('0.2', '0.5'))).toBe(pol('1'))
      expect(withdrawableWei(pol('0.5'), { topUpsWei: pol('0.7'), coveredGasWei: 0n, returnedWei: 0n, virviUnspentWei: pol('0.7') })).toBe(0n)
    })
  })

  describe('accounting', () => {
    it('sums confirmed top-ups and the fees of confirmed covered mints only', async () => {
      const g = await giveaway()
      await tx(g, 'topup', { valueWei: pol('0.6').toString() })
      await tx(g, 'topup', { valueWei: pol('0.4').toString() })
      await tx(g, 'topup', { valueWei: pol('5').toString(), status: 'sent' }) // not confirmed
      await tx(g, 'mint', { feeWei: pol('0.2').toString(), covered: true })
      await tx(g, 'mint', { feeWei: pol('0.1').toString(), covered: true })
      await tx(g, 'mint', { feeWei: pol('0.9').toString(), covered: false }) // the host's gas
      await tx(g, 'mint', { feeWei: pol('0.9').toString(), covered: true, status: 'failed' })
      const other = await giveaway()
      await tx(other, 'topup', { valueWei: pol('3').toString() })

      const acc = await accounting(g.id)
      expect(acc).toEqual({ topUpsWei: pol('1'), coveredGasWei: pol('0.3'), returnedWei: 0n, virviUnspentWei: pol('0.7') })
      expect(withdrawableWei(pol('2'), acc)).toBe(pol('1.3'))
    })

    it('is zero for a giveaway with no transactions, and never negative', async () => {
      const g = await giveaway()
      expect(await accounting(g.id)).toEqual({ topUpsWei: 0n, coveredGasWei: 0n, returnedWei: 0n, virviUnspentWei: 0n })
      await tx(g, 'topup', { valueWei: pol('0.2').toString() })
      await tx(g, 'mint', { feeWei: pol('0.5').toString(), covered: true })
      const acc = await accounting(g.id)
      expect(acc.virviUnspentWei).toBe(0n)
      expect(withdrawableWei(pol('1'), acc)).toBe(pol('1'))
    })

    it('takes confirmed returns (value and fee) off the float', async () => {
      const g = await giveaway()
      await tx(g, 'topup', { valueWei: pol('1').toString() })
      await tx(g, 'mint', { feeWei: pol('0.1').toString(), covered: true })
      await tx(g, 'return', { valueWei: pol('0.5').toString(), feeWei: pol('0.01').toString() })
      await tx(g, 'return', { valueWei: pol('0.3').toString(), status: 'sent' }) // not confirmed
      expect(await accounting(g.id)).toEqual({ topUpsWei: pol('1'), coveredGasWei: pol('0.1'), returnedWei: pol('0.51'), virviUnspentWei: pol('0.39') })
    })
  })

  describe('ownerIsPaid', () => {
    it('is true on an active paid plan and false once the subscription is cancelled', async () => {
      expect(await ownerIsPaid(host.id)).toBe(false)
      await db.insert(subscriptions).values({ userId: host.id, tier: 'creator', status: 'active' })
      expect(await ownerIsPaid(host.id)).toBe(true)
      await db.update(subscriptions).set({ status: 'canceled' }).where(eq(subscriptions.userId, host.id))
      expect(await ownerIsPaid(host.id)).toBe(false)
    })

    it('counts Virvi admins and servers without billing as paid', async () => {
      const admin = await createUser({ role: 'admin' })
      expect(await ownerIsPaid(admin.id)).toBe(true)
      ;(config as any).billingEnabled = false
      expect(await ownerIsPaid(host.id)).toBe(true)
    })
  })

  describe('fundingView', () => {
    it('free plan: claims covered from the balance and a low-gas warning under 10', async () => {
      const g = await giveaway(2)
      const perClaim = GIVEAWAY_GAS_PER_ITEM * 2n * chain.maxFeePerGas
      chain.setBalance(g.walletAddress!, perClaim * 9n + 1n)
      expect(await fundingView(g)).toEqual({
        balanceWei: (perClaim * 9n + 1n).toString(), withdrawableWei: (perClaim * 9n + 1n).toString(),
        claimsCovered: 9, covered: false, tankMissing: false, lowGas: true,
      })
      chain.setBalance(g.walletAddress!, perClaim * 10n)
      expect(await fundingView(g)).toMatchObject({ claimsCovered: 10, lowGas: false })
    })

    it('paid plan: covered with a gas key, tank missing without one; Virvi float is not withdrawable', async () => {
      const g = await giveaway()
      await db.insert(subscriptions).values({ userId: host.id, tier: 'pro', status: 'active' })
      await tx(g, 'topup', { valueWei: pol('0.5').toString() })
      chain.setBalance(g.walletAddress!, pol('0.5'))
      expect(await fundingView(g)).toMatchObject({ covered: false, tankMissing: true, lowGas: false, withdrawableWei: '0' })
      ;(config as any).giveaways = { ...config.giveaways, gasKey: '0x' + '11'.repeat(32) }
      expect(await fundingView(g)).toMatchObject({ covered: true, tankMissing: false, lowGas: false })
    })
  })
})
