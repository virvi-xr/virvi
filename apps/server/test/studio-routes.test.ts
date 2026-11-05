import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '../src/db/connection.js'
import { studioDesigns, studioJobs, studioMessages, studioPieces, studioPromptCredits, studioRenders, studioRevisions } from '../src/db/schema.js'
import { config } from '../src/config.js'
import { memoryStudioStore, setStudioStore, jobFileKey } from '../src/studio/store.js'
import { setMachineDeps } from '../src/studio/machines.js'
import { promptStatus } from '../src/studio/quota.js'
import { addCredit } from '../src/studio/credit.js'
import { signRenderFrame, verifyRenderFrame } from '../src/studio/render-urls.js'
import { viewKey } from '../src/studio/designs.js'
import { resetDb } from './helpers/db.js'
import { testApp, createUser, tokenFor, type TestUser } from './helpers/factories.js'
import { buildApp } from '../src/app.js'
import { createDesign, fakeFly, okResult, issueWorker } from './helpers/studio.js'

const S = '/api/studio'

describe('studio dashboard routes', () => {
  let app: Awaited<ReturnType<typeof testApp>>
  let store: ReturnType<typeof memoryStudioStore>
  let fly: ReturnType<typeof fakeFly>
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
    fly = fakeFly()
    setMachineDeps({ fly })
    app = await testApp()
  })

  const as = (u: TestUser) => ({ authorization: `Bearer ${tokenFor(u)}` })
  const create = (u: TestUser, body: Record<string, unknown> = { kind: 'wearable', agent: 'claude' }) =>
    app.inject({ method: 'POST', url: `${S}/designs`, headers: as(u), payload: body })
  const prompt = (u: TestUser, id: string, body: Record<string, unknown> = { text: 'a neon cap', selectedSlots: ['hat'] }) =>
    app.inject({ method: 'POST', url: `${S}/designs/${id}/prompts`, headers: as(u), payload: body })
  const finish = async (jobId: string, result: Record<string, unknown>) => {
    const [job] = await db.select().from(studioJobs).where(eq(studioJobs.id, jobId))
    const [d] = await db.select().from(studioDesigns).where(eq(studioDesigns.id, job.designId))
    const token = await issueWorker(d, d.machineId ?? 'm-test')
    await db.update(studioJobs).set({ status: 'taken', takenAt: new Date() }).where(eq(studioJobs.id, jobId))
    const res = await app.inject({ method: 'POST', url: `/api/studio/worker/jobs/${jobId}/result`, headers: { authorization: `Bearer ${token}` }, payload: result as any })
    expect(res.statusCode).toBe(204)
  }

  /** A design with a built hat (revision 1, spin-male-default ready with 3 stored frames). */
  async function builtHat(u: TestUser) {
    const d = (await create(u)).json()
    const jobId = (await prompt(u, d.id)).json().jobId
    const r = okResult(jobId)
    r.pieces[0].renders = { 'spin-male-default': 3 }
    await finish(jobId, r)
    for (let i = 0; i < 3; i++) {
      await store.put(jobFileKey(d.id, jobId, `renders/hat/spin-male-default/00${i}.webp`), Buffer.from(`frame${i}`), 'image/webp')
    }
    return { design: d, jobId }
  }

  it('studio routes are 404 when the studio is off', async () => {
    const u = await createUser()
    ;(config as any).studioEnabled = false
    try {
      expect((await app.inject({ method: 'GET', url: `${S}/usage`, headers: as(u) })).statusCode).toBe(404)
      expect((await create(u)).statusCode).toBe(404)
      expect((await app.inject({ method: 'GET', url: `${S}/render-frames/abc` })).statusCode).toBe(404)
    } finally {
      ;(config as any).studioEnabled = true
    }
  })

  it('usage names the top-up price', async () => {
    const u = await createUser()
    const usage = (await app.inject({ method: 'GET', url: `${S}/usage`, headers: as(u) })).json()
    expect(usage.topup).toEqual({ cents: 500, prompts: 10 })
  })

  it('usage names the Virvi credit balance, and whether MANA is on', async () => {
    const u = await createUser()
    const prevRecipient = config.studioMana.recipient
    try {
      ;(config.studioMana as any).recipient = null
      const off = (await app.inject({ method: 'GET', url: `${S}/usage`, headers: as(u) })).json()
      expect(off).toMatchObject({ creditCents: 0, mana: false })
      await db.transaction((tx) => addCredit(tx, u.id, 1500, 'refund', null, new Date()))
      ;(config.studioMana as any).recipient = '0x01d871870CbBddE934526E17637c0cfEf0b3b38B'
      const on = (await app.inject({ method: 'GET', url: `${S}/usage`, headers: as(u) })).json()
      expect(on).toMatchObject({ creditCents: 1500, mana: true })
    } finally {
      ;(config.studioMana as any).recipient = prevRecipient
    }
  })

  it('a finalized design is not open', async () => {
    const u = await createUser()
    const first = (await create(u)).json()
    expect(first.finalizedAt).toBeNull()
    await db.update(studioDesigns).set({ finalizedAt: new Date() }).where(eq(studioDesigns.id, first.id))
    expect((await create(u, { kind: 'emote', agent: 'codex' })).statusCode).toBe(201)
    const usage = await app.inject({ method: 'GET', url: `${S}/usage`, headers: as(u) })
    expect(usage.json().openDesigns).toBe(1)
  })

  it('creating designs respects the agent list and the open-design limit', async () => {
    const u = await createUser()
    const gpt = await create(u, { kind: 'wearable', agent: 'gpt' })
    expect(gpt.statusCode).toBe(400)
    expect(gpt.json().error).toBe('agent must be claude, codex or grok')
    expect((await create(u, { kind: 'cape', agent: 'claude' })).statusCode).toBe(400)
    const first = await create(u, { kind: 'wearable', agent: 'claude', name: 'Cap' })
    expect(first.statusCode).toBe(201)
    expect(first.json()).toMatchObject({ name: 'Cap', kind: 'wearable', agent: 'claude', status: 'idle' })
    expect(first.json()).not.toHaveProperty('workerTokenHash')
    const second = await create(u, { kind: 'emote', agent: 'codex' })
    expect(second.statusCode).toBe(403)
    expect(second.json().code).toBe('open_design_limit')
    const arch = await app.inject({ method: 'PATCH', url: `${S}/designs/${first.json().id}`, headers: as(u), payload: { archived: true } })
    expect(arch.statusCode).toBe(200)
    expect((await create(u, { kind: 'emote', agent: 'codex' })).statusCode).toBe(201)
    const unarch = await app.inject({ method: 'PATCH', url: `${S}/designs/${first.json().id}`, headers: as(u), payload: { archived: false } })
    expect(unarch.statusCode).toBe(403)
    const list = await app.inject({ method: 'GET', url: `${S}/designs?archived=true`, headers: as(u) })
    expect(list.json().map((d: any) => d.id)).toEqual([first.json().id])
    const open = await app.inject({ method: 'GET', url: `${S}/designs`, headers: as(u) })
    expect(open.json()).toHaveLength(1)
    const usage = (await app.inject({ method: 'GET', url: `${S}/usage`, headers: as(u) })).json()
    expect(usage).toMatchObject({ plan: 'free', promptsLeft: 3, allowance: 3, openDesigns: 1, openDesignLimit: 1 })
  })

  it('a prompt is queued, counted and starts the worker', async () => {
    const u = await createUser()
    const d = (await create(u)).json()
    const res = await prompt(u, d.id)
    expect(res.statusCode).toBe(202)
    const [job] = await db.select().from(studioJobs).where(eq(studioJobs.id, res.json().jobId))
    expect(job.payload).toEqual({
      type: 'prompt', kind: 'wearable', agent: 'claude', model: 'claude-opus-5-5', prompt: 'a neon cap', selectedSlots: ['hat'],
      limits: { timeoutSec: 1500, maxTurns: 80, costCeilingUsd: 3 }, render: null, uploads: [], check: true,
    })
    expect(job).toMatchObject({ status: 'queued', counted: true })
    expect((await app.inject({ method: 'GET', url: `${S}/usage`, headers: as(u) })).json().promptsLeft).toBe(2)
    expect(fly.calls.create).toHaveLength(1)
    const detail = (await app.inject({ method: 'GET', url: `${S}/designs/${d.id}`, headers: as(u) })).json()
    expect(detail.design.status).toBe('building')
    expect(detail.activeJob).toMatchObject({ id: job.id, type: 'prompt', status: 'queued' })
    expect(detail.messages).toMatchObject([{ role: 'user', text: 'a neon cap' }])
  })

  it('prompt input is checked', async () => {
    const u = await createUser()
    const d = (await create(u)).json()
    expect((await prompt(u, d.id, { text: '' })).statusCode).toBe(400)
    expect((await prompt(u, d.id, { text: 'x'.repeat(4001) })).statusCode).toBe(400)
    expect((await prompt(u, d.id, { text: 'a cap', selectedSlots: ['cape'] })).statusCode).toBe(400)
    const emote = await createDesign(u, { kind: 'emote' })
    expect((await prompt(u, emote.id, { text: 'a wave', selectedSlots: ['hat'] })).statusCode).toBe(400)
    expect((await prompt(u, d.id, { text: 'a cap', selectedSlots: null })).statusCode).toBe(202)
  })

  it('concurrent prompts accept one and count one', async () => {
    const u = await createUser()
    const d = (await create(u)).json()
    const res = await Promise.all([prompt(u, d.id), prompt(u, d.id)])
    expect(res.map((r) => r.statusCode).sort()).toEqual([202, 409])
    expect(res.find((r) => r.statusCode === 409)!.json().code).toBe('busy')
    expect((await promptStatus(u.id, new Date())).used).toBe(1)
    expect(await db.select().from(studioJobs)).toHaveLength(1)
    expect((await db.select().from(studioMessages)).filter((m) => m.role === 'user')).toHaveLength(1)
  })

  it('the fourth free prompt of the day is refused', async () => {
    const u = await createUser()
    const d = (await create(u)).json()
    for (let i = 0; i < 3; i++) {
      const r = await prompt(u, d.id)
      expect(r.statusCode).toBe(202)
      await finish(r.json().jobId, okResult(r.json().jobId, { outcome: 'no_change', pieces: [] }))
    }
    const res = await prompt(u, d.id)
    expect(res.statusCode).toBe(429)
    const now = new Date()
    const midnight = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1)).toISOString()
    expect(res.json()).toMatchObject({ code: 'allowance', resetsAt: midnight })
    expect(await db.select().from(studioJobs)).toHaveLength(3)
  })

  it('continue is free and only follows a ceiling', async () => {
    const u = await createUser()
    const d = (await create(u)).json()
    const first = (await prompt(u, d.id)).json().jobId
    await finish(first, okResult(first))
    expect((await prompt(u, d.id, { continue: true })).statusCode).toBe(409)
    const second = (await prompt(u, d.id)).json().jobId
    await finish(second, okResult(second, { outcome: 'ceiling', pieces: [], reply: null }))
    // the note points at the page's Continue button: typing "continue" would be a counted prompt
    const note = (await db.select().from(studioMessages)).find((m) => m.role === 'system' && m.jobId === second)
    expect(note?.text).toBe('The agent stopped at this prompt’s cost limit. Press Continue to carry on where it stopped: it doesn’t use a prompt.')
    const used = (await promptStatus(u.id, new Date())).used
    const res = await prompt(u, d.id, { continue: true })
    expect(res.statusCode).toBe(202)
    const [job] = await db.select().from(studioJobs).where(eq(studioJobs.id, res.json().jobId))
    expect(job.payload).toMatchObject({ prompt: 'Continue where you stopped.' })
    expect(job.counted).toBe(false)
    expect((await promptStatus(u.id, new Date())).used).toBe(used)
  })

  it('a Grok design runs grok-build-0.1 with more turns', async () => {
    const u = await createUser()
    const g = await create(u, { kind: 'wearable', agent: 'grok' })
    expect(g.statusCode).toBe(201)
    const [job] = await db.select().from(studioJobs).where(eq(studioJobs.id, (await prompt(u, g.json().id)).json().jobId))
    expect(job.payload).toMatchObject({ agent: 'grok', model: 'grok-build-0.1', limits: { timeoutSec: 1500, maxTurns: 150, costCeilingUsd: 3 } })
    const v = await createUser()
    const c = (await create(v, { kind: 'wearable', agent: 'codex' })).json()
    const [cj] = await db.select().from(studioJobs).where(eq(studioJobs.id, (await prompt(v, c.id)).json().jobId))
    expect(cj.payload).toMatchObject({ model: 'gpt-6.1-sol', limits: { maxTurns: 80 } })
  })

  it('a turn-limit stop keeps the prompt counted and offers Continue', async () => {
    const u = await createUser()
    const d = (await create(u)).json()
    const first = (await prompt(u, d.id)).json().jobId
    const used = (await promptStatus(u.id, new Date())).used
    await finish(first, okResult(first, { outcome: 'turns', pieces: [], reply: null, error: 'stopped at the step limit' }))
    const [done] = await db.select().from(studioJobs).where(eq(studioJobs.id, first))
    expect(done.status).toBe('done')
    expect((await promptStatus(u.id, new Date())).used).toBe(used)
    const note = (await db.select().from(studioMessages)).find((m) => m.role === 'system' && m.jobId === first)
    expect(note?.text).toBe('The agent stopped at this prompt’s step limit. Press Continue to carry on where it stopped: it doesn’t use a prompt.')
    const res = await prompt(u, d.id, { continue: true })
    expect(res.statusCode).toBe(202)
    const [job] = await db.select().from(studioJobs).where(eq(studioJobs.id, res.json().jobId))
    expect(job.counted).toBe(false)
    await finish(job.id, okResult(job.id))
    expect((await prompt(u, d.id, { continue: true })).json().code).toBe('nothing_to_continue')
  })

  it('an error refund returns a credit', async () => {
    const u = await createUser()
    await db.insert(studioPromptCredits).values({ userId: u.id, balance: 1 })
    const d = (await create(u)).json()
    for (let i = 0; i < 3; i++) {
      const id = (await prompt(u, d.id)).json().jobId
      await finish(id, okResult(id, { outcome: 'no_change', pieces: [] }))
    }
    const res = await prompt(u, d.id)
    expect(res.statusCode).toBe(202)
    const [job] = await db.select().from(studioJobs).where(eq(studioJobs.id, res.json().jobId))
    expect(job.countedFrom).toBe('credit')
    expect((await db.select().from(studioPromptCredits))[0].balance).toBe(0)
    await finish(job.id, okResult(job.id, { outcome: 'error', error: 'boom', pieces: [] }))
    expect((await db.select().from(studioPromptCredits))[0].balance).toBe(1)
    const usage = await app.inject({ method: 'GET', url: `${S}/usage`, headers: as(u) })
    expect(usage.json()).toMatchObject({ promptsLeft: 1, credits: 1 })
  })

  it('a fix prompt is free and names the failing pieces', async () => {
    const u = await createUser()
    const d = (await create(u)).json()
    const first = (await prompt(u, d.id)).json().jobId
    const r = okResult(first)
    r.pieces[0].checker = { pass: false, failures: 2, warnings: 0 }
    await finish(first, r)
    const used = (await promptStatus(u.id, new Date())).used
    const res = await prompt(u, d.id, { fixChecks: true })
    expect(res.statusCode).toBe(202)
    const [job] = await db.select().from(studioJobs).where(eq(studioJobs.id, res.json().jobId))
    expect(job.counted).toBe(false)
    expect(job.payload).toMatchObject({ prompt: 'Fix every FAIL the checker reported for: hat. Change nothing else.', selectedSlots: null })
    expect((await promptStatus(u.id, new Date())).used).toBe(used)
  })

  it('a fix prompt with nothing failing is 409', async () => {
    const u = await createUser()
    const { design } = await builtHat(u)
    const res = await prompt(u, design.id, { fixChecks: true })
    expect(res.statusCode).toBe(409)
    expect(res.json().code).toBe('nothing_to_fix')
  })

  it('start failure fails the job and refunds', async () => {
    const u = await createUser()
    const d = (await create(u)).json()
    fly.failCreate = () => new Error('no capacity in iad')
    const res = await prompt(u, d.id)
    expect(res.statusCode).toBe(202)
    const [job] = await db.select().from(studioJobs)
    expect(job.status).toBe('failed')
    expect((await promptStatus(u.id, new Date())).used).toBe(0)
    const msgs = await db.select().from(studioMessages)
    expect(msgs.find((m) => m.role === 'system')?.text).toMatch(/could not start.*not counted/)
    expect((await db.select().from(studioDesigns))[0].status).toBe('idle')
  })

  it('archived designs take no prompts', async () => {
    const u = await createUser()
    const d = (await create(u)).json()
    await app.inject({ method: 'PATCH', url: `${S}/designs/${d.id}`, headers: as(u), payload: { archived: true } })
    expect((await prompt(u, d.id)).statusCode).toBe(409)
  })

  it('render requests reuse a ready render and queue a missing one', async () => {
    const u = await createUser()
    const { design } = await builtHat(u)
    const ask = (view: Record<string, unknown>) =>
      app.inject({ method: 'POST', url: `${S}/designs/${design.id}/renders`, headers: as(u), payload: { category: 'hat', bodyShape: 'male', outfit: 'default', emote: null, ...view } })
    const ready = await ask({})
    expect(ready.statusCode).toBe(200)
    expect(ready.json()).toMatchObject({ status: 'ready', frames: 3 })
    expect(ready.json().urls).toHaveLength(3)
    const creates = fly.calls.create.length
    const queued = await ask({ bodyShape: 'female', outfit: 'outfit-2', emote: 'dance' })
    expect(queued.json()).toEqual({ status: 'queued' })
    expect((await ask({ bodyShape: 'female', outfit: 'outfit-2', emote: 'dance' })).json()).toEqual({ status: 'queued' })
    const renderJobs = (await db.select().from(studioJobs)).filter((j) => j.type === 'render')
    expect(renderJobs).toHaveLength(1)
    expect(renderJobs[0].payload).toMatchObject({ type: 'render', render: { categories: ['hat'], bodyShape: 'female', outfit: 'outfit-2', emote: 'dance' } })
    expect(renderJobs[0].counted).toBe(false)
    const row = (await db.select().from(studioRenders)).find((r) => r.viewKey === 'spin-female-outfit-2-dance')
    expect(row).toMatchObject({ status: 'queued', jobId: renderJobs[0].id })
    expect(fly.calls.create.length + fly.calls.start.length).toBeGreaterThanOrEqual(creates)
    expect((await ask({ category: 'eyewear' })).statusCode).toBe(404)
    expect((await ask({ outfit: 'outfit-9' })).statusCode).toBe(400)
  })

  it('view keys follow the contract', () => {
    expect(viewKey('wearable', { bodyShape: 'male', outfit: 'default', emote: null })).toBe('spin-male-default')
    expect(viewKey('wearable', { bodyShape: 'female', outfit: 'outfit-2', emote: 'dance' })).toBe('spin-female-outfit-2-dance')
    expect(viewKey('emote', { bodyShape: 'male', outfit: 'default', emote: null })).toBe('emote-male-default')
  })

  it('design detail shows renders with signed urls and never file paths', async () => {
    const u = await createUser()
    const { design } = await builtHat(u)
    const res = await app.inject({ method: 'GET', url: `${S}/designs/${design.id}`, headers: as(u) })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.pieces).toHaveLength(1)
    expect(body.pieces[0]).toMatchObject({ category: 'hat', name: 'Neon Cap', revision: { number: 1, changeKind: 'new', checker: { pass: true } } })
    expect(body.pieces[0].renders['spin-male-default']).toMatchObject({ status: 'ready', frames: 3 })
    expect(body.pieces[0].renders['spin-male-default'].urls[0]).toMatch(/\/api\/studio\/render-frames\//)
    expect(body.messages.map((m: any) => m.role)).toEqual(['user', 'agent'])
    expect(res.body).not.toMatch(/pieces\/|checks\/|workerToken|machine/)
  })

  it("design detail names the last prompt's outcome and when each view rendered", async () => {
    const u = await createUser()
    const { design } = await builtHat(u)
    const first = (await app.inject({ method: 'GET', url: `${S}/designs/${design.id}`, headers: as(u) })).json()
    expect(first.lastPrompt).toMatchObject({ outcome: 'ok', status: 'done' })
    expect(new Date(first.pieces[0].renders['spin-male-default'].renderedAt).toISOString())
      .toBe(first.pieces[0].renders['spin-male-default'].renderedAt)
    const second = (await prompt(u, design.id)).json().jobId
    await finish(second, okResult(second, { outcome: 'ceiling', pieces: [], reply: null }))
    const body = (await app.inject({ method: 'GET', url: `${S}/designs/${design.id}`, headers: as(u) })).json()
    expect(body.lastPrompt).toEqual({ jobId: second, outcome: 'ceiling', status: 'done' })
  })

  it('a new design has no last prompt', async () => {
    const u = await createUser()
    const d = (await create(u)).json()
    expect((await app.inject({ method: 'GET', url: `${S}/designs/${d.id}`, headers: as(u) })).json().lastPrompt).toBeNull()
  })

  it('render urls only open their own frame', async () => {
    const u = await createUser()
    const { design } = await builtHat(u)
    const detail = (await app.inject({ method: 'GET', url: `${S}/designs/${design.id}`, headers: as(u) })).json()
    const url: string = detail.pieces[0].renders['spin-male-default'].urls[1]
    const path = new URL(url).pathname
    const ok = await app.inject({ method: 'GET', url: path })
    expect(ok.statusCode, ok.body + ' ' + path).toBe(200)
    expect(ok.headers['content-type']).toBe('image/webp')
    expect(ok.headers['cache-control']).toBe('private, max-age=3600')
    expect(ok.body).toBe('frame1')

    const token = path.split('/').pop()!
    const [body, sig] = token.split('.')
    const claims = JSON.parse(Buffer.from(body, 'base64url').toString())
    const edited = Buffer.from(JSON.stringify({ ...claims, f: 2 })).toString('base64url') + '.' + sig
    expect((await app.inject({ method: 'GET', url: `${S}/render-frames/${edited}` })).statusCode).toBe(403)
    expect(verifyRenderFrame(token, new Date(Date.now() + 2 * 3600_000))).toBeNull()

    const expired = signRenderFrame(
      { designId: design.id, revisionId: claims.r, viewKey: 'spin-male-default', category: 'hat', frame: 0, jobId: claims.j },
      new Date(Date.now() - 1000),
    )
    expect((await app.inject({ method: 'GET', url: new URL(expired).pathname })).statusCode).toBe(403)

    const other = await builtHat(await createUser())
    const crossed = signRenderFrame(
      { designId: design.id, revisionId: claims.r, viewKey: 'spin-male-default', category: 'hat', frame: 0, jobId: other.jobId },
      new Date(Date.now() + 3600_000),
    )
    expect((await app.inject({ method: 'GET', url: new URL(crossed).pathname })).statusCode).toBe(403)
    expect((await app.inject({ method: 'GET', url: `${S}/render-frames/garbage` })).statusCode).toBe(403)
  })

  it('frame urls stay the same between reads, and a page can load many views', async () => {
    const u = await createUser()
    const { design } = await builtHat(u)
    const read = async () => (await app.inject({ method: 'GET', url: `${S}/designs/${design.id}`, headers: as(u) })).json().pieces[0].renders['spin-male-default'].urls
    const first = await read()
    await new Promise((r) => setTimeout(r, 1100))
    expect(await read()).toEqual(first)

    const limited = await buildApp({ logger: false, backfill: false }) // the global rate limit on, as in production
    await limited.ready()
    try {
      const path = new URL(first[0]).pathname
      const codes = new Set<number>()
      for (let i = 0; i < 150; i++) codes.add((await limited.inject({ method: 'GET', url: path })).statusCode)
      expect([...codes]).toEqual([200])
    } finally {
      await limited.close()
    }
  })

  it('designs of other users are 404', async () => {
    const owner = await createUser()
    const stranger = await createUser()
    const { design } = await builtHat(owner)
    const calls = [
      { method: 'GET', url: `${S}/designs/${design.id}` },
      { method: 'PATCH', url: `${S}/designs/${design.id}`, payload: { name: 'mine' } },
      { method: 'POST', url: `${S}/designs/${design.id}/prompts`, payload: { text: 'hi' } },
      { method: 'POST', url: `${S}/designs/${design.id}/renders`, payload: { category: 'hat', bodyShape: 'female', outfit: 'default', emote: null } },
    ]
    for (const c of calls) {
      const res = await app.inject({ ...c, headers: as(stranger) } as any)
      expect(res.statusCode, c.url).toBe(404)
    }
    expect((await db.select().from(studioJobs)).filter((j) => j.designId === design.id)).toHaveLength(1)
    expect((await app.inject({ method: 'GET', url: `${S}/designs/not-a-uuid`, headers: as(owner) })).statusCode).toBe(404)
    expect((await db.select().from(studioPieces))).toHaveLength(1)
    expect((await db.select().from(studioRevisions))).toHaveLength(1)
  })
})
