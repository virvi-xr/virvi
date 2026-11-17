import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '../src/db/connection.js'
import { studioDesigns, studioJobs, studioMessages, studioPieces } from '../src/db/schema.js'
import { config } from '../src/config.js'
import { jobFileKey, memoryStudioStore, setStudioStore } from '../src/studio/store.js'
import { setMachineDeps } from '../src/studio/machines.js'
import { promptStatus } from '../src/studio/quota.js'
import { EMOTE_ALLOWANCE_BYTES } from '../src/studio/emote-size.js'
import { resetDb } from './helpers/db.js'
import { testApp, createUser, tokenFor, type TestUser } from './helpers/factories.js'
import { fakeFly, issueWorker, okResult } from './helpers/studio.js'

const S = '/api/studio'
const MB = 1024 * 1024

describe('studio emote allowance', () => {
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
  /** An emote design with a prompt sent: its job id and design id. */
  const prompted = async (u: TestUser, kind = 'emote') => {
    const d = (await app.inject({ method: 'POST', url: `${S}/designs`, headers: as(u), payload: { kind, agent: 'claude' } })).json()
    const jobId = (await app.inject({ method: 'POST', url: `${S}/designs/${d.id}/prompts`, headers: as(u), payload: { text: 'a squat with my fart sound' } })).json().jobId
    return { designId: d.id as string, jobId: jobId as string }
  }
  const finish = async (jobId: string, result: Record<string, unknown>) => {
    const [job] = await db.select().from(studioJobs).where(eq(studioJobs.id, jobId))
    const [d] = await db.select().from(studioDesigns).where(eq(studioDesigns.id, job.designId))
    const token = await issueWorker(d, d.machineId ?? 'm-test')
    await db.update(studioJobs).set({ status: 'taken', takenAt: new Date() }).where(eq(studioJobs.id, jobId))
    const res = await app.inject({ method: 'POST', url: `/api/studio/worker/jobs/${jobId}/result`, headers: { authorization: `Bearer ${token}` }, payload: result as any })
    expect(res.statusCode).toBe(204)
  }
  /** Stores an emote's files for the job and returns the result naming them. */
  const emoteResult = async (designId: string, jobId: string, glbBytes: number, soundBytes: number) => {
    const files = ['pieces/emote/squat.glb', 'pieces/emote/piece.json', 'pieces/emote/fart.mp3', 'checks/emote.txt']
    const sizes: Record<string, number> = { 'pieces/emote/squat.glb': glbBytes, 'pieces/emote/fart.mp3': soundBytes }
    for (const f of files) await store.put(jobFileKey(designId, jobId, f), Buffer.alloc(sizes[f] ?? 10), 'application/octet-stream')
    return okResult(jobId, {
      pieces: [{
        category: 'emote', changed: true, changeKind: 'new', meta: { name: 'Squat' },
        checker: { pass: true, failures: 0, warnings: 0 }, files, renders: { 'emote-male-default': 36 },
      }],
    })
  }
  const pieces = async (designId: string) => db.select().from(studioPieces).where(eq(studioPieces.designId, designId))
  const systemNotes = async (designId: string) =>
    (await db.select().from(studioMessages).where(eq(studioMessages.designId, designId))).filter((m) => m.role === 'system').map((m) => m.text)

  it('allows 3 MB', () => {
    expect(EMOTE_ALLOWANCE_BYTES).toBe(3 * MB)
  })

  it('an emote and its sound within 3 MB become a revision', async () => {
    const u = await createUser()
    const { designId, jobId } = await prompted(u)
    await finish(jobId, await emoteResult(designId, jobId, 2 * MB, 0.9 * MB))
    expect((await pieces(designId)).map((p) => p.category)).toEqual(['emote'])
    const [job] = await db.select().from(studioJobs).where(eq(studioJobs.id, jobId))
    expect(job.status).toBe('done')
  })

  it('an emote over 3 MB is refused, not counted, and the note says why', async () => {
    const u = await createUser()
    const before = (await promptStatus(u.id, new Date())).used
    const { designId, jobId } = await prompted(u)
    expect((await promptStatus(u.id, new Date())).used).toBe(before + 1)
    await finish(jobId, await emoteResult(designId, jobId, 2 * MB, 1.5 * MB))
    expect(await pieces(designId)).toEqual([])
    const [job] = await db.select().from(studioJobs).where(eq(studioJobs.id, jobId))
    expect(job.status).toBe('failed')
    expect((await promptStatus(u.id, new Date())).used).toBe(before)
    expect(await systemNotes(designId)).toEqual([
      'Something went wrong: the emote and its sound came to 3.5 MB, over Decentraland\'s 3 MB limit for an emote. Your prompt was not counted.',
    ])
  })

  it('a result without an emote is untouched', async () => {
    const u = await createUser()
    const { designId, jobId } = await prompted(u, 'wearable')
    await finish(jobId, okResult(jobId))
    expect((await pieces(designId)).map((p) => p.category)).toEqual(['hat'])
  })
})
