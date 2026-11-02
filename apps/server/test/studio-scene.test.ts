import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest'
import { and, eq } from 'drizzle-orm'
import { db } from '../src/db/connection.js'
import { studioDesigns, studioJobs, studioSetRenders } from '../src/db/schema.js'
import { config } from '../src/config.js'
import { memoryStudioStore, setStudioStore } from '../src/studio/store.js'
import { setMachineDeps } from '../src/studio/machines.js'
import { SCENE_PROMPT_LIMITS } from '../src/studio/scene.js'
import { resetDb } from './helpers/db.js'
import { testApp, createUser, tokenFor, type TestUser } from './helpers/factories.js'
import { fakeFly, okResult, issueWorker } from './helpers/studio.js'

const S = '/api/studio'

const building = (renders: Record<string, number> = { 'orbit-scene': 24 }) => ({
  category: 'building', changed: true, changeKind: 'new', renders,
  meta: { name: 'Little Kiosk', description: '', kind: 'building', type: 'kiosk', footprint: '1x1', changeKind: 'new' },
  checker: { pass: true, failures: 0, warnings: 0, triangles: null },
  files: ['pieces/building/kiosk.glb', 'pieces/building/piece.json', 'pieces/building/route.json', 'checks/building.txt'],
})
const chair = (renders: Record<string, number> = { scale: 36, 'orbit-scene': 24 }) => ({
  category: 'furniture_chair', changed: true, changeKind: 'new', renders,
  meta: { name: 'Neon Chair', description: '', kind: 'furniture', type: 'chair', changeKind: 'new' },
  checker: { pass: true, failures: 0, warnings: 0, triangles: null },
  files: ['pieces/furniture_chair/chair.glb', 'pieces/furniture_chair/piece.json', 'pieces/furniture_chair/chair.sittables.json',
    'checks/furniture_chair.txt'],
})

