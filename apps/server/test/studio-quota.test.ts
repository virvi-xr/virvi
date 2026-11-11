import { describe, it, expect, beforeEach } from 'vitest'
import { db } from '../src/db/connection.js'
import { subscriptions, studioPromptCredits, studioFinalizeCredits, studioPayments } from '../src/db/schema.js'
import { eq } from 'drizzle-orm'
import { utcDay, promptStatus, reservePrompt, refundPrompt, recordCost } from '../src/studio/quota.js'
import { resetDb } from './helpers/db.js'
import { createUser } from './helpers/factories.js'
import { usage } from '../src/studio/designs.js'
import { applyResult } from '../src/studio/results.js'
import { createDesign, queueJob, okResult } from './helpers/studio.js'

const NOW = new Date('2026-10-25T12:00:00Z')

describe('studio quota', () => {
  beforeEach(resetDb)

  it('utcDay is the UTC calendar day', () => {
    expect(utcDay(new Date('2026-10-25T23:59:59Z'))).toBe('2026-10-25')
    expect(utcDay(new Date('2026-10-26T00:00:00Z'))).toBe('2026-10-26')
  })

  it('free plan gets three prompts a day', async () => {
    const u = await createUser()
    for (let i = 0; i < 3; i++) expect(await reservePrompt(u.id, NOW, { counted: true })).toEqual({ ok: true, day: '2026-10-25', from: 'allowance' })
    expect(await reservePrompt(u.id, NOW, { counted: true })).toEqual({ ok: false, reason: 'allowance' })
    const s = await promptStatus(u.id, NOW)
    expect(s).toMatchObject({ plan: 'free', allowance: 3, used: 3, left: 0, overCostCeiling: false })
  })

  it('the allowance resets at midnight UTC', async () => {
    const u = await createUser()
    const late = new Date('2026-10-25T23:59:00Z')
    for (let i = 0; i < 3; i++) await reservePrompt(u.id, late, { counted: true })
    expect((await promptStatus(u.id, late)).resetsAt).toBe('2026-10-26T00:00:00.000Z')
    expect(await reservePrompt(u.id, new Date('2026-10-26T00:00:01Z'), { counted: true })).toEqual({ ok: true, day: '2026-10-26', from: 'allowance' })
  })

  it('concurrent reservations never pass the allowance', async () => {
    const u = await createUser()
    const results = await Promise.all(Array.from({ length: 6 }, () => reservePrompt(u.id, NOW, { counted: true })))
    expect(results.filter((r) => r.ok)).toHaveLength(3)
    expect((await promptStatus(u.id, NOW)).used).toBe(3)
  })

  it('the hidden cost ceiling stops prompts, counted or not', async () => {
    const u = await createUser()
    await db.insert(subscriptions).values({ userId: u.id, tier: 'creator' })
    await recordCost(u.id, '2026-10-25', 30)
    expect(await reservePrompt(u.id, NOW, { counted: true })).toEqual({ ok: false, reason: 'cost_ceiling' })
    expect(await reservePrompt(u.id, NOW, { counted: false })).toEqual({ ok: false, reason: 'cost_ceiling' })
    expect((await promptStatus(u.id, NOW)).overCostCeiling).toBe(true)
  })

  it("uncounted reservations don't use the allowance", async () => {
    const u = await createUser()
    for (let i = 0; i < 3; i++) await reservePrompt(u.id, NOW, { counted: true })
    expect(await reservePrompt(u.id, NOW, { counted: false })).toEqual({ ok: true, day: '2026-10-25', from: null })
    expect((await promptStatus(u.id, NOW)).used).toBe(3)
  })

  it('refunds give a prompt back once and never go negative', async () => {
    const u = await createUser()
    await reservePrompt(u.id, NOW, { counted: true })
    await refundPrompt(u.id, '2026-10-25', 'allowance')
    await refundPrompt(u.id, '2026-10-25', 'allowance')
    expect((await promptStatus(u.id, NOW)).used).toBe(0)
  })

  it('paid plans use their own allowance', async () => {
    const u = await createUser()
    await db.insert(subscriptions).values({ userId: u.id, tier: 'pro' })
    expect(await promptStatus(u.id, NOW)).toMatchObject({ plan: 'pro', allowance: 40, left: 40 })
  })

  const credits = async (userId: string) =>
    (await db.select().from(studioPromptCredits).where(eq(studioPromptCredits.userId, userId)))[0]?.balance ?? 0

  it('credits are used after the allowance', async () => {
    const u = await createUser()
    await db.insert(studioPromptCredits).values({ userId: u.id, balance: 2 })
    for (let i = 0; i < 3; i++) expect((await reservePrompt(u.id, NOW, { counted: true }) as any).from).toBe('allowance')
    expect(await reservePrompt(u.id, NOW, { counted: true })).toEqual({ ok: true, day: '2026-10-25', from: 'credit' })
    expect(await reservePrompt(u.id, NOW, { counted: true })).toEqual({ ok: true, day: '2026-10-25', from: 'credit' })
    expect(await reservePrompt(u.id, NOW, { counted: true })).toEqual({ ok: false, reason: 'allowance' })
    expect(await credits(u.id)).toBe(0)
    expect((await promptStatus(u.id, NOW)).used).toBe(3)
  })

  it('concurrent reservations never overspend credits', async () => {
    const u = await createUser()
    await db.insert(studioPromptCredits).values({ userId: u.id, balance: 2 })
    const results = await Promise.all(Array.from({ length: 8 }, () => reservePrompt(u.id, NOW, { counted: true })))
    expect(results.filter((r) => r.ok)).toHaveLength(5)
    expect(await credits(u.id)).toBe(0)
  })

  it('a refunded credit prompt returns the credit', async () => {
    const u = await createUser()
    await db.insert(studioPromptCredits).values({ userId: u.id, balance: 1 })
    for (let i = 0; i < 4; i++) await reservePrompt(u.id, NOW, { counted: true })
    expect(await credits(u.id)).toBe(0)
    await refundPrompt(u.id, '2026-10-25', 'credit')
    expect(await credits(u.id)).toBe(1)
    expect((await promptStatus(u.id, NOW)).used).toBe(3)
  })

  it('credits never pass the cost ceiling', async () => {
    const u = await createUser()
    await db.insert(studioPromptCredits).values({ userId: u.id, balance: 5 })
    for (let i = 0; i < 3; i++) await reservePrompt(u.id, NOW, { counted: true })
    await recordCost(u.id, '2026-10-25', 6)
    expect(await reservePrompt(u.id, NOW, { counted: true })).toEqual({ ok: false, reason: 'cost_ceiling' })
    expect(await credits(u.id)).toBe(5)
  })

  it('usage shows credits', async () => {
    const u = await createUser()
    await db.insert(studioPromptCredits).values({ userId: u.id, balance: 7 })
    await reservePrompt(u.id, NOW, { counted: true })
    expect(await promptStatus(u.id, NOW)).toMatchObject({ allowance: 3, used: 1, credits: 7, left: 9 })
  })

  const gifted = async (userId: string) =>
    (await db.select().from(studioPromptCredits).where(eq(studioPromptCredits.userId, userId)))[0]?.gifted ?? 0

  it('gifted prompts are spent after the allowance and before bought ones', async () => {
    const u = await createUser()
    await db.insert(studioPromptCredits).values({ userId: u.id, balance: 2, gifted: 2 })
    for (let i = 0; i < 3; i++) expect((await reservePrompt(u.id, NOW, { counted: true }) as any).from).toBe('allowance')
    expect(await reservePrompt(u.id, NOW, { counted: true })).toEqual({ ok: true, day: '2026-10-25', from: 'gift' })
    expect(await reservePrompt(u.id, NOW, { counted: true })).toEqual({ ok: true, day: '2026-10-25', from: 'gift' })
    expect(await gifted(u.id)).toBe(0)
    expect(await credits(u.id)).toBe(2)
    expect(await reservePrompt(u.id, NOW, { counted: true })).toEqual({ ok: true, day: '2026-10-25', from: 'credit' })
    expect(await promptStatus(u.id, NOW)).toMatchObject({ used: 3, credits: 1, gifted: 0, left: 1 })
  })

  it('a free try-again (gifts: false) never takes a gifted prompt past the ceiling', async () => {
    const u = await createUser()
    await db.insert(studioPromptCredits).values({ userId: u.id, gifted: 2 })
    expect(await reservePrompt(u.id, NOW, { counted: false, gifts: false })).toEqual({ ok: true, day: '2026-10-25', from: null })
    await recordCost(u.id, '2026-10-25', 6)
    expect(await reservePrompt(u.id, NOW, { counted: false, gifts: false })).toEqual({ ok: false, reason: 'cost_ceiling' })
    expect(await gifted(u.id)).toBe(2)
  })

  it('gifted prompts run past the cost ceiling', async () => {
    const u = await createUser()
    await db.insert(studioPromptCredits).values({ userId: u.id, balance: 5, gifted: 2 })
    for (let i = 0; i < 3; i++) await reservePrompt(u.id, NOW, { counted: true })
    await recordCost(u.id, '2026-10-25', 6)
    expect((await promptStatus(u.id, NOW)).overCostCeiling).toBe(false)
    expect(await reservePrompt(u.id, NOW, { counted: true })).toEqual({ ok: true, day: '2026-10-25', from: 'gift' })
    expect(await gifted(u.id)).toBe(1)
    expect(await reservePrompt(u.id, NOW, { counted: true })).toEqual({ ok: true, day: '2026-10-25', from: 'gift' })
    expect(await reservePrompt(u.id, NOW, { counted: true })).toEqual({ ok: false, reason: 'cost_ceiling' })
    expect(await reservePrompt(u.id, NOW, { counted: false })).toEqual({ ok: false, reason: 'cost_ceiling' })
    expect(await credits(u.id)).toBe(5)
    expect((await promptStatus(u.id, NOW)).overCostCeiling).toBe(true)
  })

  it('concurrent reservations never overspend gifted prompts', async () => {
    const u = await createUser()
    await db.insert(studioPromptCredits).values({ userId: u.id, gifted: 2 })
    const results = await Promise.all(Array.from({ length: 8 }, () => reservePrompt(u.id, NOW, { counted: true })))
    expect(results.filter((r) => r.ok)).toHaveLength(5)
    expect(results.filter((r) => r.ok && r.from === 'gift')).toHaveLength(2)
    expect(await gifted(u.id)).toBe(0)
  })

  it('a refunded gifted prompt goes back to the gifted balance', async () => {
    const u = await createUser()
    await db.insert(studioPromptCredits).values({ userId: u.id, gifted: 1 })
    for (let i = 0; i < 4; i++) await reservePrompt(u.id, NOW, { counted: true })
    expect(await gifted(u.id)).toBe(0)
    await refundPrompt(u.id, '2026-10-25', 'gift')
    expect(await gifted(u.id)).toBe(1)
    expect(await credits(u.id)).toBe(0)
    expect((await promptStatus(u.id, NOW)).used).toBe(3)
  })

  it('a refunded gifted prompt creates the balance row when there is none', async () => {
    const u = await createUser()
    await refundPrompt(u.id, '2026-10-25', 'gift')
    expect(await gifted(u.id)).toBe(1)
  })

  it('usage reports gifted prompts and free finalizes', async () => {
    const u = await createUser()
    await db.insert(studioPromptCredits).values({ userId: u.id, balance: 1, gifted: 4 })
    await db.insert(studioFinalizeCredits).values({ userId: u.id, balance: 3 })
    const mk = (over: Partial<typeof studioPayments.$inferInsert>) => db.insert(studioPayments).values({
      userId: u.id, kind: 'finalize', status: 'pending', amountCents: 100, giftsHeld: 1,
      expiresAt: new Date(Date.now() + 3600_000), ...over,
    })
    await mk({ giftsHeld: 2 })
    await mk({ giftsHeld: 1 })
    await mk({ status: 'expired' })
    await mk({ expiresAt: new Date(Date.now() - 1000) })
    await mk({ kind: 'topup' })
    expect(await usage(u.id, 5, new Date())).toMatchObject({
      promptsLeft: 8, credits: 1, giftedPrompts: 4, freeFinalizes: { available: 3, held: 3 },
    })
    const other = await createUser()
    expect(await usage(other.id, 5, new Date())).toMatchObject({ giftedPrompts: 0, freeFinalizes: { available: 0, held: 0 } })
  })

  it('past the ceiling an uncounted run takes one gifted prompt, and is refused once they are gone', async () => {
    const u = await createUser()
    await db.insert(studioPromptCredits).values({ userId: u.id, balance: 5, gifted: 2 })
    await recordCost(u.id, '2026-10-25', 6)
    expect(await reservePrompt(u.id, NOW, { counted: false })).toEqual({ ok: true, day: '2026-10-25', from: 'gift' })
    expect(await gifted(u.id)).toBe(1)
    expect(await reservePrompt(u.id, NOW, { counted: false })).toEqual({ ok: true, day: '2026-10-25', from: 'gift' })
    expect(await gifted(u.id)).toBe(0)
    expect(await reservePrompt(u.id, NOW, { counted: false })).toEqual({ ok: false, reason: 'cost_ceiling' })
    expect(await credits(u.id)).toBe(5)
  })

  it('under the ceiling an uncounted run is still free and leaves gifted prompts alone', async () => {
    const u = await createUser()
    await db.insert(studioPromptCredits).values({ userId: u.id, gifted: 2 })
    expect(await reservePrompt(u.id, NOW, { counted: false })).toEqual({ ok: true, day: '2026-10-25', from: null })
    expect(await gifted(u.id)).toBe(2)
  })

  it('an errored uncounted run past the ceiling gives its gifted prompt back; a free one refunds nothing', async () => {
    const u = await createUser()
    const design = await createDesign(u, { status: 'building', machineId: 'm1' })
    await db.insert(studioPromptCredits).values({ userId: u.id, gifted: 1 })
    await recordCost(u.id, '2026-10-25', 6)
    const r = await reservePrompt(u.id, NOW, { counted: false }) as { day: string; from: 'gift' }
    expect(await gifted(u.id)).toBe(0)
    const job = await queueJob(design, undefined, { counted: false, countedDay: r.day, countedFrom: r.from, status: 'taken' })
    await applyResult(job.id, okResult(job.id, { outcome: 'error', error: 'boom', pieces: [], costUsd: 0 }) as any, NOW)
    expect(await gifted(u.id)).toBe(1)

    const free = await queueJob(design, undefined, { counted: false, countedDay: '2026-10-25', countedFrom: null, status: 'taken' })
    await applyResult(free.id, okResult(free.id, { outcome: 'error', error: 'boom', pieces: [], costUsd: 0 }) as any, NOW)
    expect(await gifted(u.id)).toBe(1)
    expect(await credits(u.id)).toBe(0)
  })
})
