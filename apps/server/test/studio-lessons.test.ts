import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '../src/db/connection.js'
import { studioJobs, studioLessons, studioMessages, studioRatings } from '../src/db/schema.js'
import { config } from '../src/config.js'
import { memoryStudioStore, setStudioStore } from '../src/studio/store.js'
import { setMachineDeps } from '../src/studio/machines.js'
import { setLessonDrafter, setLessonFetch, type DraftSource } from '../src/studio/lesson-drafts.js'
import { liveLessons } from '../src/studio/lessons.js'
import { resetDb } from './helpers/db.js'
import { testApp, createUser, tokenFor, type TestUser } from './helpers/factories.js'
import { addRevision, createDesign, fakeFly } from './helpers/studio.js'

const A = '/api/admin/studio'

describe('lessons for the agent', () => {
  let app: Awaited<ReturnType<typeof testApp>>
  let admin: TestUser
  let owner: TestUser
  const prev = { enabled: config.studioEnabled, image: config.studioWorkerImage, key: config.anthropicApiKey }
  beforeAll(() => {
    ;(config as any).studioEnabled = true
    ;(config as any).studioWorkerImage = 'registry.fly.io/vlm-studio-worker:test'
    ;(config as any).anthropicApiKey = null
  })
  afterAll(() => {
    ;(config as any).studioEnabled = prev.enabled
    ;(config as any).studioWorkerImage = prev.image
    ;(config as any).anthropicApiKey = prev.key
    setStudioStore(null)
    setMachineDeps(null)
    setLessonDrafter(null)
  })
  beforeEach(async () => {
    await resetDb()
    setStudioStore(memoryStudioStore())
    setMachineDeps({ fly: fakeFly() })
    setLessonDrafter(null)
    app = await testApp()
    admin = await createUser({ role: 'admin' })
    owner = await createUser()
  })
  const as = (u: TestUser) => ({ authorization: `Bearer ${tokenFor(u)}` })
  const post = (url: string, body: unknown, u = admin) => app.inject({ method: 'POST', url, headers: as(u), payload: body as any })
  const patch = (id: string, body: unknown) => app.inject({ method: 'PATCH', url: `${A}/lessons/${id}`, headers: as(admin), payload: body as any })
  const list = async (q = '') => (await app.inject({ method: 'GET', url: `${A}/lessons${q}`, headers: as(admin) })).json()

  async function down(kind = 'wearable', over: Partial<typeof studioRatings.$inferInsert> = {}) {
    const d = await createDesign(owner, { kind })
    const rev = await addRevision(d, kind === 'emote' ? 'emote' : 'hat')
    await db.insert(studioMessages).values({ designId: d.id, role: 'agent', text: 'I scaled the cap up.', jobId: rev.jobId })
    const [r] = await db.insert(studioRatings).values({
      jobId: rev.jobId, designId: d.id, userId: owner.id, rating: 'down', kind, tags: ['size'], note: 'Far too big.', prompt: 'a small cap', agent: 'codex', ...over,
    }).returning()
    return r
  }

  async function prompt(kind = 'wearable') {
    const d = await createDesign(owner, { kind })
    const res = await post(`/api/studio/designs/${d.id}/prompts`, { text: 'a cap' }, owner)
    expect(res.statusCode).toBe(202)
    const [job] = await db.select().from(studioJobs).where(eq(studioJobs.id, res.json().jobId))
    return { job, d }
  }

  it('nothing goes live until approved; approved and on, it goes with every new prompt of its kind', async () => {
    const made = await post(`${A}/lessons`, { kind: 'wearable', text: '  Keep hats  within the head’s bounds. ' })
    expect(made.statusCode).toBe(201)
    const l = made.json()
    expect(l).toMatchObject({ kind: 'wearable', text: 'Keep hats within the head’s bounds.', status: 'draft', live: false, drafted: 'admin' })
    expect((await prompt()).job.payload).not.toHaveProperty('lessons')

    const approved = await patch(l.id, { status: 'approved' })
    expect(approved.json()).toMatchObject({ status: 'approved', live: true, approvedBy: admin.id })
    const { job, d } = await prompt()
    expect((job.payload as any).lessons).toEqual(['Keep hats within the head’s bounds.'])
    // instructions only: the conversation holds the owner's words
    const msgs = await db.select().from(studioMessages).where(eq(studioMessages.designId, d.id))
    expect(msgs.map((m) => m.text)).toEqual(['a cap'])
    // other kinds don't get it
    expect((await prompt('emote')).job.payload).not.toHaveProperty('lessons')

    // switched off, and edited
    await patch(l.id, { enabled: false })
    expect(await liveLessons('wearable')).toEqual([])
    await patch(l.id, { enabled: true, text: 'Size hats to the head.' })
    expect(await liveLessons('wearable')).toEqual(['Size hats to the head.'])
    expect((await patch(l.id, { status: 'draft' })).statusCode).toBe(400)

    const listed = await list('?kind=wearable')
    expect(listed).toMatchObject({ drafting: false, limit: 4000, used: { wearable: 22, emote: 0, scene: 0 } })
    expect(listed.lessons).toHaveLength(1)

    expect((await app.inject({ method: 'DELETE', url: `${A}/lessons/${l.id}`, headers: as(admin) })).statusCode).toBe(204)
    expect(await db.select().from(studioLessons)).toHaveLength(0)
  })

  it("keeps a kind's live lessons within 4,000 characters", async () => {
    const ids: string[] = []
    for (let i = 0; i < 9; i++) ids.push((await post(`${A}/lessons`, { kind: 'emote', text: `${i}`.repeat(450) })).json().id)
    for (const id of ids.slice(0, 8)) expect((await patch(id, { status: 'approved' })).statusCode).toBe(200) // 3,600
    expect((await patch(ids[8], { status: 'approved' })).json()).toMatchObject({ code: 'lessons_too_long' })
    // switching one off makes room
    await patch(ids[0], { enabled: false })
    expect((await patch(ids[8], { status: 'approved' })).statusCode).toBe(200)
    expect((await patch(ids[0], { enabled: true })).statusCode).toBe(409)
    expect((await post(`${A}/lessons`, { kind: 'emote', text: 'x'.repeat(501) })).statusCode).toBe(400)
  })

  it('Claude drafts a lesson from a batch of 👎s of one kind, saved as a draft with its sources', async () => {
    const a = await down()
    const b = await down('wearable', { tags: ['broken'], note: null })
    expect((await post(`${A}/lessons/draft`, { ratingIds: [a.id] })).statusCode).toBe(503) // no key on this server
    let seen: { kind: string; sources: DraftSource[] } | null = null
    setLessonDrafter(async (kind, sources) => { seen = { kind, sources }; return '"Check the hat’s size against the head before you finish."' })
    expect((await list()).drafting).toBe(true)

    const res = await post(`${A}/lessons/draft`, { ratingIds: [a.id, b.id] })
    expect(res.statusCode).toBe(201)
    expect(res.json()).toMatchObject({
      kind: 'wearable', text: 'Check the hat’s size against the head before you finish.', status: 'draft', live: false, drafted: 'claude',
      sourceRatingIds: [a.id, b.id],
    })
    expect(seen!.kind).toBe('wearable')
    expect(seen!.sources).toContainEqual({ prompt: 'a small cap', tags: ['size'], note: 'Far too big.', reply: 'I scaled the cap up.', agent: 'codex' })
    expect(await liveLessons('wearable')).toEqual([])
  })

  it('asks Claude Sonnet 5.5 for one short lesson, with server-side fallbacks, and treats a refusal as a failed draft', async () => {
    const r = await down()
    ;(config as any).anthropicApiKey = 'sk-ant-test'
    const calls: { url: string; headers: Headers; body: any }[] = []
    let answer: Record<string, unknown> = {
      id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-sonnet-5-5', stop_reason: 'end_turn', stop_sequence: null,
      content: [{ type: 'text', text: 'Size hats to the head before you finish.' }], usage: { input_tokens: 10, output_tokens: 10 },
    }
    setLessonFetch((async (url: string, init: RequestInit) => {
      calls.push({ url: String(url), headers: new Headers(init.headers), body: JSON.parse(String(init.body)) })
      return new Response(JSON.stringify(answer), { status: 200, headers: { 'content-type': 'application/json' } })
    }) as unknown as typeof fetch)
    try {
      const res = await post(`${A}/lessons/draft`, { ratingIds: [r.id] })
      expect(res.statusCode).toBe(201)
      expect(res.json().text).toBe('Size hats to the head before you finish.')
      expect(calls).toHaveLength(1)
      expect(calls[0].url).toMatch(/\/v1\/messages/)
      expect(calls[0].headers.get('authorization')).toBe('Bearer sk-ant-test') // the server's key, as the SDK sends it
      expect(calls[0].headers.get('anthropic-beta')).toContain('server-side-fallback-2026-07-01')
      expect(calls[0].body).toMatchObject({ model: 'claude-sonnet-5-5', max_tokens: 2000, fallbacks: 'default', output_config: { effort: 'low' } })
      expect(calls[0].body.messages[0].content).toContain('Far too big.')
      answer = { ...answer, stop_reason: 'refusal', content: [] }
      expect((await post(`${A}/lessons/draft`, { ratingIds: [r.id] })).json()).toMatchObject({ code: 'draft_failed' })
    } finally {
      ;(config as any).anthropicApiKey = null
      setLessonFetch(null)
    }
  })

  it('refuses a batch that mixes kinds, holds a 👍, or fails to draft', async () => {
    setLessonDrafter(async () => 'x')
    const w = await down()
    const e = await down('emote')
    expect((await post(`${A}/lessons/draft`, { ratingIds: [w.id, e.id] })).json()).toMatchObject({ code: 'mixed_kinds' })
    await db.update(studioRatings).set({ rating: 'up' }).where(eq(studioRatings.id, e.id))
    expect((await post(`${A}/lessons/draft`, { ratingIds: [e.id] })).json()).toMatchObject({ code: 'unknown_ratings' })
    expect((await post(`${A}/lessons/draft`, { ratingIds: [] })).statusCode).toBe(400)
    setLessonDrafter(async () => { throw new Error('overloaded') })
    expect((await post(`${A}/lessons/draft`, { ratingIds: [w.id] })).json()).toMatchObject({ code: 'draft_failed' })
    // a hand-written lesson's sources must be 👎s of its kind
    expect((await post(`${A}/lessons`, { kind: 'emote', text: 'x', sourceRatingIds: [w.id] })).json()).toMatchObject({ code: 'unknown_ratings' })
    expect(await db.select().from(studioLessons)).toHaveLength(0)
  })

  it('is for admins only', async () => {
    expect((await app.inject({ method: 'GET', url: `${A}/lessons`, headers: as(owner) })).statusCode).toBe(403)
    expect((await post(`${A}/lessons`, { kind: 'emote', text: 'x' }, owner)).statusCode).toBe(403)
  })
})
