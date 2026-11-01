import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest'
import { eq } from 'drizzle-orm'
import { Readable } from 'node:stream'
import { createRequire } from 'node:module'
import { db } from '../src/db/connection.js'
import { studioJobs, studioPieces, studioRevisions, studioRenders, studioMessages, studioDesigns, studioUsageDays } from '../src/db/schema.js'
import { config } from '../src/config.js'
import { initBus } from '../src/realtime/bus.js'
import { memoryStudioStore, setStudioStore } from '../src/studio/store.js'
import { reservePrompt, promptStatus } from '../src/studio/quota.js'
import { studioTopic } from '../src/studio/events.js'
import { resetDb } from './helpers/db.js'
import { testApp, createUser } from './helpers/factories.js'
import { createDesign, issueWorker, queueJob, okResult } from './helpers/studio.js'

const { LocalPresence } = createRequire(import.meta.url)('colyseus') as any
const W = '/api/studio/worker'
const auth = (t: string) => ({ authorization: `Bearer ${t}` })

describe('studio worker routes', () => {
  let app: Awaited<ReturnType<typeof testApp>>
  let store: ReturnType<typeof memoryStudioStore>
  const prev = config.studioEnabled
  beforeAll(() => { (config as any).studioEnabled = true })
  afterAll(() => { (config as any).studioEnabled = prev; setStudioStore(null) })
  beforeEach(async () => {
    await resetDb()
    store = memoryStudioStore()
    setStudioStore(store)
    app = await testApp()
  })

  async function setup() {
    const owner = await createUser()
    const design = await createDesign(owner)
    const token = await issueWorker(design)
    return { owner, design, token }
  }
  const take = async (jobId: string) => db.update(studioJobs).set({ status: 'taken', takenAt: new Date() }).where(eq(studioJobs.id, jobId))
  const result = (token: string, jobId: string, body: unknown) =>
    app.inject({ method: 'POST', url: `${W}/jobs/${jobId}/result`, headers: auth(token), payload: body as any })

  it('token only works for its own design', async () => {
    const a = await setup()
    const b = await setup()
    const bJob = await queueJob(b.design)
    await take(bJob.id)
    const calls = [
      { method: 'GET', url: `${W}/designs/${b.design.id}/workspace` },
      { method: 'PUT', url: `${W}/designs/${b.design.id}/workspace`, payload: Buffer.from('x'), headers: { 'content-type': 'application/gzip' } },
      { method: 'GET', url: `${W}/designs/${b.design.id}/jobs/next` },
      { method: 'POST', url: `${W}/jobs/${bJob.id}/events`, payload: { type: 'phase', phase: 'building' } },
      { method: 'PUT', url: `${W}/jobs/${bJob.id}/files/pieces/hat/a.glb`, payload: Buffer.from('x'), headers: { 'content-type': 'model/gltf-binary' } },
      { method: 'POST', url: `${W}/jobs/${bJob.id}/result`, payload: okResult(bJob.id) },
    ] as const
    for (const c of calls) {
      const res = await app.inject({ ...c, headers: { ...auth(a.token), ...('headers' in c ? c.headers : {}) } } as any)
      expect(res.statusCode, `${c.method} ${c.url}`).toBe(403)
      const none = await app.inject({ ...c, headers: { ...('headers' in c ? c.headers : {}) } } as any)
      expect(none.statusCode).toBe(401)
      const wrong = await app.inject({ ...c, headers: { ...auth('nope'), ...('headers' in c ? c.headers : {}) } } as any)
      expect(wrong.statusCode).toBe(401)
    }
    expect((await db.select().from(studioJobs).where(eq(studioJobs.id, bJob.id)))[0].status).toBe('taken')
  })

  it('a request without a worker token is refused before its body is read', async () => {
    const { design } = await setup()
    const job = await queueJob(design)
    // A body that takes 5 s to arrive: an answer within 2 s proves auth ran before the body was read
    const endless = () => {
      let sent = false
      return new Readable({
        read() {
          if (sent) return
          sent = true
          this.push(Buffer.alloc(64 * 1024))
          setTimeout(() => this.push(null), 5000)
        },
      })
    }
    const calls = [
      { method: 'PUT', url: `${W}/designs/${design.id}/workspace`, headers: { 'content-type': 'application/gzip' } },
      { method: 'POST', url: `${W}/jobs/${job.id}/result`, headers: { 'content-type': 'application/octet-stream' } },
      { method: 'PUT', url: `${W}/jobs/${job.id}/files/pieces/hat/a.glb`, headers: { 'content-type': 'model/gltf-binary' } },
    ]
    for (const c of calls) {
      const res = await Promise.race([
        app.inject({ ...c, payload: endless() } as any),
        new Promise<'hung'>((r) => setTimeout(() => r('hung'), 2000)),
      ])
      expect(res === 'hung' ? 'hung' : res.statusCode, c.url).toBe(401)
    }
  })

  it('the result route takes only JSON', async () => {
    const { design, token } = await setup()
    const job = await queueJob(design)
    await take(job.id)
    const res = await app.inject({ method: 'POST', url: `${W}/jobs/${job.id}/result`, headers: { ...auth(token), 'content-type': 'application/octet-stream' }, payload: Buffer.from('{}') })
    expect(res.statusCode).toBe(415)
  })

  it('workspaces stream to and from the store', async () => {
    const { design, token } = await setup()
    const streamed = { put: 0, get: 0 }
    setStudioStore({
      ...store,
      put: async () => { throw new Error('buffered put') },
      get: async () => { throw new Error('buffered get') },
      putStream: async (key: string, body: Readable, length: number, type: string) => { streamed.put++; return store.putStream(key, body, length, type) },
      getStream: async (key: string) => { streamed.get++; return store.getStream(key) },
    } as any)
    const bytes = Buffer.alloc(3 * 1024 * 1024, 7)
    const put = await app.inject({ method: 'PUT', url: `${W}/designs/${design.id}/workspace`, headers: { ...auth(token), 'content-type': 'application/gzip' }, payload: bytes })
    expect(put.statusCode).toBe(204)
    const got = await app.inject({ method: 'GET', url: `${W}/designs/${design.id}/workspace`, headers: auth(token) })
    expect(got.statusCode).toBe(200)
    expect(got.rawPayload.equals(bytes)).toBe(true)
    expect(streamed).toEqual({ put: 1, get: 1 })
    const empty = await app.inject({ method: 'PUT', url: `${W}/designs/${design.id}/workspace`, headers: { ...auth(token), 'content-type': 'application/gzip' }, payload: Buffer.alloc(0) })
    expect(empty.statusCode).toBe(400)
  })

  it('studio worker routes are 404 when the studio is off', async () => {
    const { design, token } = await setup()
    ;(config as any).studioEnabled = false
    try {
      const res = await app.inject({ method: 'GET', url: `${W}/designs/${design.id}/jobs/next`, headers: auth(token) })
      expect(res.statusCode).toBe(404)
    } finally {
      ;(config as any).studioEnabled = true
    }
  })

  it('workspace round-trips and is private', async () => {
    const { design, token } = await setup()
    expect((await app.inject({ method: 'GET', url: `${W}/designs/${design.id}/workspace`, headers: auth(token) })).statusCode).toBe(404)
    const bytes = Buffer.from([0x1f, 0x8b, 1, 2, 3, 4])
    const put = await app.inject({ method: 'PUT', url: `${W}/designs/${design.id}/workspace`, headers: { ...auth(token), 'content-type': 'application/gzip' }, payload: bytes })
    expect(put.statusCode).toBe(204)
    const got = await app.inject({ method: 'GET', url: `${W}/designs/${design.id}/workspace`, headers: auth(token) })
    expect(got.statusCode).toBe(200)
    expect(got.rawPayload.equals(bytes)).toBe(true)
    expect(store.keys()).toEqual([`designs/${design.id}/workspace.tar.gz`])
  })

  it('jobs/next hands each job out once, oldest first', async () => {
    const { design, token } = await setup()
    const first = await queueJob(design)
    const second = await queueJob(design, { type: 'render', render: { categories: ['hat'], bodyShape: 'male', outfit: 'default', emote: null } })
    const res = await Promise.all([1, 2, 3].map(() => app.inject({ method: 'GET', url: `${W}/designs/${design.id}/jobs/next`, headers: auth(token) })))
    const jobs = res.filter((r) => r.statusCode === 200).map((r) => r.json())
    expect(res.filter((r) => r.statusCode === 204)).toHaveLength(1)
    expect(jobs.map((j) => j.jobId).sort()).toEqual([first.id, second.id].sort())
    const one = jobs.find((j) => j.jobId === first.id)
    expect(one).toMatchObject({ type: 'prompt', agent: 'claude', model: 'claude-opus-5-5', limits: { timeoutSec: 1500 } })
    const seq = await app.inject({ method: 'GET', url: `${W}/designs/${design.id}/jobs/next`, headers: auth(token) })
    expect(seq.statusCode).toBe(204)
    const rows = await db.select().from(studioJobs)
    expect(rows.every((r) => r.status === 'taken' && r.takenAt)).toBe(true)
  })

  it('jobs/next gives the oldest job first', async () => {
    const { design, token } = await setup()
    const first = await queueJob(design, { type: 'render', render: {} })
    await queueJob(design, { type: 'render', render: {} })
    const res = await app.inject({ method: 'GET', url: `${W}/designs/${design.id}/jobs/next`, headers: auth(token) })
    expect(res.json().jobId).toBe(first.id)
  })

  it('takes asked-for jobs before background ones', async () => {
    const { design, token } = await setup()
    await queueJob(design, { type: 'render', render: {} }, { background: true, createdAt: new Date(Date.now() - 1000) })
    const asked = await queueJob(design, { type: 'render', render: {} })
    const res = await app.inject({ method: 'GET', url: `${W}/designs/${design.id}/jobs/next`, headers: auth(token) })
    expect(res.json().jobId).toBe(asked.id)
  })

  it('file paths are checked', async () => {
    const { design, token } = await setup()
    const job = await queueJob(design)
    await take(job.id)
    const put = (path: string) => app.inject({
      method: 'PUT', url: `${W}/jobs/${job.id}/files/${path}`, headers: { ...auth(token), 'content-type': 'model/gltf-binary' }, payload: Buffer.from('glb'),
    })
    expect((await put('pieces%2Fhat%2F..%2F..%2Fx.glb')).statusCode).toBe(400)
    expect((await put('pieces/hat/%2E%2E/%2E%2E/x.glb')).statusCode).toBe(400)
    expect((await put('renders/hat/spin/1.webp')).statusCode).toBe(400)
    expect((await put('pieces/hat/cap_male.glb')).statusCode).toBe(204)
    const stored = await store.get(`designs/${design.id}/jobs/${job.id}/pieces/hat/cap_male.glb`)
    expect(stored?.body.toString()).toBe('glb')
    expect(stored?.contentType).toBe('model/gltf-binary')
    await db.update(studioJobs).set({ status: 'done' }).where(eq(studioJobs.id, job.id))
    expect((await put('pieces/hat/cap_male.glb')).statusCode).toBe(409)
  })

  it('file uploads keep their bytes whatever their content type', async () => {
    const { design, token } = await setup()
    const job = await queueJob(design)
    await take(job.id)
    const files = [
      ['pieces/hat/piece.json', 'application/json', '{"name": "Neon Cap"}'],
      ['checks/hat.txt', 'text/plain; charset=utf-8', 'PASS everything\n'],
    ]
    for (const [path, type, text] of files) {
      const res = await app.inject({ method: 'PUT', url: `${W}/jobs/${job.id}/files/${path}`, headers: { ...auth(token), 'content-type': type }, payload: text })
      expect(res.statusCode, `${path}: ${res.body}`).toBe(204)
      const got = await store.get(`designs/${design.id}/jobs/${job.id}/${path}`)
      expect(got?.body.toString()).toBe(text)
    }
  })

  it('an ok prompt result makes revisions, renders and a reply', async () => {
    const { owner, design, token } = await setup()
    await db.update(studioDesigns).set({ status: 'building' }).where(eq(studioDesigns.id, design.id))
    const job = await queueJob(design)
    await take(job.id)
    const res = await result(token, job.id, okResult(job.id))
    expect(res.statusCode).toBe(204)
    const [piece] = await db.select().from(studioPieces)
    expect(piece).toMatchObject({ category: 'hat', name: 'Neon Cap' })
    const [rev] = await db.select().from(studioRevisions)
    expect(rev).toMatchObject({ pieceId: piece.id, number: 1, jobId: job.id, changeKind: 'new', checker: { pass: true, failures: 0, warnings: 1 } })
    expect(rev.files).toContain('pieces/hat/neon_cap_male.glb')
    expect(piece.latestRevisionId).toBe(rev.id)
    const [render] = await db.select().from(studioRenders)
    expect(render).toMatchObject({ revisionId: rev.id, viewKey: 'spin-male-default', frames: 36, status: 'ready', jobId: job.id })
    const msgs = await db.select().from(studioMessages)
    expect(msgs).toHaveLength(1)
    expect(msgs[0]).toMatchObject({ role: 'agent', agent: 'claude', text: 'I built a rounded cap with a neon visor strip...', jobId: job.id })
    expect((await db.select().from(studioDesigns))[0].status).toBe('idle')
    const [usage] = await db.select().from(studioUsageDays).where(eq(studioUsageDays.userId, owner.id))
    expect(usage.costUsd).toBeCloseTo(0.74)
    expect((await db.select().from(studioJobs))[0]).toMatchObject({ status: 'done', result: { outcome: 'ok' } })
  })

  it('a second prompt result makes revision 2', async () => {
    const { design, token } = await setup()
    const j1 = await queueJob(design)
    await take(j1.id)
    await result(token, j1.id, okResult(j1.id))
    await db.update(studioJobs).set({ status: 'done' }).where(eq(studioJobs.id, j1.id))
    const j2 = await queueJob(design)
    await take(j2.id)
    await result(token, j2.id, okResult(j2.id))
    const revs = await db.select().from(studioRevisions)
    expect(revs.map((r) => r.number).sort()).toEqual([1, 2])
    const [piece] = await db.select().from(studioPieces)
    expect(piece.latestRevisionId).toBe(revs.find((r) => r.number === 2)!.id)
  })

  it('no_change makes no revision', async () => {
    const { design, token } = await setup()
    const job = await queueJob(design)
    await take(job.id)
    const base = okResult(job.id)
    const res = await result(token, job.id, { ...base, outcome: 'no_change', pieces: [{ ...base.pieces[0], changed: false, files: [], renders: {} }] })
    expect(res.statusCode).toBe(204)
    expect(await db.select().from(studioRevisions)).toHaveLength(0)
    expect(await db.select().from(studioMessages)).toHaveLength(1)
  })

  it('an error result gives the prompt back', async () => {
    const { owner, design, token } = await setup()
    const now = new Date()
    const r = await reservePrompt(owner.id, now, { counted: true })
    expect(r.ok).toBe(true)
    const job = await queueJob(design, undefined, { counted: true, countedDay: (r as any).day })
    await take(job.id)
    expect((await promptStatus(owner.id, now)).used).toBe(1)
    const res = await result(token, job.id, okResult(job.id, { outcome: 'error', pieces: [], reply: null, costUsd: 0.1, error: 'render failed' }))
    expect(res.statusCode).toBe(204)
    expect((await promptStatus(owner.id, now)).used).toBe(0)
    expect((await db.select().from(studioJobs))[0].status).toBe('failed')
    const msgs = await db.select().from(studioMessages)
    expect(msgs.some((m) => m.role === 'system')).toBe(true)
  })

  it('result is idempotent', async () => {
    const { owner, design, token } = await setup()
    const now = new Date()
    const r = await reservePrompt(owner.id, now, { counted: true })
    await reservePrompt(owner.id, now, { counted: true })
    const job = await queueJob(design, undefined, { counted: true, countedDay: (r as any).day })
    await take(job.id)
    const body = okResult(job.id, { outcome: 'error', error: 'boom', reply: 'partial', pieces: [] })
    expect((await result(token, job.id, body)).statusCode).toBe(204)
    expect((await result(token, job.id, body)).statusCode).toBe(204)
    expect((await promptStatus(owner.id, now)).used).toBe(1)
    expect((await db.select().from(studioMessages)).filter((m) => m.jobId === job.id)).toHaveLength(2) // reply + system note
    const ok = await queueJob(design)
    await take(ok.id)
    await result(token, ok.id, okResult(ok.id))
    await result(token, ok.id, okResult(ok.id))
    expect(await db.select().from(studioRevisions)).toHaveLength(1)
    expect((await db.select().from(studioMessages)).filter((m) => m.jobId === ok.id)).toHaveLength(1)
  })

  it('a malformed result is 400', async () => {
    const { design, token } = await setup()
    const job = await queueJob(design)
    await take(job.id)
    expect((await result(token, job.id, { outcome: 'great' })).statusCode).toBe(400)
    const bad = okResult(job.id)
    bad.pieces[0].files = ['pieces/hat/../../x.glb']
    expect((await result(token, job.id, bad)).statusCode).toBe(400)
    expect((await db.select().from(studioJobs))[0].status).toBe('taken')
  })

  it('a render result readies its view', async () => {
    const { design, token } = await setup()
    const p = await queueJob(design)
    await take(p.id)
    await result(token, p.id, okResult(p.id))
    const [rev] = await db.select().from(studioRevisions)
    const rj = await queueJob(design, { type: 'render', render: { categories: ['hat'], bodyShape: 'female', outfit: 'default', emote: null } })
    await db.insert(studioRenders).values({ revisionId: rev.id, viewKey: 'spin-female-default', jobId: rj.id, status: 'queued' })
    await take(rj.id)
    const res = await result(token, rj.id, { jobId: rj.id, outcome: 'ok', agent: null, model: null, costUsd: null, tokens: null, reply: null, proposal: null, error: null, pieces: [{ category: 'hat', renders: { 'spin-female-default': 36 } }] })
    expect(res.statusCode).toBe(204)
    const row = (await db.select().from(studioRenders)).find((r) => r.viewKey === 'spin-female-default')!
    expect(row).toMatchObject({ status: 'ready', frames: 36 })
  })

  it('progress events reach the bus', async () => {
    const presence = new LocalPresence()
    initBus(presence as any)
    const { design, token } = await setup()
    const job = await queueJob(design)
    await take(job.id)
    const seen: unknown[] = []
    await presence.subscribe(studioTopic(design.id), (m: unknown) => seen.push(m))
    const res = await app.inject({ method: 'POST', url: `${W}/jobs/${job.id}/events`, headers: auth(token), payload: { type: 'progress', text: 'Running blender' } })
    expect(res.statusCode).toBe(204)
    expect((await app.inject({ method: 'POST', url: `${W}/jobs/${job.id}/events`, headers: auth(token), payload: { type: 'nope' } })).statusCode).toBe(400)
    await new Promise((r) => setTimeout(r, 20))
    expect(seen).toContainEqual({ type: 'progress', jobId: job.id, text: 'Running blender' })
  })
})
