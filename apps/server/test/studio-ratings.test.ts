import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest'
import { and, eq } from 'drizzle-orm'
import { db } from '../src/db/connection.js'
import { studioDesigns, studioJobs, studioMessages, studioPauses, studioPromptCredits, studioRatings, studioUsageDays, users } from '../src/db/schema.js'
import { config } from '../src/config.js'
import { memoryStudioStore, setStudioStore } from '../src/studio/store.js'
import { setMachineDeps } from '../src/studio/machines.js'
import { recordCost, utcDay } from '../src/studio/quota.js'
import { feedbackText, parseRating } from '../src/studio/ratings.js'
import { resetDb } from './helpers/db.js'
import { testApp, createUser, tokenFor, type TestUser } from './helpers/factories.js'
import { addRevision, createDesign, fakeFly, issueWorker, okResult } from './helpers/studio.js'
import { issueTrialSession } from '../src/auth/trial.js'

const S = '/api/studio'

describe('feedbackText and parseRating', () => {
  it('builds the try-again prompt in the owner’s voice from the tags and note', () => {
    expect(feedbackText(['Neon Cap'], ['mismatch', 'broken'], 'The visor should be green.'))
      .toBe('I’m not happy with your change to Neon Cap: it doesn’t match what I asked and looks broken or clips. The visor should be green. Please try again.')
    expect(feedbackText(['Cap', 'Mask', 'Boots'], [], null)).toBe('I’m not happy with your change to Cap, Mask and Boots. Please try again.')
    expect(feedbackText(['Cap'], ['other'], null)).toBe('I’m not happy with your change to Cap: it isn’t right. Please try again.')
    // "Something else" alongside real tags says nothing more
    expect(feedbackText(['Cap'], ['size', 'other'], 'x')).toBe('I’m not happy with your change to Cap: it is the wrong size or in the wrong place. x Please try again.')
  })

  it('checks a rating body: a 👍 keeps no tags or note, tags are known ones in a fixed order', () => {
    expect(parseRating({ rating: 'up', tags: ['broken'], note: 'x' })).toEqual({ rating: 'up', tags: [], note: null })
    expect(parseRating({ rating: 'down', tags: ['slow', 'broken'], note: '  ' })).toEqual({ rating: 'down', tags: ['broken', 'slow'], note: null })
    expect(parseRating({ rating: 'meh' })).toMatch(/rating/)
    expect(parseRating({ rating: 'down', tags: ['ugly'] })).toMatch(/tags/)
    expect(parseRating({ rating: 'down', note: 'x'.repeat(501) })).toMatch(/note/)
  })
})

