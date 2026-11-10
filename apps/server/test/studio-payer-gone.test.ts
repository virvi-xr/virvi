import { describe, it, expect, beforeEach, beforeAll, afterAll, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '../src/db/connection.js'
import { studioCreditLedger, studioEntitlements, studioFinalizeCredits, studioPayments, users } from '../src/db/schema.js'
import { config } from '../src/config.js'
import { setStripe } from '../src/integrations/stripe.js'
import { memoryStudioStore, setStudioStore } from '../src/studio/store.js'
import { setMachineDeps } from '../src/studio/machines.js'
import { createTopupCheckout, expirePayment, grantPayment } from '../src/studio/payments.js'
import { setManaRateSource } from '../src/studio/mana/rate.js'
import { setManaSaltSource, type ManaQuote } from '../src/studio/mana/quote.js'
import { setPolygon } from '../src/studio/mana/polygon.js'
import { watchManaTransfers } from '../src/studio/mana/settle.js'
import { sweepStudio } from '../src/studio/sweep.js'
import { resetDb } from './helpers/db.js'
import { createUser } from './helpers/factories.js'
import { fakeFly, fakePolygon, fakeStripe } from './helpers/studio.js'

/**
 * A payment outlives its payer (studio_payments.user_id is ON DELETE SET NULL). With nobody to give anything back to or
 * grant to, releasing it, granting it and reopening it do nothing, and never throw.
 */

const RECIPIENT = '0x01d871870CbBddE934526E17637c0cfEf0b3b38B'
const MIN = 60_000
const T = new Date('2026-11-04T12:00:00Z')

describe('a payment whose payer account was deleted', () => {
  let chain: ReturnType<typeof fakePolygon>
  const prev = { enabled: config.studioEnabled, image: config.studioWorkerImage, recipient: config.studioMana.recipient }
  beforeAll(() => {
    ;(config as any).studioEnabled = true
    ;(config as any).studioWorkerImage = 'registry.fly.io/vlm-studio-worker:test'
  })
  afterAll(() => {
    ;(config as any).studioEnabled = prev.enabled
    ;(config as any).studioWorkerImage = prev.image
    ;(config.studioMana as any).recipient = prev.recipient
    setStripe(null)
    setMachineDeps(null)
    setStudioStore(null)
    setManaRateSource(null)
    setManaSaltSource(null)
    setPolygon(null)
  })
  beforeEach(async () => {
    await resetDb()
    ;(config.studioMana as any).recipient = RECIPIENT
    setManaRateSource(async () => 0.25)
    setManaSaltSource(null)
    setStripe(fakeStripe())
    setMachineDeps({ fly: fakeFly() })
    setStudioStore(memoryStudioStore())
    chain = fakePolygon({ t0: T })
    setPolygon(chain)
  })

  /** A pending top-up that holds 3 free finalizes' worth of state and 200 cents of credit, whose payer is then deleted. */
  async function orphan(method: 'card' | 'mana' = 'card') {
    const u = await createUser()
    await db.insert(studioFinalizeCredits).values({ userId: u.id, balance: 0 })
    const [p] = await db.insert(studioPayments).values({
      userId: u.id, kind: 'topup', amountCents: 500, prompts: 10, method, giftsHeld: 3, creditHeldCents: 200,
      status: 'pending', expiresAt: new Date(T.getTime() + 30 * MIN),
    }).returning()
    await db.delete(users).where(eq(users.id, u.id))
    return p.id
  }
  const row = async (id: string) => (await db.select().from(studioPayments).where(eq(studioPayments.id, id)))[0]

  it('expiring it returns nothing to anyone and does not throw', async () => {
    const id = await orphan()
    await expirePayment(id, T)
    expect(await row(id)).toMatchObject({ userId: null, status: 'expired', giftsHeld: 0, creditHeldCents: 0 })
    expect(await db.select().from(studioCreditLedger)).toEqual([])
    expect(await db.select().from(studioFinalizeCredits)).toEqual([])
  })

  it('granting it returns without throwing, grants nothing and leaves it pending', async () => {
    const id = await orphan()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      expect(await grantPayment(id, 'pi_gone', T)).toBe('already')
      expect(warn).toHaveBeenCalledTimes(1)
      expect(String(warn.mock.calls[0][0])).toContain(id)
    } finally {
      warn.mockRestore()
    }
    expect(await row(id)).toMatchObject({ userId: null, status: 'pending', stripePaymentIntent: null })
    expect(await db.select().from(studioEntitlements)).toEqual([])
    expect(await db.select().from(studioCreditLedger)).toEqual([])
  })

  it('the MANA watcher finds a transfer for it and reopening is a no-op', async () => {
    const u = await createUser()
    const q = (await createTopupCheckout({ id: u.id, email: u.email ?? null }, 1, T, 'mana')) as unknown as { mana: ManaQuote }
    const { paymentId } = q.mana
    await sweepStudio(new Date(new Date(q.mana.expiresAt).getTime() + 16 * MIN))
    expect(await row(paymentId)).toMatchObject({ status: 'expired' })
    await db.delete(users).where(eq(users.id, u.id))
    const at = new Date(new Date(q.mana.expiresAt).getTime() + 20 * MIN)
    chain.send({ to: RECIPIENT, amountWei: BigInt(q.mana.amountWei), at: new Date(new Date(q.mana.expiresAt).getTime() - MIN) })
    chain.advance(30)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      await watchManaTransfers(at)
      expect(warn).toHaveBeenCalledTimes(1) // grantPayment found no payer
    } finally {
      warn.mockRestore()
    }
    expect(await row(paymentId)).toMatchObject({ userId: null, status: 'expired', giftsHeld: 0, creditHeldCents: 0 })
    expect(await db.select().from(studioEntitlements)).toEqual([])
  })
})
