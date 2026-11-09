import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest'
import { and, eq } from 'drizzle-orm'
import { db } from '../src/db/connection.js'
import { studioJobs, studioRenders, studioSetRenders } from '../src/db/schema.js'
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

/** LIV-143: renders made before each body shape had its own outfit are dropped or queued again. */
describe('studio outfit re-render (LIV-143)', () => {
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
  })

  const jobAt = async (designId: string, at: Date) =>
    (await db.insert(studioJobs).values({ designId, type: 'render', status: 'done', payload: {}, createdAt: at }).returning())[0].id
  const render = async (revisionId: string, designId: string, viewKey: string, at: Date, status = 'ready') =>
    db.insert(studioRenders).values({ revisionId, viewKey, jobId: await jobAt(designId, at), status, frames: 36 })
  const setRender = async (designId: string, revisions: string, viewKey: string, at: Date, status = 'ready') =>
    db.insert(studioSetRenders).values({ designId, revisions, viewKey, jobId: await jobAt(designId, at), status, frames: 96 })

  it('reads the view an outfit key names', () => {
    expect(outfitView('emote-male-default')).toEqual({ bodyShape: 'male', outfit: 'default', emote: null })
    expect(outfitView('spin-female-outfit-2-dance')).toEqual({ bodyShape: 'female', outfit: 'outfit-2', emote: 'dance' })
    expect(outfitView('spin-male-outfit-3')).toEqual({ bodyShape: 'male', outfit: 'outfit-3', emote: null })
    for (const key of ['orbit-male', 'orbit-scene', 'scale', 'spin-male-nope', 'spin-other-default', 'spin-male-default-moonwalk']) {
      expect(outfitView(key)).toBeNull()
    }
  })

  it('drops old emote views and queues the latest revisions’ old outfit views again', async () => {
    const u = await createUser()
    const d = await createDesign(u, { kind: 'emote' })
    const old = await addRevision(d, 'emote')
    await render(old.id, d.id, 'emote-female-default', OLD) // an older revision: left alone
    const rev = await addRevision(d, 'emote')
    await render(rev.id, d.id, 'emote-male-default', OLD)
    await render(rev.id, d.id, 'emote-female-outfit-2', OLD)
    await render(rev.id, d.id, 'emote-male-outfit-3', NEW) // rendered with the new outfits
    await render(rev.id, d.id, 'emote-female-outfit-3', OLD, 'queued') // already on its way
    await setRender(d.id, rev.id, 'walk-male-default-own', OLD)
    await setRender(d.id, rev.id, 'walk-female-default-own', NEW)

    const dry = await rerenderOutfitViews(NEW, { before: CUTOFF, dryRun: true })
    expect(dry).toEqual({ setViews: 1, views: 2 })
    expect(await db.select().from(studioSetRenders)).toHaveLength(2)

    expect(await rerenderOutfitViews(NEW, { before: CUTOFF })).toEqual({ setViews: 1, views: 2 })
    expect((await db.select().from(studioSetRenders)).map((r) => r.viewKey)).toEqual(['walk-female-default-own'])
    const rows = await db.select().from(studioRenders).where(eq(studioRenders.revisionId, rev.id))
    const status = Object.fromEntries(rows.map((r) => [r.viewKey, r.status]))
    expect(status).toEqual({
      'emote-male-default': 'queued', 'emote-female-outfit-2': 'queued', 'emote-male-outfit-3': 'ready', 'emote-female-outfit-3': 'queued',
    })
    const jobs = await db.select().from(studioJobs).where(and(eq(studioJobs.designId, d.id), eq(studioJobs.status, 'queued')))
    expect(jobs.map((j) => (j.payload as any).render).sort((a, b) => a.bodyShape.localeCompare(b.bodyShape))).toEqual([
      { categories: ['emote'], bodyShape: 'female', outfit: 'outfit-2', emote: null },
      { categories: ['emote'], bodyShape: 'male', outfit: 'default', emote: null },
    ])
    const [older] = await db.select().from(studioRenders).where(eq(studioRenders.revisionId, old.id))
    expect(older.status).toBe('ready')

    // a second run finds nothing left to do
    expect(await rerenderOutfitViews(NEW, { before: CUTOFF })).toEqual({ setViews: 0, views: 0 })
  })

  it('leaves Inspect views and scenes alone', async () => {
    const u = await createUser()
    const d = await createDesign(u)
    const rev = await addRevision(d, 'hat')
    await render(rev.id, d.id, 'orbit-male', OLD)
    await render(rev.id, d.id, 'spin-female-outfit-2-dance', OLD)
    const scene = await createDesign(u, { kind: 'scene' })
    const srev = await addRevision(scene, 'building')
    await render(srev.id, scene.id, 'orbit-scene', OLD)
    await setRender(scene.id, srev.id, 'tour', OLD)
    expect(await rerenderOutfitViews(NEW, { before: CUTOFF })).toEqual({ setViews: 0, views: 1 })
    const rows = await db.select().from(studioRenders).where(eq(studioRenders.revisionId, rev.id))
    expect(Object.fromEntries(rows.map((r) => [r.viewKey, r.status]))).toEqual({ 'orbit-male': 'ready', 'spin-female-outfit-2-dance': 'queued' })
    expect(await db.select().from(studioSetRenders)).toHaveLength(1)
  })
})