/** The scene design kind: buildings and furniture, their Inspect, Scale and walk-through views, and their limits. */
describe('studio scene designs', () => {
  let app: Awaited<ReturnType<typeof testApp>>
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
  })

  const as = (u: TestUser) => ({ authorization: `Bearer ${tokenFor(u)}` })
  const create = (u: TestUser, kind = 'scene') =>
    app.inject({ method: 'POST', url: `${S}/designs`, headers: as(u), payload: { kind, agent: 'claude' } })
  const prompt = (u: TestUser, id: string, text = 'a little kiosk with a chair') =>
    app.inject({ method: 'POST', url: `${S}/designs/${id}/prompts`, headers: as(u), payload: { text } })
  const post = (u: TestUser, id: string, path: string, payload: Record<string, unknown>) =>
    app.inject({ method: 'POST', url: `${S}/designs/${id}/${path}`, headers: as(u), payload })
  const finish = async (jobId: string, result: Record<string, unknown>) => {
    const [job] = await db.select().from(studioJobs).where(eq(studioJobs.id, jobId))
    const [d] = await db.select().from(studioDesigns).where(eq(studioDesigns.id, job.designId))
    const token = await issueWorker(d, d.machineId ?? 'm-test')
    await db.update(studioJobs).set({ status: 'taken', takenAt: new Date() }).where(eq(studioJobs.id, jobId))
    const res = await app.inject({ method: 'POST', url: `/api/studio/worker/jobs/${jobId}/result`, headers: { authorization: `Bearer ${token}` }, payload: result as any })
    expect(res.statusCode).toBe(204)
  }
  const renderJobs = async (designId: string) =>
    (await db.select().from(studioJobs).where(and(eq(studioJobs.designId, designId), eq(studioJobs.type, 'render'))))
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
  const tourJobs = async (designId: string) => (await renderJobs(designId)).filter((j) => (j.payload as any).render?.tour)

  /** A scene design whose prompt built the given pieces. */
  async function built(u: TestUser, pieces: unknown[]) {
    const d = (await create(u)).json()
    const jobId = (await prompt(u, d.id)).json().jobId
    await finish(jobId, { ...okResult(jobId), pieces })
    return d
  }

  it('creates a scene design, and refuses a kind it does not know', async () => {
    const u = await createUser()
    const res = await create(u)
    expect(res.statusCode).toBe(201)
    expect(res.json()).toMatchObject({ kind: 'scene', name: 'Untitled scene piece' })
    const bad = await create(u, 'house')
    expect([bad.statusCode, bad.json().error]).toEqual([400, 'kind must be wearable, emote or scene'])
  })

  it('a scene prompt carries the scene limits', async () => {
    const u = await createUser()
    const d = (await create(u)).json()
    const jobId = (await prompt(u, d.id)).json().jobId
    const [job] = await db.select().from(studioJobs).where(eq(studioJobs.id, jobId))
    expect((job.payload as any).limits).toEqual(SCENE_PROMPT_LIMITS)
    expect((job.payload as any).kind).toBe('scene')
  })

  it('a prompt that built a building queues its full Inspect sphere and its walk-through', async () => {
    const u = await createUser()
    const d = await built(u, [building(), chair()])
    const jobs = await renderJobs(d.id)
    const spheres = jobs.filter((j) => (j.payload as any).render?.mode === 'orbit')
    expect(spheres.map((j) => (j.payload as any).render.categories[0]).sort()).toEqual(['building', 'furniture_chair'])
    expect(spheres.every((j) => j.background && (j.payload as any).render.ring === false)).toBe(true)
    const [tour] = await tourJobs(d.id)
    expect((tour.payload as any).render).toEqual({ set: true, tour: true })
  })

  it('a prompt that changed only the furniture queues the walk-through again; a design with no building never does', async () => {
    const u = await createUser()
    const d = await built(u, [building(), chair()])
    const jobId = (await prompt(u, d.id, 'make the chair red')).json().jobId
    await finish(jobId, { ...okResult(jobId), pieces: [chair()] })
    expect(await tourJobs(d.id)).toHaveLength(2)
    const furnitureOnly = await built(await createUser(), [chair()])  // a free plan has one open design
    expect(await tourJobs(furnitureOnly.id)).toHaveLength(0)
  })

  it('renders: scene categories and modes on a scene design only', async () => {
    const u = await createUser()
    const d = await built(u, [building(), chair({ 'orbit-scene': 24 })])  // its scale turn failed in the prompt
    const orbit = await post(u, d.id, 'renders', { category: 'furniture_chair', mode: 'orbit' })
    expect(orbit.statusCode).toBe(200)
    const scale = await post(u, d.id, 'renders', { category: 'furniture_chair', mode: 'scale' })
    expect(scale.statusCode).toBe(200)
    const scaleJob = (await renderJobs(d.id)).find((j) => !(j.payload as any).render?.mode && !(j.payload as any).render?.set)
    expect((scaleJob!.payload as any).render).toEqual({ categories: ['furniture_chair'], bodyShape: 'male', outfit: 'default', emote: null })
    expect((await post(u, d.id, 'renders', { category: 'building', mode: 'scale' })).json()).toEqual({ error: 'unknown mode' })
    expect((await post(u, d.id, 'renders', { category: 'hat', mode: 'orbit' })).statusCode).toBe(400)
    const w = await createUser()
    const wearable = (await create(w, 'wearable')).json()
    expect((await post(w, wearable.id, 'renders', { category: 'furniture_chair', bodyShape: 'male', mode: 'orbit' })).statusCode).toBe(400)
    expect((await post(w, wearable.id, 'renders', { category: 'hat', bodyShape: 'male', mode: 'scale' })).json()).toEqual({ error: 'unknown mode' })
  })

  it('the walk-through belongs to the pieces it was rendered from: a new building revision renders it again', async () => {
    const u = await createUser()
    const d = await built(u, [building(), chair()])
    const [tour] = await tourJobs(d.id)
    await finish(tour.id, { ...okResult(tour.id), agent: null, model: null, costUsd: null, tokens: null, reply: '', pieces: [],
      set: { viewKey: 'tour', frames: 96, fps: 24 } })
    expect((await post(u, d.id, 'set-renders', {})).json()).toMatchObject({ status: 'ready', frames: 96 })
    const jobId = (await prompt(u, d.id, 'a taller roof')).json().jobId
    await finish(jobId, { ...okResult(jobId), pieces: [building()] })
    const again = await post(u, d.id, 'set-renders', {})
    expect(again.json()).toEqual({ status: 'queued' })
    const rows = await db.select().from(studioSetRenders).where(eq(studioSetRenders.designId, d.id))
    expect(rows.map((r) => r.status).sort()).toEqual(['queued', 'ready'])
  })

  it('a walk-through needs a building', async () => {
    const u = await createUser()
    const d = await built(u, [chair()])
    const res = await post(u, d.id, 'set-renders', {})
    expect([res.statusCode, res.json().error]).toEqual([404, 'no_building'])
  })
})
