import { describe, it, expect, beforeEach, beforeAll, afterAll, afterEach, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '../src/db/connection.js'
import {
  studioCreditLedger, studioDesignMembers, studioDesigns, studioEntitlements, studioFinalizeCredits, studioFlags, studioJobs, studioPayments,
  studioMistakeReports, studioPromptCredits, studioRevisions, studioScopeEvents, studioUsageDays, users,
} from '../src/db/schema.js'
import { config } from '../src/config.js'
import { setStripe } from '../src/integrations/stripe.js'
import { memoryStudioStore, setStudioStore } from '../src/studio/store.js'
import { setMachineDeps } from '../src/studio/machines.js'
import { approveReport, createTopupCheckout, expirePayment, grantPayment, heldReports } from '../src/studio/payments.js'
import { handOverDesigns } from '../src/studio/handover.js'
import { setManaRateSource } from '../src/studio/mana/rate.js'
import { setManaSaltSource, type ManaQuote } from '../src/studio/mana/quote.js'
import { setPolygon } from '../src/studio/mana/polygon.js'
import { watchManaTransfers } from '../src/studio/mana/settle.js'
import { sweepStudio } from '../src/studio/sweep.js'
import { resetDb } from './helpers/db.js'
import { createUser, testApp } from './helpers/factories.js'
import { addRevision, createDesign, entitle, fakeFly, fakePolygon, fakeStripe, issueWorker, okResult, PROMPT_PAYLOAD, queueJob } from './helpers/studio.js'
import { utcDay } from '../src/studio/quota.js'

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

/**
 * LIV-159: a prompt's sender can delete their account while it is queued or running (studio_jobs.user_id has no FK).
 * Its result, or its loss, settles the job and charges nobody: never the design's owner, never a row for the gone user.
 */
describe('a prompt whose sender account was deleted', () => {
  let app: Awaited<ReturnType<typeof testApp>>
  const prev = { enabled: config.studioEnabled, image: config.studioWorkerImage }
  beforeAll(() => {
    ;(config as any).studioEnabled = true
    ;(config as any).studioWorkerImage = 'registry.fly.io/vlm-studio-worker:test'
  })
  afterAll(() => {
    ;(config as any).studioEnabled = prev.enabled
    ;(config as any).studioWorkerImage = prev.image
    setMachineDeps(null)
    setStudioStore(null)
  })
  beforeEach(async () => {
    await resetDb()
    setStudioStore(memoryStudioStore())
    setMachineDeps({ fly: fakeFly() })
    app = await testApp()
  })
  afterEach(async () => { await app.close() })

  /** A collaborator's credit-sourced prompt, taken at `takenAt`, whose sender then deletes their account. */
  async function goneSender(takenAt = new Date()) {
    const owner = await createUser()
    const collab = await createUser()
    const d = await createDesign(owner, { status: 'building', machineId: 'm1', lastJobAt: takenAt })
    await db.insert(studioDesignMembers).values({ designId: d.id, userId: collab.id, role: 'collaborator' })
    const job = await queueJob(d, PROMPT_PAYLOAD, {
      userId: collab.id, counted: true, countedFrom: 'credit', countedDay: utcDay(takenAt), status: 'taken', takenAt, createdAt: takenAt,
    })
    await db.delete(users).where(eq(users.id, collab.id))
    return { owner, d, job }
  }
  const nobodyCharged = async () => {
    expect(await db.select().from(studioUsageDays)).toEqual([])
    expect(await db.select().from(studioPromptCredits)).toEqual([])
    expect(await db.select().from(studioScopeEvents)).toEqual([])
  }
  const post = async (d: { id: string }, jobId: string, over: Record<string, unknown>) => {
    const token = await issueWorker(d, 'm1')
    return app.inject({
      method: 'POST', url: `/api/studio/worker/jobs/${jobId}/result`, headers: { authorization: `Bearer ${token}` },
      payload: okResult(jobId, over) as any,
    })
  }
  const jobRow = async (id: string) => (await db.select().from(studioJobs).where(eq(studioJobs.id, id)))[0]
  const designRow = async (id: string) => (await db.select().from(studioDesigns).where(eq(studioDesigns.id, id)))[0]

  it('its result is applied, the job settles and no cost or give-back is recorded', async () => {
    const { d, job } = await goneSender()
    const res = await post(d, job.id, { outcome: 'error', error: 'boom', pieces: [], costUsd: 0.5 })
    expect(res.statusCode).toBe(204)
    expect(await jobRow(job.id)).toMatchObject({ status: 'failed' })
    expect((await designRow(d.id)).status).toBe('idle')
    await nobodyCharged()
  })

  it('a paid result keeps its pieces and records no cost', async () => {
    const { d, job } = await goneSender()
    expect((await post(d, job.id, { costUsd: 0.74 })).statusCode).toBe(204)
    expect(await jobRow(job.id)).toMatchObject({ status: 'done' })
    expect(await db.select().from(studioRevisions)).toHaveLength(1)
    await nobodyCharged()
  })

  it('an off-topic turn-down logs no scope event and flags nobody', async () => {
    const { d, job } = await goneSender()
    const res = await post(d, job.id, {
      outcome: 'off_topic', pieces: [], costUsd: 0.1, scope: { by: 'agent', category: 'other', note: 'not a wearable' },
    })
    expect(res.statusCode).toBe(204)
    expect(await jobRow(job.id)).toMatchObject({ status: 'done' })
    expect(await db.select().from(studioFlags)).toEqual([])
    await nobodyCharged()
  })

  it('the sweep fails it as lost and still runs its later steps', async () => {
    const t0 = new Date('2026-11-04T12:00:00Z')
    const fly = fakeFly()
    const { d, job } = await goneSender(t0)
    const idle = await createDesign(await createUser(), { machineId: 'm-idle', lastJobAt: t0 })
    const now = new Date(t0.getTime() + 3 * 24 * 3600_000 + MIN)
    expect(await sweepStudio(now, { fly })).toEqual({ lost: 1, destroyed: 2 }) // its design and the idle one
    expect(await jobRow(job.id)).toMatchObject({ status: 'failed' })
    expect((await designRow(d.id)).status).toBe('idle')
    expect((await designRow(idle.id)).machineId).toBeNull()
    await nobodyCharged()
  })
})

/**
 * LIV-159: an owner reports a mistake that waits for review, then deletes their account and the design passes to a
 * collaborator. The report stays on the admin page with its reporter shown as gone, and approving it refunds the card
 * share and records it once; the credit share has nobody to go to.
 */
describe('a held mistake report whose reporter account was deleted', () => {
  let stripe: ReturnType<typeof fakeStripe>
  afterAll(() => { setStripe(null) })
  beforeEach(async () => {
    await resetDb()
    stripe = fakeStripe()
    setStripe(stripe)
  })

  async function heldReportOfGoneOwner() {
    const owner = await createUser()
    const collab = await createUser()
    const d = await createDesign(owner)
    await db.insert(studioDesignMembers).values({ designId: d.id, userId: collab.id, role: 'collaborator' })
    await entitle(d, await addRevision(d, 'hat'))
    const { payment, entitlement } = await entitle(d, await addRevision(d, 'hat'), { amountCents: 1500 })
    await db.update(studioEntitlements).set({ creditCents: 500 }).where(eq(studioEntitlements.id, entitlement.id))
    const [report] = await db.insert(studioMistakeReports).values({
      entitlementId: entitlement.id, userId: owner.id, text: 'the visor vanished', refundCents: 1500, status: 'in_review',
    }).returning()
    await db.transaction(async (tx) => {
      expect(await handOverDesigns(tx, owner.id, new Date())).toBe(1)
      await tx.delete(users).where(eq(users.id, owner.id))
    })
    return { owner, d, payment, report }
  }

  it('is still listed for review, its reporter shown as gone', async () => {
    const { owner, report } = await heldReportOfGoneOwner()
    const held = await heldReports(new Date())
    expect(held.map((r) => [r.id, r.user])).toEqual([[report.id, { id: owner.id, email: null, gone: true }]])
  })

  it('approving it refunds the card share, records it, and credits nobody', async () => {
    const { payment, report } = await heldReportOfGoneOwner()
    const admin = await createUser({ role: 'admin' })
    expect(await approveReport(report.id, admin.id, new Date())).toMatchObject({ status: 'refunded', refundCents: 1500 })
    expect(stripe.calls.refunds.map((r) => r.params.amount)).toEqual([1000])
    expect((await db.select().from(studioPayments).where(eq(studioPayments.id, payment.id)))[0].refundedCents).toBe(1000)
    expect((await db.select().from(studioMistakeReports).where(eq(studioMistakeReports.id, report.id)))[0])
      .toMatchObject({ status: 'refunded', reviewedBy: admin.id })
    expect(await db.select().from(studioCreditLedger)).toEqual([])
    expect(await heldReports(new Date())).toEqual([])
  })
})
