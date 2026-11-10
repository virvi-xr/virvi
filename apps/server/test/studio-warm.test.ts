import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '../src/db/connection.js'
import { studioDesigns, studioJobs, studioMessages, studioPauses, studioUsageDays, users } from '../src/db/schema.js'
import { config } from '../src/config.js'
import { issueTrialSession } from '../src/auth/trial.js'
import { memoryStudioStore, setStudioStore } from '../src/studio/store.js'
import { setMachineDeps } from '../src/studio/machines.js'
import { TRIAL_DAY, utcDay } from '../src/studio/quota.js'
import { sweepStudio } from '../src/studio/sweep.js'
import { WARM_EVERY_MS } from '../src/studio/warm.js'
import { resetDb } from './helpers/db.js'
import { testApp, createUser, tokenFor, type TestUser } from './helpers/factories.js'
import { createDesign, fakeFly, queueJob } from './helpers/studio.js'

const row = async (id: string) => (await db.select().from(studioDesigns).where(eq(studioDesigns.id, id)))[0]

describe('warming a design’s machine ahead of its prompt', () => {
  let app: Awaited<ReturnType<typeof testApp>>
  let owner: TestUser
  let fly: ReturnType<typeof fakeFly>
  const prev = { enabled: config.studioEnabled, image: config.studioWorkerImage, machines: config.studioMachines }
  beforeAll(() => {
    ;(config as any).studioEnabled = true
    ;(config as any).studioWorkerImage = 'registry.fly.io/vlm-studio-worker:test'
  })
  afterAll(() => {
    ;(config as any).studioEnabled = prev.enabled
    ;(config as any).studioWorkerImage = prev.image
    ;(config as any).studioMachines = prev.machines
    setStudioStore(null)
    setMachineDeps(null)
  })
  beforeEach(async () => {
    await resetDb()
    ;(config as any).studioMachines = prev.machines
    setStudioStore(memoryStudioStore())
    fly = fakeFly()
    setMachineDeps({ fly })
    app = await testApp()
    owner = await createUser()
  })
  const as = (u: TestUser) => ({ authorization: `Bearer ${tokenFor(u)}` })
  const warm = (id: string, headers: Record<string, string> = as(owner)) =>
    app.inject({ method: 'POST', url: `/api/studio/designs/${id}/warm`, headers })

  it('makes the machine with no job, using nothing and charging nothing', async () => {
    const d = await createDesign(owner)
    const res = await warm(d.id)
    expect(res.statusCode).toBe(204)
    expect(fly.calls.create).toHaveLength(1)
    const r = await row(d.id)
    expect(r.machineId).toBe('m1')
    expect(r.warmedAt).not.toBeNull()
    expect(r.lastJobAt).toBeNull() // not a job: the design list's order and the sweep's job checks are untouched
    expect(await db.select().from(studioJobs)).toHaveLength(0)
    expect(await db.select().from(studioMessages)).toHaveLength(0)
    expect(await db.select().from(studioUsageDays)).toHaveLength(0)
    expect((await app.inject({ method: 'GET', url: '/api/studio/usage', headers: as(owner) })).json()).toMatchObject({ promptsLeft: 3 })
  })

  it('starts a stopped machine, at most once every 5 minutes', async () => {
    const d = await createDesign(owner)
    await warm(d.id)
    fly.machines.get('m1')!.state = 'stopped'
    expect((await warm(d.id)).statusCode).toBe(204)
    expect(fly.calls.start).toEqual([]) // warmed under 5 minutes ago
    await db.update(studioDesigns).set({ warmedAt: new Date(Date.now() - WARM_EVERY_MS - 1000) }).where(eq(studioDesigns.id, d.id))
    expect((await warm(d.id)).statusCode).toBe(204)
    expect(fly.calls.start).toEqual(['m1'])
    expect(fly.calls.create).toHaveLength(1)
  })

  it('once even when asked many times at once', async () => {
    const d = await createDesign(owner)
    const codes = (await Promise.all(Array.from({ length: 5 }, () => warm(d.id)))).map((r) => r.statusCode)
    expect(codes).toEqual([204, 204, 204, 204, 204])
    expect(fly.calls.create).toHaveLength(1)
  })

  it('does nothing while a job waits or runs: it has the machine coming already', async () => {
    const d = await createDesign(owner)
    await queueJob(d)
    expect((await warm(d.id)).statusCode).toBe(204)
    await queueJob(d, { type: 'render' }, { status: 'taken' })
    await db.update(studioJobs).set({ status: 'done' }).where(eq(studioJobs.type, 'prompt'))
    expect((await warm(d.id)).statusCode).toBe(204)
    expect(fly.calls.create).toHaveLength(0)
    expect((await row(d.id)).warmedAt).toBeNull()
  })

  it('does nothing for an account with no prompts left, or past its cost ceiling', async () => {
    const d = await createDesign(owner)
    await db.insert(studioUsageDays).values({ userId: owner.id, day: utcDay(new Date()), prompts: 3, costUsd: 0 })
    expect((await warm(d.id)).statusCode).toBe(204)
    await db.update(studioUsageDays).set({ prompts: 0, costUsd: 100 }).where(eq(studioUsageDays.userId, owner.id))
    expect((await warm(d.id)).statusCode).toBe(204)
    expect(fly.calls.create).toHaveLength(0)
    // with a prompt left again, it warms: the refusals didn't use up the 5 minutes
    await db.update(studioUsageDays).set({ costUsd: 0 }).where(eq(studioUsageDays.userId, owner.id))
    await warm(d.id)
    expect(fly.calls.create).toHaveLength(1)
  })

  it('does nothing for an archived design', async () => {
    const d = await createDesign(owner, { archivedAt: new Date() })
    expect((await warm(d.id)).statusCode).toBe(204)
    expect(fly.calls.create).toHaveLength(0)
  })

  it('does nothing when the worker is run by hand', async () => {
    ;(config as any).studioMachines = 'external'
    const d = await createDesign(owner)
    expect((await warm(d.id)).statusCode).toBe(204)
    expect(fly.calls.create).toHaveLength(0)
    expect((await row(d.id)).warmedAt).toBeNull()
  })

  it('refuses a paused account as it refuses its prompts', async () => {
    const d = await createDesign(owner)
    await db.insert(studioPauses).values({ userId: owner.id, pausedAt: new Date() })
    const res = await warm(d.id)
    expect(res.statusCode).toBe(403)
    expect(res.json()).toMatchObject({ code: 'studio_paused' })
    expect(fly.calls.create).toHaveLength(0)
  })

  it('is the owner’s alone, and Virvi support’s', async () => {
    const d = await createDesign(owner)
    const other = await createUser()
    expect((await warm(d.id, as(other))).statusCode).toBe(404)
    expect((await warm('not-a-uuid')).statusCode).toBe(404)
    expect((await app.inject({ method: 'POST', url: `/api/studio/designs/${d.id}/warm` })).statusCode).toBe(401)
    expect(fly.calls.create).toHaveLength(0)
    expect((await row(d.id)).warmedAt).toBeNull()
    // support may: their prompts are free, so the owner's empty allowance doesn't stop it
    await db.insert(studioUsageDays).values({ userId: owner.id, day: utcDay(new Date()), prompts: 3, costUsd: 0 })
    const admin = await createUser({ role: 'admin' })
    expect((await warm(d.id, as(admin))).statusCode).toBe(204)
    expect(fly.calls.create).toHaveLength(1)
  })

  it('works for a trial visitor with tries left, and not once they are used', async () => {
    const t = await createUser({ email: null })
    await db.update(users).set({ isTrial: true, trialLastActiveAt: new Date() }).where(eq(users.id, t.id))
    const { accessToken } = issueTrialSession(app, { id: t.id, displayName: t.displayName, role: 'creator', trialLastActiveAt: new Date() })
    const headers = { authorization: `Bearer ${accessToken}` }
    const used = await createDesign(t)
    await db.insert(studioUsageDays).values({ userId: t.id, day: TRIAL_DAY, prompts: config.trialPrompts, costUsd: 0 })
    expect((await warm(used.id, headers)).statusCode).toBe(204)
    expect(fly.calls.create).toHaveLength(0)
    await db.update(studioUsageDays).set({ prompts: 0 }).where(eq(studioUsageDays.userId, t.id))
    expect((await warm(used.id, headers)).statusCode).toBe(204)
    expect(fly.calls.create).toHaveLength(1)
  })

  it('a failed start answers 204 too: the prompt starts the machine itself', async () => {
    fly.failCreate = () => new Error('Fly is down')
    const d = await createDesign(owner)
    expect((await warm(d.id)).statusCode).toBe(204)
    expect((await row(d.id)).machineId).toBeNull()
  })

  it('the sweep keeps a machine warmed in the last 3 days, and destroys one idle longer', async () => {
    const old = new Date(Date.now() - 5 * 24 * 3600_000)
    const d = await createDesign(owner, { createdAt: old, lastJobAt: old })
    await warm(d.id)
    expect((await sweepStudio(new Date(), { fly })).destroyed).toBe(0)
    expect((await row(d.id)).machineId).toBe('m1')
    await db.update(studioDesigns).set({ warmedAt: new Date(Date.now() - 4 * 24 * 3600_000) }).where(eq(studioDesigns.id, d.id))
    expect((await sweepStudio(new Date(), { fly })).destroyed).toBe(1)
    expect((await row(d.id)).machineId).toBeNull()
  })
})
