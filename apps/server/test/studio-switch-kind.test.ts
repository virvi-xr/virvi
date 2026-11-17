import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest'
import { and, eq } from 'drizzle-orm'
import { db } from '../src/db/connection.js'
import { studioDesigns, studioJobs, studioMessages, studioSetRenders } from '../src/db/schema.js'
import { config } from '../src/config.js'
import { jobFileKey, memoryStudioStore, setStudioStore } from '../src/studio/store.js'
import { setMachineDeps } from '../src/studio/machines.js'
import { promptStatus } from '../src/studio/quota.js'
import { parseResult } from '../src/studio/results.js'
import { resetDb } from './helpers/db.js'
import { testApp, createUser, tokenFor, type TestUser } from './helpers/factories.js'
import { fakeFly, issueWorker, okResult } from './helpers/studio.js'

const S = '/api/studio'

/** LIV-183: an empty design switches between wearable and emote when the person asks for the other kind. */
describe('studio design kind switch', () => {
  let app: Awaited<ReturnType<typeof testApp>>
  let store: ReturnType<typeof memoryStudioStore>
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
    store = memoryStudioStore()
    setStudioStore(store)
    setMachineDeps({ fly: fakeFly() })
    app = await testApp()
  })

  const as = (u: TestUser) => ({ authorization: `Bearer ${tokenFor(u)}` })
  const prompted = async (u: TestUser, kind: string, text = 'make me a fart emote') => {
    const d = (await app.inject({ method: 'POST', url: `${S}/designs`, headers: as(u), payload: { kind, agent: 'claude' } })).json()
    const res = await app.inject({ method: 'POST', url: `${S}/designs/${d.id}/prompts`, headers: as(u), payload: { text } })
    expect(res.statusCode).toBe(202)
    return { designId: d.id as string, jobId: res.json().jobId as string }
  }
  const finish = async (jobId: string, result: Record<string, unknown>) => {
    const [job] = await db.select().from(studioJobs).where(eq(studioJobs.id, jobId))
    const [d] = await db.select().from(studioDesigns).where(eq(studioDesigns.id, job.designId))
    const token = await issueWorker(d, d.machineId ?? 'm-test')
    await db.update(studioJobs).set({ status: 'taken', takenAt: new Date() }).where(eq(studioJobs.id, jobId))
    const res = await app.inject({ method: 'POST', url: `/api/studio/worker/jobs/${jobId}/result`, headers: { authorization: `Bearer ${token}` }, payload: result as any })
    expect(res.statusCode).toBe(204)
  }
  const switchResult = (jobId: string, to = 'emote') => okResult(jobId, { outcome: 'no_change', reply: 'This becomes an emote design.', pieces: [], switchKind: to })
  const hatResult = async (designId: string, jobId: string) => {
    const files = ['pieces/hat/cap_male.glb', 'pieces/hat/cap_female.glb', 'pieces/hat/piece.json', 'checks/hat.txt']
    for (const f of files) await store.put(jobFileKey(designId, jobId, f), Buffer.alloc(10), 'application/octet-stream')
    return okResult(jobId, { pieces: [{ category: 'hat', changed: true, changeKind: 'new', meta: { name: 'Cap' }, checker: { pass: true, failures: 0, warnings: 0 }, files, renders: { 'spin-male-default': 36 } }] })
  }
  const design = async (id: string) => (await db.select().from(studioDesigns).where(eq(studioDesigns.id, id)))[0]
  const prompts = async (id: string) => db.select().from(studioJobs).where(and(eq(studioJobs.designId, id), eq(studioJobs.type, 'prompt'))).orderBy(studioJobs.createdAt)
  const notes = async (id: string) => (await db.select().from(studioMessages).where(eq(studioMessages.designId, id))).filter((m) => m.role === 'system').map((m) => m.text)

  it('only takes a switch on a no_change result, to wearable or emote', () => {
    expect(parseResult({ outcome: 'no_change', pieces: [], switchKind: 'emote' }).ok).toBe(true)
    expect(parseResult({ outcome: 'no_change', pieces: [], switchKind: 'scene' }).ok).toBe(false)
    expect(parseResult({ outcome: 'ok', pieces: [], switchKind: 'emote' }).ok).toBe(false)
  })

  it('an empty wearable design becomes an emote design and runs the request again, free', async () => {
    const u = await createUser()
    const { designId, jobId } = await prompted(u, 'wearable')
    const used = (await promptStatus(u.id, new Date())).used
    await db.insert(studioSetRenders).values({ designId, revisions: 'x', viewKey: 'walk-male-default-dance', status: 'failed', jobId })
    await finish(jobId, switchResult(jobId))
    const d = await design(designId)
    expect(d.kind).toBe('emote')
    expect(d.status).toBe('building')
    expect(await notes(designId)).toContain('This design is now an emote design. Building it now.')
    expect(await db.select().from(studioSetRenders).where(eq(studioSetRenders.designId, designId))).toEqual([])
    const [first, again] = await prompts(designId)
    expect(again.status).toBe('queued')
    expect(again.counted).toBe(false)
    const payload = again.payload as Record<string, unknown>
    expect(payload).toMatchObject({ kind: 'emote', check: false, switchedFrom: 'wearable', prompt: (first.payload as any).prompt })
    expect((await promptStatus(u.id, new Date())).used).toBe(used)  // the rerun uses no prompt
  })

  it('an emote design becomes a wearable design', async () => {
    const u = await createUser()
    const { designId, jobId } = await prompted(u, 'emote', 'make me a hat')
    await finish(jobId, switchResult(jobId, 'wearable'))
    expect((await design(designId)).kind).toBe('wearable')
  })

  it('a design with pieces never switches, and says to start a new design', async () => {
    const u = await createUser()
    const { designId, jobId } = await prompted(u, 'wearable', 'a cap')
    await finish(jobId, await hatResult(designId, jobId))
    const second = (await app.inject({ method: 'POST', url: `${S}/designs/${designId}/prompts`, headers: as(u), payload: { text: 'make me an emote' } })).json().jobId
    await finish(second, switchResult(second))
    expect((await design(designId)).kind).toBe('wearable')
    expect((await prompts(designId)).length).toBe(2)
    expect((await notes(designId)).join(' ')).toContain('Start a new emote design for that.')
  })

  it('a rerun never switches again', async () => {
    const u = await createUser()
    const { designId, jobId } = await prompted(u, 'wearable')
    await finish(jobId, switchResult(jobId))
    const again = (await prompts(designId))[1]
    await finish(again.id, switchResult(again.id, 'wearable'))
    expect((await design(designId)).kind).toBe('emote')
    expect((await prompts(designId)).length).toBe(2)
  })

  it('a scene design never switches', async () => {
    const u = await createUser()
    const { designId, jobId } = await prompted(u, 'scene', 'a fart emote')
    await finish(jobId, switchResult(jobId))
    expect((await design(designId)).kind).toBe('scene')
    expect((await prompts(designId)).length).toBe(1)
  })
})
