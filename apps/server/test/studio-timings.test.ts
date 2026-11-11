import { describe, it, expect, beforeEach, beforeAll, afterAll, afterEach, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '../src/db/connection.js'
import { studioDesigns, studioJobs, studioUsageDays, type JobTimings } from '../src/db/schema.js'
import { config } from '../src/config.js'
import { memoryStudioStore, setStudioStore } from '../src/studio/store.js'
import { setMachineDeps } from '../src/studio/machines.js'
import { queuePrompt } from '../src/studio/designs.js'
import { failJobs } from '../src/studio/results.js'
import { clearTypicalCache, firstReplyStats, median, p90, timingLine } from '../src/studio/timings.js'
import { resetDb } from './helpers/db.js'
import { testApp, createUser, tokenFor, type TestUser } from './helpers/factories.js'
import { createDesign, fakeFly, issueWorker, okResult, queueJob } from './helpers/studio.js'

const W = '/api/studio/worker'
const auth = (t: string) => ({ authorization: `Bearer ${t}` })
const timingsOf = async (id: string) => (await db.select().from(studioJobs).where(eq(studioJobs.id, id)))[0].timings

describe('timing the wait for a first reply', () => {
  let app: Awaited<ReturnType<typeof testApp>>
  let fly: ReturnType<typeof fakeFly>
  let owner: TestUser
  const prev = { enabled: config.studioEnabled, image: config.studioWorkerImage, machines: config.studioMachines }
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
    ;(config as any).studioMachines = prev.machines
    clearTypicalCache()
    setStudioStore(memoryStudioStore())
    fly = fakeFly()
    setMachineDeps({ fly })
    app = await testApp()
    owner = await createUser()
  })
  afterEach(() => { vi.restoreAllMocks() })

  const send = async (d: { id: string }) => {
    const [design] = await db.select().from(studioDesigns).where(eq(studioDesigns.id, d.id))
    const r = await queuePrompt(design, { text: 'a neon cap with a secret visor', selectedSlots: null, continue: false, senderId: design.ownerId }, new Date())
    if (!r.ok) throw new Error(JSON.stringify(r))
    return r.jobId
  }
  /** The worker's side: its token (the design's machine's), taking the job and sending events. */
  const worker = async (d: { id: string }) => {
    const [design] = await db.select().from(studioDesigns).where(eq(studioDesigns.id, d.id))
    const token = await issueWorker(d, design.machineId ?? 'm-test')
    return {
      next: () => app.inject({ method: 'GET', url: `${W}/designs/${d.id}/jobs/next`, headers: auth(token) }),
      event: (jobId: string, e: unknown) => app.inject({ method: 'POST', url: `${W}/jobs/${jobId}/events`, headers: auth(token), payload: e as any }),
      result: (jobId: string, body: unknown) => app.inject({ method: 'POST', url: `${W}/jobs/${jobId}/result`, headers: auth(token), payload: body as any }),
    }
  }

  it('fills in every step from a worker that reports them all', async () => {
    const d = await createDesign(owner)
    const jobId = await send(d)
    expect(await timingsOf(jobId)).toEqual({ machine: 'created' })
    const w = await worker(d)
    expect((await w.next()).statusCode).toBe(200)
    for (const e of [
      { type: 'boot', seconds: 9.37, restored: true },
      { type: 'phase', phase: 'screening' },
      { type: 'phase', phase: 'building' },
      { type: 'progress', text: 'Running: blender -b' }, // a command: the page doesn't show it
      { type: 'progress', text: 'Shaping the brim.' },
      { type: 'progress', text: 'Adding the visor.' },
      { type: 'phase', phase: 'checking' }, // the pieces' checks, after the agent
    ]) expect((await w.event(jobId, e)).statusCode).toBe(204)
    const t = await timingsOf(jobId) as JobTimings
    expect(t).toMatchObject({ machine: 'created', boot: 9.4, restored: true })
    for (const k of ['taken', 'screening', 'building', 'firstProgress'] as const) expect(t[k]).toBeGreaterThanOrEqual(0)
    expect(t.screening!).toBeLessThanOrEqual(t.building!)
    expect(t.building!).toBeLessThanOrEqual(t.firstProgress!)
    expect(t.done).toBeUndefined()
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    expect((await w.result(jobId, okResult(jobId))).statusCode).toBe(204)
    const done = await timingsOf(jobId) as JobTimings
    expect(done.done).toBeGreaterThanOrEqual(done.firstProgress!)
    const lines = log.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('timing:'))
    expect(lines).toEqual([expect.stringMatching(new RegExp(`^\\[studio\\] job ${jobId} timing: machine=created taken=\\d+s boot=9s screening=\\d+s building=\\d+s first_progress=\\d+s done=\\d+s$`))])
    // ids and seconds only
    expect(lines[0]).not.toMatch(/neon|visor|cap|brim|rounded/i)
  })

  it('works with a worker that sends none of the new events', async () => {
    const d = await createDesign(owner)
    const jobId = await send(d)
    const w = await worker(d)
    await w.next()
    await w.event(jobId, { type: 'phase', phase: 'building' })
    await w.event(jobId, { type: 'progress', text: 'Shaping the brim.' })
    await w.event(jobId, { type: 'phase', phase: 'checking' }) // the pieces' checks: not timed
    await w.result(jobId, okResult(jobId))
    const t = await timingsOf(jobId) as JobTimings
    expect(Object.keys(t).sort()).toEqual(['building', 'done', 'firstProgress', 'machine', 'taken'])
  })

  it('writes the first progress line once, and nothing for the ones after', async () => {
    const d = await createDesign(owner)
    const jobId = await send(d)
    const w = await worker(d)
    await w.next()
    await w.event(jobId, { type: 'progress', text: 'Shaping the brim.' })
    const first = (await timingsOf(jobId))!.firstProgress
    const update = vi.spyOn(db, 'update')
    for (let i = 0; i < 3; i++) expect((await w.event(jobId, { type: 'progress', text: `step ${i}` })).statusCode).toBe(204)
    expect(update).not.toHaveBeenCalled()
    update.mockRestore()
    expect((await timingsOf(jobId))!.firstProgress).toBe(first)
  })

  it('refuses a malformed boot event and records nothing for it', async () => {
    const d = await createDesign(owner)
    const jobId = await send(d)
    const w = await worker(d)
    await w.next()
    for (const e of [{ type: 'boot' }, { type: 'boot', seconds: -1, restored: true }, { type: 'boot', seconds: 5, restored: 'yes' }, { type: 'boot', seconds: 1e9, restored: true }]) {
      expect((await w.event(jobId, e)).statusCode).toBe(400)
    }
    expect(await timingsOf(jobId)).not.toHaveProperty('boot')
  })

  it('times prompt jobs only', async () => {
    const d = await createDesign(owner)
    const job = await queueJob(d, { type: 'render', render: { categories: ['hat'] } })
    const w = await worker(d)
    await w.next()
    expect((await w.event(job.id, { type: 'phase', phase: 'rendering' })).statusCode).toBe(204)
    expect((await w.event(job.id, { type: 'boot', seconds: 3, restored: false })).statusCode).toBe(204)
    await w.result(job.id, okResult(job.id, { pieces: [] }))
    expect(await timingsOf(job.id)).toBeNull()
  })

  it('says how the machine was got: created, started, running, or run by hand', async () => {
    const d = await createDesign(owner)
    const finish = async (id: string) => {
      await db.update(studioJobs).set({ status: 'done', finishedAt: new Date() }).where(eq(studioJobs.id, id))
      await db.delete(studioUsageDays) // a free account has 3 prompts a day
    }
    const a = await send(d)
    expect((await timingsOf(a))!.machine).toBe('created')
    await finish(a)
    const b = await send(d)
    expect((await timingsOf(b))!.machine).toBe('running')
    await finish(b)
    fly.machines.get('m1')!.state = 'stopped'
    const c = await send(d)
    expect((await timingsOf(c))!.machine).toBe('started')
    await finish(c)
    ;(config as any).studioMachines = 'external'
    const e = await send(d)
    expect((await timingsOf(e))!.machine).toBe('external')
  })

  it('a job failed as lost finishes its timings and logs the line', async () => {
    const d = await createDesign(owner)
    const jobId = await send(d)
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    expect(await failJobs([jobId], 'The studio machine did not start.', new Date())).toBe(1)
    expect((await timingsOf(jobId))!.done).toBeGreaterThanOrEqual(0)
    expect(log.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('timing:'))).toEqual([
      expect.stringMatching(new RegExp(`^\\[studio\\] job ${jobId} timing: machine=created done=\\d+s$`)),
    ])
  })

  describe('the numbers', () => {
    it('median, 90th percentile and the log line', () => {
      expect(median([])).toBeNull()
      expect(median([5, 1, 3])).toBe(3)
      expect(median([4, 1, 3, 2])).toBe(2.5)
      expect(p90([])).toBeNull()
      expect(p90([7])).toBe(7)
      expect(p90(Array.from({ length: 10 }, (_, i) => i + 1))).toBe(9)
      expect(p90(Array.from({ length: 20 }, (_, i) => i + 1))).toBe(18)
      expect(timingLine('j1', { machine: 'created', taken: 24.4, boot: 9, screening: 31, building: 35.2, firstProgress: 52, done: 309.6 }))
        .toBe('[studio] job j1 timing: machine=created taken=24s boot=9s screening=31s building=35s first_progress=52s done=310s')
      expect(timingLine('j2', {})).toBe('[studio] job j2 timing: machine=unknown')
    })
  })

  describe('the admin card and the typical wait', () => {
    const timed = async (d: { id: string }, rows: JobTimings[], start = Date.now() - 3600_000) => {
      let i = 0
      for (const timings of rows) {
        await db.insert(studioJobs).values({ designId: d.id, type: 'prompt', status: 'done', payload: {}, timings, createdAt: new Date(start + 1000 * i++) })
      }
    }

    it('medians and 90th percentiles by machine, over the last 50 timed prompt jobs', async () => {
      const d = await createDesign(owner)
      // older than the last 50: never counted
      await timed(d, Array.from({ length: 5 }, () => ({ machine: 'created', firstProgress: 999 })), Date.now() - 7200_000)
      await timed(d, [
        ...Array.from({ length: 10 }, (_, i) => ({ machine: 'created' as const, taken: 20 + i, boot: 8, firstProgress: 40 + i, done: 300 })),
        ...Array.from({ length: 20 }, (_, i) => ({ machine: 'started' as const, taken: 2, boot: 6, screening: 9, building: 10, firstProgress: 15 + i })),
        ...Array.from({ length: 19 }, () => ({ machine: 'running' as const, taken: 1, firstProgress: 5 })),
        { machine: 'running', taken: 1 }, // no progress line: counted for its steps only
      ])
      await db.insert(studioJobs).values({ designId: d.id, type: 'prompt', status: 'done', payload: {} }) // no timings
      const admin = await createUser({ role: 'admin' })
      const res = await app.inject({ method: 'GET', url: '/api/admin/studio/first-reply', headers: { authorization: `Bearer ${tokenFor(admin)}` } })
      expect(res.statusCode).toBe(200)
      const s = res.json()
      expect(s).toEqual(await firstReplyStats())
      expect(s.jobs).toBe(50)
      expect(s.byMachine.created).toEqual({ jobs: 10, median: 44.5, p90: 48 })
      expect(s.byMachine.started).toEqual({ jobs: 20, median: 24.5, p90: 32 })
      expect(s.byMachine.running).toEqual({ jobs: 19, median: 5, p90: 5 })
      expect(s.firstReply.jobs).toBe(49)
      expect(s.steps).toMatchObject({ taken: 2, boot: 6, screening: 9, building: 10, done: 300 })
    })

    it('is for admins only', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/admin/studio/first-reply', headers: { authorization: `Bearer ${tokenFor(owner)}` } })
      expect(res.statusCode).toBe(403)
    })

    it('the design detail says the usual wait from 5 timed jobs, and nothing below', async () => {
      const d = await createDesign(owner)
      await timed(d, [10, 20, 30, 40].map((firstProgress) => ({ machine: 'running', firstProgress })))
      const detail = async () => (await app.inject({ method: 'GET', url: `/api/studio/designs/${d.id}`, headers: { authorization: `Bearer ${tokenFor(owner)}` } })).json()
      expect(await detail()).not.toHaveProperty('typicalFirstReplySec')
      await timed(d, [{ machine: 'created', firstProgress: 51.6 }])
      expect(await detail()).not.toHaveProperty('typicalFirstReplySec') // cached for a few minutes
      clearTypicalCache()
      expect((await detail()).typicalFirstReplySec).toBe(30)
    })
  })
})
