import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '../src/db/connection.js'
import { studioDesignMembers, studioJobs } from '../src/db/schema.js'
import { publishStudio } from '../src/studio/events.js'
import { config } from '../src/config.js'
import { memoryStudioStore, setStudioStore } from '../src/studio/store.js'
import { resetDb } from './helpers/db.js'
import { testApp, createUser, createScene, tokenFor } from './helpers/factories.js'
import { startGameServer, joinStudio } from './helpers/game-server.js'
import { createDesign, issueWorker, queueJob, okResult } from './helpers/studio.js'

describe('VirviStudioRoom', () => {
  let gs: Awaited<ReturnType<typeof startGameServer>>
  let app: Awaited<ReturnType<typeof testApp>>
  const prev = config.studioEnabled
  beforeAll(() => { (config as any).studioEnabled = true; setStudioStore(memoryStudioStore()) })
  afterAll(() => { (config as any).studioEnabled = prev; setStudioStore(null) })
  beforeEach(async () => {
    await resetDb()
    gs = await startGameServer()
    app = await testApp()
  })
  afterEach(async () => { await gs.stop() })

  it('the owner hears progress, phases and job changes', async () => {
    const owner = await createUser()
    const design = await createDesign(owner)
    const token = await issueWorker(design)
    const job = await queueJob(design)
    await db.update(studioJobs).set({ status: 'taken', takenAt: new Date() }).where(eq(studioJobs.id, job.id))
    const s = await joinStudio(gs.url, design.id, tokenFor(owner))
    const w = { authorization: `Bearer ${token}` }
    await app.inject({ method: 'POST', url: `/api/studio/worker/jobs/${job.id}/events`, headers: w, payload: { type: 'phase', phase: 'building' } })
    await app.inject({ method: 'POST', url: `/api/studio/worker/jobs/${job.id}/events`, headers: w, payload: { type: 'progress', text: 'Running blender' } })
    await app.inject({ method: 'POST', url: `/api/studio/worker/jobs/${job.id}/result`, headers: w, payload: okResult(job.id) as any })
    const events = await s.waitForCount(3)
    expect(events).toEqual([
      { type: 'phase', jobId: job.id, phase: 'building' },
      { type: 'progress', jobId: job.id, text: 'Running blender' },
      { type: 'job', jobId: job.id, status: 'done', outcome: 'ok' },
    ])
  })

  it("other users can't join a design's room", async () => {
    const owner = await createUser()
    const design = await createDesign(owner)
    await expect(joinStudio(gs.url, design.id, tokenFor(await createUser()))).rejects.toThrow()
    await expect(joinStudio(gs.url, 'not-a-uuid', tokenFor(owner))).rejects.toThrow()
  })

  it('a Virvi admin helping (the role read from the database) joins anyone’s design; a token only claiming it does not', async () => {
    const owner = await createUser()
    const design = await createDesign(owner)
    const admin = await createUser({ role: 'admin' })
    const s = await joinStudio(gs.url, design.id, tokenFor(admin))
    expect(s).toBeTruthy()
    await expect(joinStudio(gs.url, design.id, tokenFor(await createUser(), { role: 'admin' }))).rejects.toThrow()
  })

  it("scene passes and guests can't join", async () => {
    const owner = await createUser()
    const design = await createDesign(owner)
    const { scene } = await createScene(owner)
    await expect(joinStudio(gs.url, design.id, tokenFor(owner, { kind: 'scene', sceneId: scene.id }))).rejects.toThrow()
    await expect(joinStudio(gs.url, design.id, tokenFor(owner, { verified: false }))).rejects.toThrow()
    await expect(joinStudio(gs.url, design.id)).rejects.toThrow()
  })

  it('a collaborator can join the room', async () => {
    const design = await createDesign(await createUser())
    const collab = await createUser()
    await db.insert(studioDesignMembers).values({ designId: design.id, userId: collab.id, role: 'collaborator' })
    const s = await joinStudio(gs.url, design.id, tokenFor(collab))
    expect(s.room.connection.isOpen).toBe(true)
    await s.room.leave()
  })

  it('a viewer can join', async () => {
    const design = await createDesign(await createUser())
    const viewer = await createUser()
    await db.insert(studioDesignMembers).values({ designId: design.id, userId: viewer.id, role: 'viewer' })
    const s = await joinStudio(gs.url, design.id, tokenFor(viewer))
    expect(s.room.connection.isOpen).toBe(true)
    await s.room.leave()
  })

  it('a stranger is Unauthorized, and so is a member who left', async () => {
    const design = await createDesign(await createUser())
    await expect(joinStudio(gs.url, design.id, tokenFor(await createUser()))).rejects.toThrow(/Unauthorized/)
    const left = await createUser()
    await db.insert(studioDesignMembers).values({ designId: design.id, userId: left.id, role: 'collaborator', leftAt: new Date() })
    await expect(joinStudio(gs.url, design.id, tokenFor(left))).rejects.toThrow(/Unauthorized/)
  })

  it('removed member is disconnected from the room', async () => {
    const owner = await createUser()
    const design = await createDesign(owner)
    const collab = await createUser()
    await db.insert(studioDesignMembers).values({ designId: design.id, userId: collab.id, role: 'collaborator' })
    const gone = await joinStudio(gs.url, design.id, tokenFor(collab))
    const stays = await joinStudio(gs.url, design.id, tokenFor(owner))
    const left = new Promise<number>((resolve) => gone.room.onLeave((code: number) => resolve(code)))
    await publishStudio(design.id, { type: 'member_removed', userId: collab.id })
    expect(await left).toBeGreaterThan(1000)
    // The others stay and hear it
    expect(await stays.waitForCount(1)).toEqual([{ type: 'member_removed', userId: collab.id }])
    await stays.room.leave()
  })
})
