import { describe, it, expect, beforeEach, beforeAll, afterAll, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '../src/db/connection.js'
import { studioManaTransfers, studioPayments } from '../src/db/schema.js'
import { config } from '../src/config.js'
import { setStripe } from '../src/integrations/stripe.js'
import { memoryStudioStore, setStudioStore } from '../src/studio/store.js'
import { setMachineDeps } from '../src/studio/machines.js'
import { addCredit, creditBalance } from '../src/studio/credit.js'
import { createFinalizeCheckout, PaymentError } from '../src/studio/payments.js'
import { setManaRateSource } from '../src/studio/mana/rate.js'
import { setManaSaltSource, type ManaQuote } from '../src/studio/mana/quote.js'
import { setPolygon } from '../src/studio/mana/polygon.js'
import { listManaTransfers, markTransferReturned, settleTransferByHand, watchManaTransfers } from '../src/studio/mana/settle.js'
import { sweepStudio } from '../src/studio/sweep.js'
import { resetDb } from './helpers/db.js'
import { createUser } from './helpers/factories.js'
import { createDesign, addRevision, fakeFly, fakePolygon, fakeStripe } from './helpers/studio.js'

// A grant whose work after its commit fails: the payment is paid, yet settling it throws
const failStart = vi.hoisted(() => ({ on: false }))
vi.mock('../src/studio/designs.js', async (original) => {
  const real = await original<typeof import('../src/studio/designs.js')>()
  return {
    ...real,
    startWorker: async (...args: Parameters<typeof real.startWorker>) => {
      if (failStart.on) throw new Error('worker start blew up')
      return real.startWorker(...args)
    },
  }
})

const RECIPIENT = '0x01d871870CbBddE934526E17637c0cfEf0b3b38B'
const MIN = 60_000
const T = new Date('2026-11-04T12:00:00Z')

describe('settling a transfer by hand when settling fails (finding 6)', () => {
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
    failStart.on = false
    ;(config.studioMana as any).recipient = RECIPIENT
    setManaRateSource(async () => 0.25)
    setStripe(fakeStripe())
    setMachineDeps({ fly: fakeFly() })
    setStudioStore(memoryStudioStore())
    chain = fakePolygon({ t0: T })
    setPolygon(chain)
  })

  const paymentOf = async (id: string) => (await db.select().from(studioPayments).where(eq(studioPayments.id, id)))[0]
  const transfer = async () => (await db.select().from(studioManaTransfers))[0]

  /** A 2900 MANA quote holding 1000 credit, expired, whose transfer came after the grace: unmatched. */
  async function unmatched() {
    const u = await createUser()
    const admin = await createUser({ role: 'admin' })
    const d = await createDesign(u)
    await addRevision(d, 'hat')
    await db.transaction((tx) => addCredit(tx, u.id, 1000, 'refund', null, T))
    const { mana } = await createFinalizeCheckout(d, { id: u.id, email: u.email ?? null }, null, {}, T, 'mana') as { mana: ManaQuote }
    const expiresAt = new Date(mana.expiresAt).getTime()
    await sweepStudio(new Date(expiresAt + 16 * MIN))
    const hash = chain.send({ to: RECIPIENT, amountWei: BigInt(mana.amountWei), at: new Date(expiresAt + 20 * MIN) })
    chain.advance(30)
    expect(await watchManaTransfers(new Date(expiresAt + 21 * MIN))).toEqual({ matched: 0, unmatched: 1 })
    return { u, admin, mana, hash, later: new Date(expiresAt + 22 * MIN) }
  }

  it('a settle that fails before the grant lets go of the claim, so nothing is stranded and it can be tried again', async () => {
    const { u, admin, mana, hash, later } = await unmatched()
    const pay = await paymentOf(mana.paymentId)
    await db.update(studioPayments).set({ lines: pay.lines.map((l) => ({ ...l, revisionId: '00000000-0000-4000-8000-000000000000' })) })
      .where(eq(studioPayments.id, mana.paymentId))
    await expect(settleTransferByHand(hash, 0, mana.paymentId, admin.id, null, later)).rejects.toThrow()
    expect(await paymentOf(mana.paymentId)).toMatchObject({ manaTxHash: null })
    expect(await transfer()).toMatchObject({ status: 'unmatched', paymentId: null })
    // Still a candidate for the owner, and returning it is allowed
    const [listed] = await listManaTransfers('unmatched')
    expect((listed as { candidates: { id: string }[] }).candidates.map((c) => c.id)).toEqual([mana.paymentId])
    await markTransferReturned(hash, 0, '0x' + 'b'.repeat(64), admin.id, later)
    expect(await transfer()).toMatchObject({ status: 'returned' })
    // The reopened payment lapses with the sweep and its credit comes back
    await sweepStudio(new Date(later.getTime() + 30 * MIN))
    expect(await creditBalance(u.id)).toBe(1000)
  })

  it('a settle that fails after the grant committed keeps the transfer settled by hand', async () => {
    const { admin, mana, hash, later } = await unmatched()
    failStart.on = true
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      expect(await settleTransferByHand(hash, 0, mana.paymentId, admin.id, null, later))
        .toMatchObject({ status: 'settled_by_hand', paymentId: mana.paymentId })
      expect(err.mock.calls.some((c) => String(c[0]).includes(mana.paymentId))).toBe(true)
    } finally {
      err.mockRestore()
    }
    expect(await paymentOf(mana.paymentId)).toMatchObject({ status: 'paid', manaTxHash: hash })
    expect(await transfer()).toMatchObject({ status: 'settled_by_hand', paymentId: mana.paymentId })
  })

  it('refuses to mark a transfer returned while a payment holds its hash', async () => {
    const { admin, mana, hash, later } = await unmatched()
    await db.update(studioPayments).set({ manaTxHash: hash }).where(eq(studioPayments.id, mana.paymentId))
    const err = await markTransferReturned(hash, 0, '0x' + 'b'.repeat(64), admin.id, later).catch((e) => e)
    expect(err).toBeInstanceOf(PaymentError)
    expect(err).toMatchObject({ status: 409, code: 'payment_claimed' })
    expect(await transfer()).toMatchObject({ status: 'unmatched' })
  })
})
