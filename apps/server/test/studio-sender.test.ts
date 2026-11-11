import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest'
import { and, eq } from 'drizzle-orm'
import { db } from '../src/db/connection.js'
import { studioDesignMembers, studioDesigns, studioJobs, studioMessages, studioUsageDays } from '../src/db/schema.js'
import { config } from '../src/config.js'
import { initBus } from '../src/realtime/bus.js'
import { memoryStudioStore, setStudioStore } from '../src/studio/store.js'
import { setMachineDeps } from '../src/studio/machines.js'
import { failJobs } from '../src/studio/results.js'
import { setPromptHelper } from '../src/studio/prompt-help.js'
import { utcDay } from '../src/studio/quota.js'
import { resetDb } from './helpers/db.js'
import { testApp, createUser, tokenFor, type TestUser } from './helpers/factories.js'
import { createDesign, fakeFly, issueWorker, okResult } from './helpers/studio.js'

const S = '/api/studio'

/** LIV-159: a prompt counts against, costs, and is named for the person who sent it, not the design's owner. */
describe('the sender pays and is named', () => {
  let app: Awaited<ReturnType<typeof testApp>>
  let owner: TestUser
  let collab: TestUser
  let published: { topic: string; data: any }[]
  const prev = { enabled: config.studioEnabled, image: config.studioWorkerImage, key: config.anthropicApiKey }
  beforeAll(() => {
    ;(config as any).studioEnabled = true
    ;(config as any).studioWorkerImage = 'registry.fly.io/vlm-studio-worker:test'
    ;(config as any).anthropicApiKey = null
  })
  afterAll(() => {
    ;(config as any).studioEnabled = prev.enabled
    ;(config as any).studioWorkerImage = prev.image
    ;(config as any).anthropicApiKey = prev.key
    setStudioStore(null)
    setMachineDeps(null)
    setPromptHelper(null)
  })
  beforeEach(async () => {
    await resetDb()
    setStudioStore(memoryStudioStore())
    setMachineDeps({ fly: fakeFly() })
    app = await testApp()
    published = []
    initBus({ publish: (topic, data) => { published.push({ topic, data }) }, subscribe: () => {}, unsubscribe: () => {} })
    owner = await createUser({ name: 'Olive Owner' })
    collab = await createUser({ name: 'Cora Collab' })
  })

  const as = (u: TestUser) => ({ authorization: `Bearer ${tokenFor(u)}` })
  const join = (designId: string, u: TestUser, role: 'collaborator' | 'viewer' = 'collaborator') =>
    db.insert(studioDesignMembers).values({ designId, userId: u.id, role })
  const shared = async () => {
    const d = await createDesign(owner)
    await join(d.id, collab)
    return d
  }
  const prompt = (u: TestUser, id: string, payload: Record<string, unknown> = { text: 'make the visor red' }) =>
    app.inject({ method: 'POST', url: `${S}/designs/${id}/prompts`, headers: as(u), payload })
  const usageOf = async (u: TestUser) =>
    (await db.select().from(studioUsageDays).where(and(eq(studioUsageDays.userId, u.id), eq(studioUsageDays.day, utcDay(new Date())))))[0] ?? null
  const job = async (id: string) => (await db.select().from(studioJobs).where(eq(studioJobs.id, id)))[0]
  const detail = async (u: TestUser, id: string) => (await app.inject({ method: 'GET', url: `${S}/designs/${id}`, headers: as(u) })).json()

  /** The worker answers the job. */
  async function finish(designId: string, jobId: string, over: Record<string, unknown> = {}) {
    const [d] = await db.select().from(studioDesigns).where(eq(studioDesigns.id, designId))
    const token = await issueWorker(d, d.machineId ?? 'm-test')
    await db.update(studioJobs).set({ status: 'taken', takenAt: new Date() }).where(eq(studioJobs.id, jobId))
    const done = await app.inject({
      method: 'POST', url: `/api/studio/worker/jobs/${jobId}/result`, headers: { authorization: `Bearer ${token}` }, payload: okResult(jobId, over) as any,
    })
    expect(done.statusCode).toBe(204)
  }

  it('a collaborator’s prompt counts on the collaborator, not the owner', async () => {
    const d = await shared()
    const res = await prompt(collab, d.id)
    expect(res.statusCode).toBe(202)
    expect(await job(res.json().jobId)).toMatchObject({ userId: collab.id, counted: true, countedFrom: 'allowance' })
    const [m] = await db.select().from(studioMessages).where(eq(studioMessages.designId, d.id))
    expect(m.userId).toBe(collab.id)
    expect(await usageOf(collab)).toMatchObject({ prompts: 1 })
    expect(await usageOf(owner)).toBeNull()
  })

  it('its cost and a give-back go to the collaborator', async () => {
    const d = await shared()
    const first = (await prompt(collab, d.id)).json().jobId
    await finish(d.id, first, { costUsd: 0.74 })
    expect(await usageOf(collab)).toMatchObject({ prompts: 1, costUsd: 0.74 })
    // a worker error gives the prompt back to where it came from: the collaborator's allowance
    const second = (await prompt(collab, d.id, { text: 'now add wings' })).json().jobId
    expect(await usageOf(collab)).toMatchObject({ prompts: 2 })
    await finish(d.id, second, { outcome: 'error', error: 'boom', pieces: [], costUsd: 0 })
    expect(await usageOf(collab)).toMatchObject({ prompts: 1 })
    // and so does a job that is lost
    const third = (await prompt(collab, d.id, { text: 'and a tail' })).json().jobId
    expect(await usageOf(collab)).toMatchObject({ prompts: 2 })
    await failJobs([third], 'The studio machine stopped answering.', new Date())
    expect(await usageOf(collab)).toMatchObject({ prompts: 1 })
    expect(await usageOf(owner)).toBeNull()
  })

  it('a collaborator over their allowance is refused even when the owner has prompts left', async () => {
    const d = await shared()
    await db.insert(studioUsageDays).values({ userId: collab.id, day: utcDay(new Date()), prompts: 3 })
    const res = await prompt(collab, d.id)
    expect(res.statusCode).toBe(429)
    expect(res.json()).toMatchObject({ code: 'allowance' })
    expect(await usageOf(owner)).toBeNull()
    expect((await prompt(owner, d.id)).statusCode).toBe(202)
  })

  it('try-again limit is per sender', async () => {
    const d = await shared()
    const jobId = (await prompt(owner, d.id, { text: 'a neon cap' })).json().jobId
    await finish(d.id, jobId)
    for (const u of [owner, collab]) {
      const r = await app.inject({ method: 'PUT', url: `${S}/designs/${d.id}/revisions/${jobId}/rating`, headers: as(u), payload: { rating: 'down' } })
      expect(r.statusCode).toBe(200)
    }
    // the collaborator used their 3 today, on someone else's design
    const elsewhere = await createDesign(await createUser())
    for (let i = 0; i < 3; i++) {
      await db.insert(studioJobs).values({ designId: elsewhere.id, type: 'prompt', status: 'done', payload: {}, feedbackFor: crypto.randomUUID(), userId: collab.id })
    }
    expect((await detail(collab, d.id)).revisions[0].tryAgain).toBeNull()
    expect((await detail(owner, d.id)).revisions[0].tryAgain).toBe('available')
    const refused = await app.inject({ method: 'POST', url: `${S}/designs/${d.id}/revisions/${jobId}/try-again`, headers: as(collab) })
    expect(refused.statusCode).toBe(429)
    expect(refused.json()).toMatchObject({ code: 'try_again_limit' })
    const res = await app.inject({ method: 'POST', url: `${S}/designs/${d.id}/revisions/${jobId}/try-again`, headers: as(owner) })
    expect(res.statusCode).toBe(202)
    expect(await job(res.json().jobId)).toMatchObject({ userId: owner.id, feedbackFor: jobId })
  })

  it('prompt-help counts on the sender', async () => {
    const d = await shared()
    setPromptHelper(async () => JSON.stringify({ prompt: 'A red visor on the neon cap.', questions: [], note: '' }))
    const res = await app.inject({ method: 'POST', url: `${S}/designs/${d.id}/prompt-help`, headers: as(collab), payload: { text: 'red visor' } })
    expect(res.statusCode).toBe(200)
    expect(await usageOf(collab)).toMatchObject({ promptHelps: 1, prompts: 0 })
    expect(await usageOf(owner)).toBeNull()
  })

  it('second member’s prompt while one runs is busy and uncounted', async () => {
    const d = await shared()
    expect((await prompt(owner, d.id)).statusCode).toBe(202)
    const res = await prompt(collab, d.id, { text: 'and a tail' })
    expect(res.statusCode).toBe(409)
    expect(res.json()).toMatchObject({ code: 'busy' })
    expect(await usageOf(collab)).toBeNull()
  })

  it('on a shared design the agent’s prompt starts with the sender’s name; on a solo design it doesn’t', async () => {
    const solo = await createDesign(owner)
    const s = (await prompt(owner, solo.id, { text: 'a neon cap' })).json().jobId
    expect((await job(s)).payload).toMatchObject({ prompt: 'a neon cap' })

    const d = await shared()
    const c = (await prompt(collab, d.id)).json().jobId
    expect((await job(c)).payload).toMatchObject({ prompt: 'Cora Collab: make the visor red' })
    // the conversation keeps the words as they were sent
    const [m] = await db.select().from(studioMessages).where(eq(studioMessages.designId, d.id))
    expect(m.text).toBe('make the visor red')
    await finish(d.id, c, { outcome: 'ceiling' })
    // Continue is the server's words: no name
    const cont = (await prompt(owner, d.id, { continue: true })).json().jobId
    expect((await job(cont)).payload).toMatchObject({ prompt: 'Continue where you stopped.' })
    await finish(d.id, cont)
    const o = (await prompt(owner, d.id, { text: 'now add wings' })).json().jobId
    expect((await job(o)).payload).toMatchObject({ prompt: 'Olive Owner: now add wings' })
  })

  it('detail messages carry sender names; old rows without user_id show the owner', async () => {
    const d = await shared()
    await db.insert(studioMessages).values({ designId: d.id, role: 'user', text: 'an old prompt', createdAt: new Date(Date.now() - 60_000) })
    await db.insert(studioMessages).values({ designId: d.id, role: 'agent', agent: 'claude', text: 'Done.', createdAt: new Date(Date.now() - 50_000) })
    const jobId = (await prompt(collab, d.id)).json().jobId
    const queued = published.find((p) => p.data?.type === 'job' && p.data.jobId === jobId)
    expect(queued?.data).toMatchObject({ status: 'queued', senderName: 'Cora Collab' })
    const got = await detail(owner, d.id)
    expect(got.messages.map((m: any) => [m.text, m.sender])).toEqual([
      ['an old prompt', { userId: owner.id, displayName: 'Olive Owner' }],
      ['Done.', null],
      ['make the visor red', { userId: collab.id, displayName: 'Cora Collab' }],
    ])
    expect(got.activeJob).toMatchObject({ id: jobId, senderName: 'Cora Collab' })
  })
})