describe('rating Design Studio revisions', () => {
  let app: Awaited<ReturnType<typeof testApp>>
  let owner: TestUser
  let other: TestUser
  let admin: TestUser
  const prev = { enabled: config.studioEnabled, image: config.studioWorkerImage }
  beforeAll(() => {
    ;(config as any).studioEnabled = true
    ;(config as any).studioWorkerImage = 'registry.fly.io/vlm-studio-worker:test'
  })
  afterAll(() => {
    ;(config as any).studioEnabled = prev.enabled
    ;(config as any).studioWorkerImage = prev.image
    setStudioStore(null)
    setMachineDeps(null)
  })
  beforeEach(async () => {
    await resetDb()
    setStudioStore(memoryStudioStore())
    setMachineDeps({ fly: fakeFly() })
    app = await testApp()
    owner = await createUser({ name: 'Olive Owner' })
    other = await createUser()
    admin = await createUser({ role: 'admin' })
  })

  const as = (u: TestUser) => ({ authorization: `Bearer ${tokenFor(u)}` })
  const rate = (u: TestUser | string, designId: string, jobId: string, body: unknown) => app.inject({
    method: 'PUT', url: `${S}/designs/${designId}/revisions/${jobId}/rating`,
    headers: typeof u === 'string' ? { authorization: `Bearer ${u}` } : as(u), payload: body as any,
  })
  const tryAgain = (u: TestUser, designId: string, jobId: string) =>
    app.inject({ method: 'POST', url: `${S}/designs/${designId}/revisions/${jobId}/try-again`, headers: as(u) })
  const detail = async (u: TestUser, designId: string) => (await app.inject({ method: 'GET', url: `${S}/designs/${designId}`, headers: as(u) })).json()

  /** A prompt from the owner that the worker answers by changing the hat: a revision, as the real flow makes it. */
  async function revision(design: { id: string }, text = 'a neon cap with a glowing visor') {
    const res = await app.inject({ method: 'POST', url: `${S}/designs/${design.id}/prompts`, headers: as(owner), payload: { text } })
    expect(res.statusCode).toBe(202)
    const jobId = res.json().jobId as string
    const [d] = await db.select().from(studioDesigns).where(eq(studioDesigns.id, design.id))
    const token = await issueWorker(d, d.machineId ?? 'm-test')
    await db.update(studioJobs).set({ status: 'taken', takenAt: new Date() }).where(eq(studioJobs.id, jobId))
    const done = await app.inject({ method: 'POST', url: `/api/studio/worker/jobs/${jobId}/result`, headers: { authorization: `Bearer ${token}` }, payload: okResult(jobId, { model: 'gpt-x' }) as any })
    expect(done.statusCode).toBe(204)
    return jobId
  }

  it('the owner rates a revision, changes it to 👎 with tags and a note, and clears it; the detail shows each', async () => {
    const d = await createDesign(owner)
    const jobId = await revision(d)
    expect((await detail(owner, d.id)).revisions).toEqual([{ jobId, categories: ['hat'], rating: null, tags: [], note: null, tryAgain: null }])

    const up = await rate(owner, d.id, jobId, { rating: 'up' })
    expect(up.statusCode).toBe(200)
    expect(up.json()).toMatchObject({ jobId, rating: 'up', tryAgain: null })

    const down = await rate(owner, d.id, jobId, { rating: 'down', tags: ['broken'], note: 'The visor clips the hair.' })
    expect(down.json()).toMatchObject({ rating: 'down', tags: ['broken'], note: 'The visor clips the hair.', tryAgain: 'available' })
    const rows = await db.select().from(studioRatings)
    expect(rows).toHaveLength(1) // one rating per user per revision
    // stored with the revision's kind, agent, model, prompt and cost
    expect(rows[0]).toMatchObject({ kind: 'wearable', agent: 'claude', model: 'gpt-x', prompt: 'a neon cap with a glowing visor', costUsd: 0.74, userId: owner.id })

    expect((await detail(owner, d.id)).revisions[0]).toMatchObject({ rating: 'down', tags: ['broken'] })
    const cleared = await app.inject({ method: 'DELETE', url: `${S}/designs/${d.id}/revisions/${jobId}/rating`, headers: as(owner) })
    expect(cleared.statusCode).toBe(204)
    expect(await db.select().from(studioRatings)).toHaveLength(0)
    expect((await detail(owner, d.id)).revisions[0].rating).toBeNull()
  })

  it('refuses a bad body, and a job that is no revision of this design', async () => {
    const d = await createDesign(owner)
    const jobId = await revision(d)
    expect((await rate(owner, d.id, jobId, { rating: 'down', tags: ['ugly'] })).statusCode).toBe(400)
    // a render job, a prompt with no pieces, another design's revision, nonsense
    const [render] = await db.insert(studioJobs).values({ designId: d.id, type: 'render', status: 'done', payload: {} }).returning()
    const [empty] = await db.insert(studioJobs).values({ designId: d.id, type: 'prompt', status: 'done', payload: {} }).returning()
    const mine2 = await createDesign(owner, { name: 'Other' })
    const rev2 = await addRevision(mine2, 'hat')
    for (const id of [render.id, empty.id, rev2.jobId]) expect((await rate(owner, d.id, id, { rating: 'up' })).statusCode).toBe(404)
    expect((await rate(owner, d.id, 'nope', { rating: 'up' })).statusCode).toBe(404)
    expect(await db.select().from(studioRatings)).toHaveLength(0)
  })

  it("nobody else rates the owner's revisions: another account and Virvi support get 404, support still sees the ratings", async () => {
    const d = await createDesign(owner)
    const jobId = await revision(d)
    await rate(owner, d.id, jobId, { rating: 'down', tags: ['size'] })
    for (const u of [other, admin]) {
      expect((await rate(u, d.id, jobId, { rating: 'up' })).statusCode).toBe(404)
      expect((await app.inject({ method: 'DELETE', url: `${S}/designs/${d.id}/revisions/${jobId}/rating`, headers: as(u) })).statusCode).toBe(404)
      expect((await tryAgain(u, d.id, jobId)).statusCode).toBe(404)
    }
    const seen = await detail(admin, d.id)
    expect(seen.support).toBeTruthy()
    expect(seen.revisions[0]).toMatchObject({ rating: 'down', tags: ['size'] })
    expect(await db.select().from(studioRatings)).toHaveLength(1)
  })

  it('a trial rates its own design', async () => {
    const t = await createUser({ email: null })
    await db.update(users).set({ isTrial: true, trialLastActiveAt: new Date() }).where(eq(users.id, t.id))
    const { accessToken } = issueTrialSession(app, { id: t.id, displayName: t.displayName, role: 'creator', trialLastActiveAt: new Date() })
    const d = await createDesign(t as TestUser)
    const rev = await addRevision(d, 'hat')
    const res = await rate(accessToken, d.id, rev.jobId, { rating: 'up' })
    expect(res.statusCode).toBe(200)
    expect(res.json().rating).toBe('up')
  })

  describe('Try again with this feedback', () => {
    const usageRows = async () => db.select().from(studioUsageDays).where(eq(studioUsageDays.userId, owner.id))

    it('sends a free prompt built from the tags and note, once per 👎’d revision', async () => {
      const d = await createDesign(owner)
      const jobId = await revision(d)
      const before = (await usageRows())[0].prompts
      expect((await tryAgain(owner, d.id, jobId)).statusCode).toBe(409) // nothing to go on without a 👎
      await rate(owner, d.id, jobId, { rating: 'down', tags: ['mismatch'], note: 'Make the visor green.' })

      const res = await tryAgain(owner, d.id, jobId)
      expect(res.statusCode).toBe(202)
      const [job] = await db.select().from(studioJobs).where(eq(studioJobs.id, res.json().jobId))
      const text = 'I’m not happy with your change to Neon Cap: it doesn’t match what I asked. Make the visor green. Please try again.'
      expect(job).toMatchObject({ feedbackFor: jobId, counted: false, countedFrom: null, byAdminId: null })
      expect(job.payload).toMatchObject({ prompt: text, check: true, limits: { timeoutSec: 1500, maxTurns: 80, costCeilingUsd: 3 } })
      // the owner's own words in the conversation, not support's
      const [msg] = await db.select().from(studioMessages).where(and(eq(studioMessages.designId, d.id), eq(studioMessages.text, text)))
      expect(msg).toMatchObject({ role: 'user', byAdminId: null })
      expect((await usageRows())[0].prompts).toBe(before) // free

      // the revision's one free try-again is spent, even after clearing and 👎 again
      await db.update(studioJobs).set({ status: 'done' }).where(eq(studioJobs.id, job.id))
      expect((await tryAgain(owner, d.id, jobId)).json()).toMatchObject({ code: 'already_tried' })
      await app.inject({ method: 'DELETE', url: `${S}/designs/${d.id}/revisions/${jobId}/rating`, headers: as(owner) })
      await rate(owner, d.id, jobId, { rating: 'down' })
      expect((await tryAgain(owner, d.id, jobId)).statusCode).toBe(409)
      expect((await detail(owner, d.id)).revisions.find((r: any) => r.jobId === jobId).tryAgain).toBe('used')
    })

    it('goes even when the owner is out of prompts, and takes nothing from them', async () => {
      const d = await createDesign(owner)
      const jobId = await revision(d)
      await rate(owner, d.id, jobId, { rating: 'down', tags: ['quality'] })
      await db.update(studioUsageDays).set({ prompts: 3 }).where(eq(studioUsageDays.userId, owner.id))
      expect((await app.inject({ method: 'POST', url: `${S}/designs/${d.id}/prompts`, headers: as(owner), payload: { text: 'more' } })).statusCode).toBe(429)
      expect((await tryAgain(owner, d.id, jobId)).statusCode).toBe(202)
      expect((await usageRows())[0].prompts).toBe(3)
    })

    it('keeps the per-prompt safety limits: busy, paused, past the cost ceiling (without taking a gift)', async () => {
      const d = await createDesign(owner)
      const jobId = await revision(d)
      await rate(owner, d.id, jobId, { rating: 'down' })
      // one prompt at a time
      const [open] = await db.insert(studioJobs).values({ designId: d.id, type: 'prompt', status: 'queued', payload: {} }).returning()
      expect((await tryAgain(owner, d.id, jobId)).json()).toMatchObject({ code: 'busy' })
      await db.delete(studioJobs).where(eq(studioJobs.id, open.id))
      // past the day's cost ceiling: refused, and the gifted prompt stays
      await db.insert(studioPromptCredits).values({ userId: owner.id, gifted: 2 })
      await recordCost(owner.id, utcDay(new Date()), 100)
      expect((await tryAgain(owner, d.id, jobId)).json()).toMatchObject({ error: 'cost_ceiling' })
      expect((await db.select().from(studioPromptCredits).where(eq(studioPromptCredits.userId, owner.id)))[0].gifted).toBe(2)
      await db.delete(studioUsageDays)
      // a paused account can't
      await db.insert(studioPauses).values({ userId: owner.id })
      expect((await tryAgain(owner, d.id, jobId)).statusCode).toBe(403)
      await db.delete(studioPauses)
      expect((await tryAgain(owner, d.id, jobId)).statusCode).toBe(202)
    })
  })
})
