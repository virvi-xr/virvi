import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest'
import { and, eq } from 'drizzle-orm'
import { db } from '../src/db/connection.js'
import { studioDesigns, studioJobs, studioMessages, studioRenders, studioSetRenders } from '../src/db/schema.js'
import { config } from '../src/config.js'
import { memoryStudioStore, setStudioStore, jobFileKey } from '../src/studio/store.js'
import { signRenderFrame, frameUrlExpiry } from '../src/studio/render-urls.js'
import { setMachineDeps } from '../src/studio/machines.js'
import { promptStatus } from '../src/studio/quota.js'
import { resetDb } from './helpers/db.js'
import { testApp, createUser, tokenFor, type TestUser } from './helpers/factories.js'
import { addRevision, fakeFly, okResult, issueWorker } from './helpers/studio.js'

const S = '/api/studio'

/** Inspect from every angle, emote views with every piece worn, emote checks and free clipping fixes. */
describe('studio preview steps', () => {
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
  const create = (u: TestUser, body: Record<string, unknown> = { kind: 'wearable', agent: 'claude' }) =>
    app.inject({ method: 'POST', url: `${S}/designs`, headers: as(u), payload: body })
  const prompt = (u: TestUser, id: string, body: Record<string, unknown> = { text: 'a neon cap', selectedSlots: ['hat'] }) =>
    app.inject({ method: 'POST', url: `${S}/designs/${id}/prompts`, headers: as(u), payload: body })
  const detail = async (u: TestUser, id: string) => (await app.inject({ method: 'GET', url: `${S}/designs/${id}`, headers: as(u) })).json()
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
  const renderResult = (jobId: string, pieces: unknown[], over: Record<string, unknown> = {}) =>
    ({ ...okResult(jobId), agent: null, model: null, costUsd: null, tokens: null, reply: '', pieces, ...over })

  /** A wearable design whose prompt built a hat with the spin and the Inspect ring. */
  async function hatWithRing(u: TestUser) {
    const d = (await create(u)).json()
    const jobId = (await prompt(u, d.id)).json().jobId
    const r = okResult(jobId)
    r.pieces[0].renders = { 'spin-male-default': 36, 'orbit-male': 24 }
    await finish(jobId, r)
    return { design: d, jobId }
  }

  describe('inspect', () => {
    it('a wearable prompt with a ring queues the full sphere in the background', async () => {
      const u = await createUser()
      const { design } = await hatWithRing(u)
      const [full] = await renderJobs(design.id)
      expect(full.background).toBe(true)
      expect((full.payload as any).render).toEqual({ categories: ['hat'], bodyShape: 'male', mode: 'orbit', ring: false })
      const [row] = await db.select().from(studioRenders).where(eq(studioRenders.viewKey, 'orbit-male'))
      expect(row).toMatchObject({ status: 'ready', frames: 24, pendingJobId: full.id })
      expect((await detail(u, design.id)).pieces[0].renders['orbit-male']).toMatchObject({ pending: true })
      expect((await detail(u, design.id)).pieces[0].renders['orbit-male'].urls).toHaveLength(24)
    })

    it('the full sphere replaces the ring when it lands', async () => {
      const u = await createUser()
      const { design } = await hatWithRing(u)
      const [full] = await renderJobs(design.id)
      await finish(full.id, renderResult(full.id, [{ category: 'hat', renders: { 'orbit-male': 122 } }]))
      const [row] = await db.select().from(studioRenders).where(eq(studioRenders.viewKey, 'orbit-male'))
      expect(row).toMatchObject({ status: 'ready', frames: 122, jobId: full.id, pendingJobId: null })
      const view = (await detail(u, design.id)).pieces[0].renders['orbit-male']
      expect(view.urls).toHaveLength(122)
    })

    it('a failed full sphere keeps the ring', async () => {
      const u = await createUser()
      const { design, jobId } = await hatWithRing(u)
      const [full] = await renderJobs(design.id)
      await finish(full.id, renderResult(full.id, [{ category: 'hat', renders: { 'orbit-male': 0 } }], { outcome: 'error', error: 'blank' }))
      const [row] = await db.select().from(studioRenders).where(eq(studioRenders.viewKey, 'orbit-male'))
      expect(row).toMatchObject({ status: 'ready', frames: 24, jobId, pendingJobId: null })
      expect((await detail(u, design.id)).pieces[0].renders['orbit-male']).toMatchObject({ pending: false, frames: 24 })
    })

    it('asking for the female sphere queues the ring first and the rest behind it', async () => {
      const u = await createUser()
      const { design } = await hatWithRing(u)
      const before = (await renderJobs(design.id)).length
      const res = await app.inject({ method: 'POST', url: `${S}/designs/${design.id}/renders`, headers: as(u), payload: { category: 'hat', bodyShape: 'female', mode: 'orbit' } })
      expect(res.json()).toEqual({ status: 'queued' })
      const jobs = (await renderJobs(design.id)).slice(before)
      expect(jobs.map((j) => [(j.payload as any).render.ring, j.background])).toEqual([[true, false], [false, true]])
      const [row] = await db.select().from(studioRenders).where(eq(studioRenders.viewKey, 'orbit-female'))
      expect(row).toMatchObject({ status: 'queued', jobId: jobs[0].id, pendingJobId: jobs[1].id })
      // the ring lands: shown at once while the rest renders
      await finish(jobs[0].id, renderResult(jobs[0].id, [{ category: 'hat', renders: { 'orbit-female': 24 } }]))
      expect((await db.select().from(studioRenders).where(eq(studioRenders.viewKey, 'orbit-female')))[0])
        .toMatchObject({ status: 'ready', frames: 24, pendingJobId: jobs[1].id })
      const again = await app.inject({ method: 'POST', url: `${S}/designs/${design.id}/renders`, headers: as(u), payload: { category: 'hat', bodyShape: 'female', mode: 'orbit' } })
      expect(again.json()).toMatchObject({ status: 'ready', frames: 24 })
      expect(await renderJobs(design.id)).toHaveLength(before + 2)
    })

    it('an emote design has no inspect view', async () => {
      const u = await createUser()
      const d = (await create(u, { kind: 'emote', agent: 'claude' })).json()
      const res = await app.inject({ method: 'POST', url: `${S}/designs/${d.id}/renders`, headers: as(u), payload: { category: 'emote', bodyShape: 'male', mode: 'orbit' } })
      expect(res.statusCode).toBe(400)
      expect(res.json().error).toBe('unknown mode')
    })
  })
  const setRender = (u: TestUser, id: string, view: Record<string, unknown>) =>
    app.inject({ method: 'POST', url: `${S}/designs/${id}/set-renders`, headers: as(u), payload: view })

  /** A wearable design with a hat and a jacket. */
  async function twoPieces(u: TestUser) {
    const d = (await create(u)).json()
    await addRevision(d, 'hat')
    await addRevision(d, 'upper_body')
    return d
  }

  /** Queues and lands an emote view, with its frames stored. Returns the render job's id. */
  async function landSet(u: TestUser, d: { id: string }, emote: string | null, key: string, frames = 96) {
    expect((await setRender(u, d.id, { bodyShape: 'male', outfit: 'default', emote })).json()).toEqual({ status: 'queued' })
    const [row] = await db.select().from(studioSetRenders)
      .where(and(eq(studioSetRenders.designId, d.id), eq(studioSetRenders.viewKey, key), eq(studioSetRenders.status, 'queued')))
    await finish(row.jobId, renderResult(row.jobId, [], { set: { viewKey: key, frames, fps: 24 } }))
    for (let i = 0; i < 2; i++) {
      await store.put(jobFileKey(d.id, row.jobId, `renders/set/${key}/00${i}.webp`), Buffer.from(`frame${i}`), 'image/webp')
    }
    return row.jobId
  }

  describe('emote views', () => {
    it('queues a set view with every piece and serves its frames once rendered', async () => {
      const u = await createUser()
      const d = await twoPieces(u)
      const jobId = await landSet(u, d, 'run', 'walk-male-default-run')
      const [job] = await db.select().from(studioJobs).where(eq(studioJobs.id, jobId))
      expect((job.payload as any).render).toEqual({ set: true, bodyShape: 'male', outfit: 'default', emote: 'run' })
      expect(job.background).toBe(false)
      // the detail says what is rendered; the frames' urls come from asking for the view
      expect((await detail(u, d.id)).set.views['walk-male-default-run']).toEqual(expect.objectContaining({ status: 'ready', frames: 96, fps: 24 }))
      expect((await detail(u, d.id)).set.views['walk-male-default-run'].urls).toBeUndefined()
      const view = (await setRender(u, d.id, { bodyShape: 'male', outfit: 'default', emote: 'run' })).json()
      expect(view.urls).toHaveLength(96)
      const frame = await app.inject({ method: 'GET', url: new URL(view.urls[1]).pathname })
      expect(frame.statusCode).toBe(200)
      expect(frame.headers['content-type']).toBe('image/webp')
      expect(frame.body).toBe('frame1')
      expect((await setRender(u, d.id, { bodyShape: 'male', outfit: 'default', emote: 'run' })).json())
        .toMatchObject({ status: 'ready', frames: 96, fps: 24 })
    })

    it('a new revision of any piece makes the set view stale', async () => {
      const u = await createUser()
      const d = await twoPieces(u)
      await landSet(u, d, 'run', 'walk-male-default-run')
      await addRevision(d, 'hat')
      expect((await detail(u, d.id)).set.views).toEqual({})
    })

    it('a piece added after the render makes the set view stale', async () => {
      const u = await createUser()
      const d = (await create(u)).json()
      await addRevision(d, 'hat')
      await landSet(u, d, 'jump', 'walk-male-default-jump')
      expect(Object.keys((await detail(u, d.id)).set.views)).toEqual(['walk-male-default-jump'])
      await addRevision(d, 'feet')
      expect((await detail(u, d.id)).set.views).toEqual({})
    })

    it('a failed set render shows as failed and can be asked for again', async () => {
      const u = await createUser()
      const d = await twoPieces(u)
      await setRender(u, d.id, { bodyShape: 'female', outfit: 'outfit-2', emote: 'dance' })
      const [row] = await db.select().from(studioSetRenders)
      await finish(row.jobId, renderResult(row.jobId, [], { outcome: 'error', error: 'blank' }))
      expect((await detail(u, d.id)).set.views['walk-female-outfit-2-dance']).toMatchObject({ status: 'failed' })
      expect((await setRender(u, d.id, { bodyShape: 'female', outfit: 'outfit-2', emote: 'dance' })).json()).toEqual({ status: 'queued' })
    })

    it('an emote design asks for its own emote', async () => {
      const u = await createUser()
      const d = (await create(u, { kind: 'emote', agent: 'claude' })).json()
      await addRevision(d, 'emote')
      expect((await setRender(u, d.id, { bodyShape: 'male', outfit: 'default', emote: 'dance' })).statusCode).toBe(400)
      await landSet(u, d, null, 'walk-male-default-own')
      const [job] = await db.select().from(studioJobs).where(eq(studioJobs.type, 'render'))
      expect((job.payload as any).render.emote).toBe('own')
    })

    it('set view input is checked', async () => {
      const u = await createUser()
      const d = await twoPieces(u)
      for (const bad of [{ bodyShape: 'x', outfit: 'default', emote: 'run' }, { bodyShape: 'male', outfit: 'x', emote: 'run' },
        { bodyShape: 'male', outfit: 'default', emote: 'moonwalk' }, { bodyShape: 'male', outfit: 'default', emote: null }]) {
        expect((await setRender(u, d.id, bad)).statusCode).toBe(400)
      }
      const empty = (await create(u)).json()
      expect((await setRender(u, empty.id, { bodyShape: 'male', outfit: 'default', emote: 'run' })).statusCode).toBe(404)
    })

    it('a set frame token cannot reach another design', async () => {
      const u = await createUser()
      const a = await twoPieces(u)
      const jobId = await landSet(u, a, 'run', 'walk-male-default-run')
      const [row] = await db.select().from(studioSetRenders)
      const b = await twoPieces(await createUser())
      const forged = signRenderFrame({ designId: b.id, revisionId: row.id, viewKey: row.viewKey, category: 'set', frame: 0, jobId }, frameUrlExpiry(new Date()))
      expect((await app.inject({ method: 'GET', url: new URL(forged).pathname })).statusCode).toBe(403)
      const tooFar = signRenderFrame({ designId: a.id, revisionId: row.id, viewKey: row.viewKey, category: 'set', frame: 96, jobId }, frameUrlExpiry(new Date()))
      expect((await app.inject({ method: 'GET', url: new URL(tooFar).pathname })).statusCode).toBe(403)
    })
  })
  const report = (u: TestUser, id: string, body: Record<string, unknown> = { emote: 'dance', bodyShape: 'male', outfit: 'default' }) =>
    app.inject({ method: 'POST', url: `${S}/designs/${id}/clipping`, headers: as(u), payload: body })
  /** A fix job finished with the outcome given; an ok one makes a new hat revision, as a real fix would. */
  async function endFix(jobId: string, outcome: string) {
    const r = okResult(jobId, { outcome })
    if (outcome !== 'ok') r.pieces = []
    await finish(jobId, r)
  }

  describe('clipping', () => {
    it('a clipping report is a free prompt with the server’s own words', async () => {
      const u = await createUser()
      const d = await twoPieces(u)
      await landSet(u, d, 'dance', 'walk-male-default-dance')
      const before = (await promptStatus(u.id, new Date())).left
      const res = await report(u, d.id)
      expect(res.statusCode).toBe(202)
      const [job] = await db.select().from(studioJobs).where(eq(studioJobs.id, res.json().jobId))
      expect(job.counted).toBe(false)
      const payload = job.payload as any
      expect(payload.check).toBe(false)
      expect(payload.fixClipping).toEqual({ emote: 'dance', bodyShape: 'male', outfit: 'default' })
      expect(payload.prompt).toBe('Fix the clipping in the dance emote on the male body with the default outfit: find which piece passes through the body, the base outfit’s clothes or another piece, and change only the parts that do. Change nothing else.')
      const messages = await db.select().from(studioMessages).where(eq(studioMessages.designId, d.id))
      expect(messages.map((m) => m.text)).toContain('It clips in the dance (male, default outfit). Please fix it.')
      expect((await promptStatus(u.id, new Date())).left).toBe(before)
      const body = await detail(u, d.id)
      expect(body.set.checks).toContainEqual({ emote: 'dance', bodyShape: 'male', state: 'clipping' })
      expect(body.activeJob).toMatchObject({ type: 'prompt', fixClipping: { emote: 'dance', bodyShape: 'male', outfit: 'default' } })
    })

    it('two ok fixes per emote, then the person is asked to describe it', async () => {
      const u = await createUser()
      const d = await twoPieces(u)
      for (let i = 0; i < 2; i++) {
        await landSet(u, d, 'dance', 'walk-male-default-dance')
        await endFix((await report(u, d.id)).json().jobId, 'ok')
      }
      await landSet(u, d, 'dance', 'walk-male-default-dance')
      expect((await detail(u, d.id)).set.freeFixesLeft).toMatchObject({ dance: 0, run: 2 })
      const third = await report(u, d.id)
      expect(third.statusCode).toBe(409)
      expect(third.json().code).toBe('clipping_fix_limit')
      await landSet(u, d, 'run', 'walk-male-default-run')
      expect((await report(u, d.id, { emote: 'run', bodyShape: 'male', outfit: 'default' })).statusCode).toBe(202)
    })

    it('a fix that errored or changed nothing does not use one up', async () => {
      const u = await createUser()
      const d = await twoPieces(u)
      await landSet(u, d, 'dance', 'walk-male-default-dance')
      await endFix((await report(u, d.id)).json().jobId, 'error')
      await endFix((await report(u, d.id)).json().jobId, 'no_change')
      expect((await detail(u, d.id)).set.freeFixesLeft.dance).toBe(2)
    })

    it('a prompt of the person’s own resets the free fixes', async () => {
      const u = await createUser()
      const d = await twoPieces(u)
      await landSet(u, d, 'dance', 'walk-male-default-dance')
      await endFix((await report(u, d.id)).json().jobId, 'ok')
      await new Promise((r) => setTimeout(r, 5))
      const own = (await prompt(u, d.id, { text: 'make the brim wider', selectedSlots: ['hat'] })).json().jobId
      await finish(own, okResult(own))
      expect((await detail(u, d.id)).set.freeFixesLeft.dance).toBe(2)
    })

    it('a report on an emote never rendered is refused', async () => {
      const u = await createUser()
      const d = await twoPieces(u)
      const res = await report(u, d.id)
      expect(res.statusCode).toBe(409)
      expect(res.json().code).toBe('not_seen')
      await landSet(u, d, 'dance', 'walk-male-default-dance')
      expect((await report(u, d.id, { emote: 'dance', bodyShape: 'female', outfit: 'default' })).json().code).toBe('not_seen')
      expect(await db.select().from(studioJobs).where(eq(studioJobs.type, 'prompt'))).toHaveLength(2) // addRevision's own
    })

    it('a report while a prompt runs is refused as busy', async () => {
      const u = await createUser()
      const d = await twoPieces(u)
      await landSet(u, d, 'dance', 'walk-male-default-dance')
      expect((await prompt(u, d.id)).statusCode).toBe(202)
      const res = await report(u, d.id)
      expect(res.statusCode).toBe(409)
      expect(res.json().code).toBe('busy')
      expect((await detail(u, d.id)).set.checks).toEqual([])
    })

    it('an emote design’s report says “the emote”', async () => {
      const u = await createUser()
      const d = (await create(u, { kind: 'emote', agent: 'claude' })).json()
      await addRevision(d, 'emote')
      expect((await setRender(u, d.id, { bodyShape: 'female', outfit: 'outfit-2', emote: null })).json()).toEqual({ status: 'queued' })
      const [row] = await db.select().from(studioSetRenders)
      await finish(row.jobId, renderResult(row.jobId, [], { set: { viewKey: 'walk-female-outfit-2-own', frames: 96, fps: 24 } }))
      const res = await report(u, d.id, { emote: null, bodyShape: 'female', outfit: 'outfit-2' })
      expect(res.statusCode).toBe(202)
      const messages = await db.select().from(studioMessages).where(eq(studioMessages.designId, d.id))
      expect(messages.map((m) => m.text)).toContain('It clips in the emote (female, outfit 2 outfit). Please fix it.')
      const [job] = await db.select().from(studioJobs).where(eq(studioJobs.id, res.json().jobId))
      expect((job.payload as any).fixClipping.emote).toBe('own')
      expect((await detail(u, d.id)).set.freeFixesLeft).toEqual({ own: 2 }) // still running: only a fix that lands uses one
    })

    it('a fix that lands re-renders that emote for the new revisions', async () => {
      const u = await createUser()
      const d = await twoPieces(u)
      await landSet(u, d, 'dance', 'walk-male-default-dance')
      const fix = (await report(u, d.id)).json().jobId
      await endFix(fix, 'ok')
      const [row] = await db.select().from(studioSetRenders)
        .where(and(eq(studioSetRenders.status, 'queued'), eq(studioSetRenders.viewKey, 'walk-male-default-dance')))
      expect(row).toBeTruthy()
      expect(row.revisions).toBe((await detail(u, d.id)).set.revisions)
      expect((await detail(u, d.id)).set.checks).toEqual([]) // the fix is a new revision: nothing checked yet
    })
  })

  describe('checks and finalize', () => {
    it('looks fine is recorded for the current pieces only', async () => {
      const u = await createUser()
      const d = await twoPieces(u)
      const ok = await app.inject({ method: 'POST', url: `${S}/designs/${d.id}/emote-checks`, headers: as(u), payload: { emote: 'jump', bodyShape: 'female', state: 'fine' } })
      expect(ok.statusCode).toBe(204)
      expect((await detail(u, d.id)).set.checks).toEqual([{ emote: 'jump', bodyShape: 'female', state: 'fine' }])
      const bad = await app.inject({ method: 'POST', url: `${S}/designs/${d.id}/emote-checks`, headers: as(u), payload: { emote: 'jump', bodyShape: 'female', state: 'clipping' } })
      expect(bad.statusCode).toBe(400)
      await addRevision(d, 'hat')
      expect((await detail(u, d.id)).set.checks).toEqual([])
    })

    it('finalize renders every emote on both bodies, once', async () => {
      const u = await createUser()
      const d = await twoPieces(u)
      await landSet(u, d, 'dance', 'walk-male-default-dance')
      const go = () => app.inject({ method: 'POST', url: `${S}/designs/${d.id}/finalize-renders`, headers: as(u) })
      expect((await go()).json()).toEqual({ queued: 13 })
      expect((await go()).json()).toEqual({ queued: 0 })
      const rows = await db.select().from(studioSetRenders)
      expect(rows).toHaveLength(14)
      const jobs = await renderJobs(d.id)
      expect(jobs.filter((j) => j.background)).toHaveLength(13)
    })

    it('an emote design finalizes its own emote on both bodies', async () => {
      const u = await createUser()
      const d = (await create(u, { kind: 'emote', agent: 'claude' })).json()
      await addRevision(d, 'emote')
      const res = await app.inject({ method: 'POST', url: `${S}/designs/${d.id}/finalize-renders`, headers: as(u) })
      expect(res.json()).toEqual({ queued: 2 })
      expect((await db.select().from(studioSetRenders)).map((r) => r.viewKey).sort()).toEqual(['walk-female-default-own', 'walk-male-default-own'])
    })
  })
  describe('a change while renders wait', () => {
    it('a prompt that changes the pieces cancels emote renders queued for the old ones', async () => {
      const u = await createUser()
      const d = (await create(u)).json()
      const first = (await prompt(u, d.id)).json().jobId
      await finish(first, okResult(first))
      expect((await app.inject({ method: 'POST', url: `${S}/designs/${d.id}/finalize-renders`, headers: as(u) })).json()).toEqual({ queued: 14 })
      const old = (await renderJobs(d.id)).filter((j) => (j.payload as any).render?.set)
      expect((old[0].payload as any).revisions).toBe((await detail(u, d.id)).set.revisions)
      const second = (await prompt(u, d.id, { text: 'make it pink', selectedSlots: ['hat'] })).json().jobId
      await finish(second, okResult(second))
      const after = await db.select().from(studioJobs).where(eq(studioJobs.designId, d.id))
      expect(old.map((j) => after.find((a) => a.id === j.id)!.status)).toEqual(Array(14).fill('failed'))
      expect((await app.inject({ method: 'POST', url: `${S}/designs/${d.id}/finalize-renders`, headers: as(u) })).json()).toEqual({ queued: 14 })
    })

    it('a superseded piece’s sphere is cancelled, and the new one queued', async () => {
      const u = await createUser()
      const { design } = await hatWithRing(u)
      const [oldFull] = await renderJobs(design.id)
      const next = (await prompt(u, design.id, { text: 'make it pink', selectedSlots: ['hat'] })).json().jobId
      const r = okResult(next)
      r.pieces[0].renders = { 'spin-male-default': 36, 'orbit-male': 24 }
      await finish(next, r)
      const jobs = await renderJobs(design.id)
      expect(jobs.find((j) => j.id === oldFull.id)!.status).toBe('failed')
      expect(jobs.filter((j) => j.status === 'queued' && j.background)).toHaveLength(1)
    })
  })
})
