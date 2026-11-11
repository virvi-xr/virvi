import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest'
import { and, eq } from 'drizzle-orm'
import { db } from '../src/db/connection.js'
import { studioDesigns, studioJobs, studioRenders, studioSetRenders } from '../src/db/schema.js'
import { config } from '../src/config.js'
import { memoryStudioStore, setStudioStore } from '../src/studio/store.js'
import { setMachineDeps } from '../src/studio/machines.js'
import { outfitView, rerenderOutfitViews } from '../src/studio/rerender-outfits.js'
import { resetDb } from './helpers/db.js'
import { createUser } from './helpers/factories.js'
import { addRevision, createDesign, fakeFly } from './helpers/studio.js'

const OLD = new Date('2026-11-01T00:00:00Z')
const CUTOFF = new Date('2026-11-09T00:00:00Z')
const NEW = new Date('2026-11-10T00:00:00Z')
const IMAGE = 'registry.fly.io/vlm-studio-worker:test'
const RUN = { before: CUTOFF, drainTimeoutMs: 0 }

/** LIV-143: renders made before each body shape had its own outfit are dropped or queued again. */
describe('studio outfit re-render (LIV-143)', () => {
  let fly: ReturnType<typeof fakeFly>
  const prev = { enabled: config.studioEnabled, image: config.studioWorkerImage, token: config.flyApiToken, machines: config.studioMachines }
  beforeAll(() => {
    ;(config as any).studioEnabled = true
  })
  afterAll(() => {
    Object.assign(config as any, { studioEnabled: prev.enabled, studioWorkerImage: prev.image, flyApiToken: prev.token, studioMachines: prev.machines })
    setStudioStore(null)
    setMachineDeps(null)
  })
  beforeEach(async () => {
    Object.assign(config as any, { studioWorkerImage: IMAGE, flyApiToken: 'fly-test-token', studioMachines: 'fly' })
    await resetDb()
    setStudioStore(memoryStudioStore())
    fly = fakeFly()
    setMachineDeps({ fly })
  })

  const jobAt = async (designId: string, at: Date) =>
    (await db.insert(studioJobs).values({ designId, type: 'render', status: 'done', payload: {}, createdAt: at }).returning())[0].id
  const render = async (revisionId: string, designId: string, viewKey: string, at: Date, status = 'ready') =>
    db.insert(studioRenders).values({ revisionId, viewKey, jobId: await jobAt(designId, at), status, frames: 36 })
  const setRender = async (designId: string, revisions: string, viewKey: string, at: Date, status = 'ready') =>
    db.insert(studioSetRenders).values({ designId, revisions, viewKey, jobId: await jobAt(designId, at), status, frames: 96 })
  const statuses = async (revisionId: string) => Object.fromEntries(
    (await db.select().from(studioRenders).where(eq(studioRenders.revisionId, revisionId))).map((r) => [r.viewKey, r.status]))
  const queuedJobs = async (designId: string) =>
    db.select().from(studioJobs).where(and(eq(studioJobs.designId, designId), eq(studioJobs.status, 'queued')))
  /** A design whose latest emote revision has one old ready outfit view. */
  async function oldEmote(u: Awaited<ReturnType<typeof createUser>>, opts: Record<string, unknown> = {}) {
    const d = await createDesign(u, { kind: 'emote', ...opts })
    const rev = await addRevision(d, 'emote')
    await render(rev.id, d.id, 'emote-male-default', OLD)
    return { d, rev }
  }

  it('reads the view an outfit key names', () => {
    expect(outfitView('emote-male-default')).toEqual({ bodyShape: 'male', outfit: 'default', emote: null })
    expect(outfitView('spin-female-outfit-2-dance')).toEqual({ bodyShape: 'female', outfit: 'outfit-2', emote: 'dance' })
    expect(outfitView('spin-male-outfit-3')).toEqual({ bodyShape: 'male', outfit: 'outfit-3', emote: null })
    for (const key of ['orbit-male', 'orbit-scene', 'scale', 'spin-male-nope', 'spin-other-default', 'spin-male-default-moonwalk']) {
      expect(outfitView(key)).toBeNull()
    }
  })

  it('re-queues the latest revision’s old ready outfit views in place and drops the current old emote views', async () => {
    const u = await createUser()
    const d = await createDesign(u, { kind: 'emote' })
    const old = await addRevision(d, 'emote')
    await render(old.id, d.id, 'emote-female-default', OLD) // an older revision: left alone
    await setRender(d.id, old.id, 'walk-male-default-own', OLD) // an older set of revisions: left alone
    const rev = await addRevision(d, 'emote')
    await render(rev.id, d.id, 'emote-male-default', OLD)
    await render(rev.id, d.id, 'emote-female-outfit-2', OLD)
    await render(rev.id, d.id, 'emote-male-outfit-3', NEW) // rendered with the new outfits
    await render(rev.id, d.id, 'emote-female-outfit-3', OLD, 'queued') // already on its way
    await render(rev.id, d.id, 'emote-female-default', OLD, 'failed') // a failed view is retried when it's picked
    await setRender(d.id, rev.id, 'walk-male-default-own', OLD)
    await setRender(d.id, rev.id, 'walk-female-default-own', NEW)

    const dry = await rerenderOutfitViews(NEW, { ...RUN, dryRun: true })
    expect(dry).toMatchObject({ designs: 1, setViews: 1, views: 2, done: [], skipped: [], stopped: null })
    expect(await db.select().from(studioSetRenders)).toHaveLength(3)
    expect(fly.calls.create).toHaveLength(0)

    expect(await rerenderOutfitViews(NEW, RUN)).toMatchObject({ designs: 1, setViews: 1, views: 2, done: [d.id], skipped: [], stopped: null })
    expect((await db.select().from(studioSetRenders)).map((r) => r.viewKey).sort()).toEqual(['walk-female-default-own', 'walk-male-default-own'])
    expect((await db.select().from(studioSetRenders).where(eq(studioSetRenders.revisions, rev.id))).map((r) => r.viewKey)).toEqual(['walk-female-default-own'])
    expect(await statuses(rev.id)).toEqual({
      'emote-male-default': 'queued', 'emote-female-outfit-2': 'queued', 'emote-male-outfit-3': 'ready',
      'emote-female-outfit-3': 'queued', 'emote-female-default': 'failed',
    })
    const jobs = await queuedJobs(d.id)
    expect(jobs.every((j) => j.background && j.type === 'render')).toBe(true)
    expect(jobs.map((j) => (j.payload as any).render).sort((a, b) => a.bodyShape.localeCompare(b.bodyShape))).toEqual([
      { categories: ['emote'], bodyShape: 'female', outfit: 'outfit-2', emote: null },
      { categories: ['emote'], bodyShape: 'male', outfit: 'default', emote: null },
    ])
    const rows = await db.select().from(studioRenders).where(eq(studioRenders.revisionId, rev.id))
    expect(rows.filter((r) => r.status === 'queued' && jobs.some((j) => j.id === r.jobId))).toHaveLength(2)
    expect(await statuses(old.id)).toEqual({ 'emote-female-default': 'ready' })
    expect(fly.calls.create).toHaveLength(1) // one worker for the design

    // a second run finds nothing left to do
    expect(await rerenderOutfitViews(NEW, RUN)).toMatchObject({ designs: 0, setViews: 0, views: 0 })
  })

  it('leaves Inspect views, scenes and archived designs alone', async () => {
    const u = await createUser()
    const d = await createDesign(u)
    const rev = await addRevision(d, 'hat')
    await render(rev.id, d.id, 'orbit-male', OLD)
    await render(rev.id, d.id, 'spin-female-outfit-2-dance', OLD)
    const scene = await createDesign(u, { kind: 'scene' })
    const srev = await addRevision(scene, 'building')
    await render(srev.id, scene.id, 'orbit-scene', OLD)
    await setRender(scene.id, srev.id, 'tour', OLD)
    const archived = await oldEmote(u, { archivedAt: OLD })
    expect(await rerenderOutfitViews(NEW, RUN)).toMatchObject({ designs: 1, setViews: 0, views: 1, done: [d.id] })
    expect(await statuses(rev.id)).toEqual({ 'orbit-male': 'ready', 'spin-female-outfit-2-dance': 'queued' })
    expect(await db.select().from(studioSetRenders)).toHaveLength(1)
    expect(await statuses(archived.rev.id)).toEqual({ 'emote-male-default': 'ready' })
  })

  it('skips a design whose machine is still running an older worker image, so a re-run catches it later', async () => {
    const u = await createUser()
    const { d, rev } = await oldEmote(u)
    fly.machines.set('m-old', { state: 'started', spec: { image: 'registry.fly.io/vlm-studio-worker:old' } as any })
    await db.update(studioDesigns).set({ machineId: 'm-old' }).where(eq(studioDesigns.id, d.id))
    expect(await rerenderOutfitViews(NEW, RUN)).toMatchObject({ designs: 1, views: 1, done: [], skipped: [d.id] })
    expect(await statuses(rev.id)).toEqual({ 'emote-male-default': 'ready' })
    expect(await queuedJobs(d.id)).toHaveLength(0)

    fly.machines.get('m-old')!.state = 'stopped' // it went idle: the next run replaces it with the current image
    expect(await rerenderOutfitViews(NEW, RUN)).toMatchObject({ done: [d.id], skipped: [] })
    expect(await statuses(rev.id)).toEqual({ 'emote-male-default': 'queued' })
    expect(fly.calls.del).toEqual(['m-old'])
    expect(fly.calls.create.map((s) => s.image)).toEqual([IMAGE])
  })

  it('stops when Fly refuses a start, leaving that design’s views queued to retry', async () => {
    const u = await createUser()
    const first = await oldEmote(u, { lastJobAt: NEW })
    const second = await oldEmote(u, { lastJobAt: OLD })
    fly.failCreate = () => new Error('rate limited')
    const r = await rerenderOutfitViews(NEW, RUN)
    expect(r).toMatchObject({ designs: 2, done: [] })
    expect(r.stopped).toMatch(/rate limited/)
    expect(await statuses(first.rev.id)).toEqual({ 'emote-male-default': 'queued' })
    expect((await queuedJobs(first.d.id))).toHaveLength(1) // never failed
    expect(await statuses(second.rev.id)).toEqual({ 'emote-male-default': 'ready' })
  })

  it('takes the most recently active designs first, at most `limit`, or only `designId`', async () => {
    const u = await createUser()
    const a = await oldEmote(u, { lastJobAt: OLD })
    const b = await oldEmote(u, { lastJobAt: NEW })
    const c = await oldEmote(u, { lastJobAt: CUTOFF })
    expect(await rerenderOutfitViews(NEW, { ...RUN, limit: 1 })).toMatchObject({ designs: 1, done: [b.d.id] })
    expect(await rerenderOutfitViews(NEW, { ...RUN, designId: a.d.id })).toMatchObject({ designs: 1, done: [a.d.id] })
    expect(await statuses(c.rev.id)).toEqual({ 'emote-male-default': 'ready' })
    expect(await rerenderOutfitViews(NEW, { ...RUN, dryRun: true })).toMatchObject({ designs: 1, views: 1 })
  })

  it('refuses a cutoff in the future, and a real run without Fly configured', async () => {
    await expect(rerenderOutfitViews(OLD, { ...RUN, dryRun: true })).rejects.toThrow(/later than now/)
    for (const over of [{ studioMachines: 'external' }, { studioWorkerImage: null }, { flyApiToken: null }]) {
      Object.assign(config as any, { studioWorkerImage: IMAGE, flyApiToken: 'fly-test-token', studioMachines: 'fly' }, over)
      await expect(rerenderOutfitViews(NEW, RUN)).rejects.toThrow(/Fly/)
      await expect(rerenderOutfitViews(NEW, { ...RUN, dryRun: true })).resolves.toMatchObject({ designs: 0 })
    }
  })
})
