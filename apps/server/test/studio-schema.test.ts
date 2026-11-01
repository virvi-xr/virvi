import { describe, it, expect, beforeEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '../src/db/connection.js'
import {
  studioDesigns,
  studioPieces,
  studioRevisions,
  studioJobs,
  studioMessages,
  studioRenders,
  studioUsageDays,
  studioPayments,
  studioEntitlements,
  studioMistakeReports,
  studioPromptCredits,
  studioSetRenders,
  studioEmoteChecks,
} from '../src/db/schema.js'
import { TIER_LIMITS } from '../src/integrations/stripe.js'
import { BASE_EMOTES, orbitKey, revisionsKey, setViewKey } from '../src/studio/designs.js'
import { resetDb } from './helpers/db.js'
import { createUser } from './helpers/factories.js'

async function design() {
  const user = await createUser()
  const [d] = await db.insert(studioDesigns).values({ ownerId: user.id, name: 'Neon cap', kind: 'wearable', agent: 'claude' }).returning()
  return { user, d }
}

describe('design studio schema', () => {
  beforeEach(resetDb)

  it('studio tables accept a design with a piece, revision, job, message, render and usage day', async () => {
    const { user, d } = await design()
    expect(d.status).toBe('idle')
    const [job] = await db.insert(studioJobs).values({ designId: d.id, type: 'prompt', payload: { type: 'prompt' } }).returning()
    expect(job.status).toBe('queued')
    expect(job.counted).toBe(false)
    const [piece] = await db.insert(studioPieces).values({ designId: d.id, category: 'hat', name: 'Neon cap' }).returning()
    const [rev] = await db.insert(studioRevisions).values({
      pieceId: piece.id, number: 1, jobId: job.id, changeKind: 'new', meta: { name: 'Neon cap' },
      checker: { pass: true, failures: [], warnings: [] }, files: ['pieces/hat/cap_male.glb'],
    }).returning()
    await db.update(studioPieces).set({ latestRevisionId: rev.id }).where(eq(studioPieces.id, piece.id))
    await db.insert(studioMessages).values({ designId: d.id, role: 'agent', agent: 'claude', text: 'Done', jobId: job.id })
    const [render] = await db.insert(studioRenders).values({ revisionId: rev.id, viewKey: 'spin-male-default', jobId: job.id, status: 'ready', frames: 36 }).returning()
    await db.insert(studioUsageDays).values({ userId: user.id, day: '2026-10-25', prompts: 1, costUsd: 0.74 })

    const [p] = await db.select().from(studioPieces).where(eq(studioPieces.id, piece.id))
    expect(p.latestRevisionId).toBe(rev.id)
    expect(render.frames).toBe(36)
    const [u] = await db.select().from(studioUsageDays)
    expect(u).toMatchObject({ day: '2026-10-25', prompts: 1, costUsd: 0.74 })
    expect((await db.select().from(studioMessages))[0].text).toBe('Done')
  })

  it('one piece per category per design', async () => {
    const { d } = await design()
    await db.insert(studioPieces).values({ designId: d.id, category: 'hat', name: 'a' })
    await expect(db.insert(studioPieces).values({ designId: d.id, category: 'hat', name: 'b' })).rejects.toThrow(/unique|duplicate/i)
  })

  it('one open prompt job per design', async () => {
    const { d } = await design()
    await db.insert(studioJobs).values({ designId: d.id, type: 'prompt', payload: {} })
    await expect(db.insert(studioJobs).values({ designId: d.id, type: 'prompt', payload: {} })).rejects.toThrow(/unique|duplicate/i)
    await db.insert(studioJobs).values({ designId: d.id, type: 'render', payload: {} })
    await db.insert(studioJobs).values({ designId: d.id, type: 'prompt', status: 'done', payload: {} })
  })

  it('plan limits carry the studio allowances', () => {
    expect(TIER_LIMITS.free).toMatchObject({ studioPromptsPerDay: 3, studioDailyCostCeilingUsd: 6, studioOpenDesigns: 1 })
    expect(TIER_LIMITS.creator).toMatchObject({ studioPromptsPerDay: 15, studioDailyCostCeilingUsd: 30, studioOpenDesigns: Infinity })
    expect(TIER_LIMITS.pro).toMatchObject({ studioPromptsPerDay: 40, studioDailyCostCeilingUsd: 75 })
    expect(TIER_LIMITS.studio).toMatchObject({ studioPromptsPerDay: 100, studioDailyCostCeilingUsd: 200 })
    expect(TIER_LIMITS.enterprise).toMatchObject({ studioPromptsPerDay: 300, studioDailyCostCeilingUsd: 600 })
  })

  it('payment tables hold one entitlement per revision and one report per entitlement', async () => {
    const { user, d } = await design()
    expect(d.finalizedAt).toBeNull()
    const [job] = await db.insert(studioJobs).values({ designId: d.id, type: 'prompt', payload: {}, countedFrom: 'credit' }).returning()
    expect(job.countedFrom).toBe('credit')
    const [piece] = await db.insert(studioPieces).values({ designId: d.id, category: 'hat', name: 'Neon cap' }).returning()
    const [rev] = await db.insert(studioRevisions).values({ pieceId: piece.id, number: 1, jobId: job.id, changeKind: 'new', meta: {}, files: [] }).returning()
    const [pay] = await db.insert(studioPayments).values({ userId: user.id, designId: d.id, kind: 'finalize', amountCents: 2900 }).returning()
    expect(pay).toMatchObject({ status: 'pending', lines: [], prompts: 0, refundedCents: 0, stripeSessionId: null })
    const ent = { revisionId: rev.id, paymentId: pay.id, userId: user.id, designId: d.id, category: 'hat', kind: 'first', amountCents: 2900, status: 'packaging' }
    const [e] = await db.insert(studioEntitlements).values(ent).returning()
    await expect(db.insert(studioEntitlements).values(ent)).rejects.toMatchObject({ code: '23505' })
    const report = { entitlementId: e.id, userId: user.id, text: 'the sleeve clips', refundCents: 0, status: 'waived' }
    await db.insert(studioMistakeReports).values(report)
    await expect(db.insert(studioMistakeReports).values(report)).rejects.toMatchObject({ code: '23505' })
    const [c] = await db.insert(studioPromptCredits).values({ userId: user.id }).returning()
    expect(c.balance).toBe(0)
  })

  it('builds the set key from every piece, in a stable order', () => {
    expect(revisionsKey([{ latestRevisionId: 'b' }, { latestRevisionId: null }, { latestRevisionId: 'a' }])).toBe('a,b')
    expect(revisionsKey([])).toBe('')
    expect(setViewKey('emote', { bodyShape: 'female', outfit: 'default', emote: null })).toBe('walk-female-default-own')
    expect(setViewKey('wearable', { bodyShape: 'male', outfit: 'outfit-2', emote: 'run' })).toBe('walk-male-outfit-2-run')
    expect(orbitKey('female')).toBe('orbit-female')
    expect(BASE_EMOTES).toEqual(['idle', 'wave', 'dance', 'clap', 'walk', 'run', 'jump'])
  })

  it('set renders and emote checks hold one row per design, revisions and view', async () => {
    const { d } = await design()
    const [job] = await db.insert(studioJobs).values({ designId: d.id, type: 'render', payload: {} }).returning()
    expect(job.background).toBe(false)
    const row = { designId: d.id, revisions: 'a,b', viewKey: 'walk-male-default-run', jobId: job.id, status: 'queued' }
    const [r] = await db.insert(studioSetRenders).values(row).returning()
    expect(r).toMatchObject({ frames: 0, fps: null })
    await expect(db.insert(studioSetRenders).values(row)).rejects.toMatchObject({ code: '23505' })
    const check = { designId: d.id, revisions: 'a,b', emote: 'run', bodyShape: 'male', state: 'fine' }
    await db.insert(studioEmoteChecks).values(check)
    await expect(db.insert(studioEmoteChecks).values(check)).rejects.toMatchObject({ code: '23505' })
    await db.delete(studioDesigns).where(eq(studioDesigns.id, d.id))
    expect(await db.select().from(studioSetRenders)).toEqual([])
  })
})
