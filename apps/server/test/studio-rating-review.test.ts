import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '../src/db/connection.js'
import { studioDigestWeeks, studioMessages, studioRatings, studioRenders } from '../src/db/schema.js'
import { config } from '../src/config.js'
import { lastFullWeek, parseWeek, sendWeeklyDigest, setDigestMailer, weekDigest, weekStartOf } from '../src/studio/rating-review.js'
import { resetDb } from './helpers/db.js'
import { testApp, createUser, tokenFor, type TestUser } from './helpers/factories.js'
import { addRevision, createDesign } from './helpers/studio.js'

const A = '/api/admin/studio'
// Wednesday of the week starting Monday 2026-11-02
const WED = new Date('2026-11-04T12:00:00Z')

describe('weeks', () => {
  it('a week is its Monday, UTC', () => {
    expect(weekStartOf(new Date('2026-11-02T00:00:00Z'))).toBe('2026-11-02')
    expect(weekStartOf(new Date('2026-11-08T23:59:59Z'))).toBe('2026-11-02')
    expect(weekStartOf(new Date('2026-11-09T00:00:00Z'))).toBe('2026-11-09')
    expect(lastFullWeek(new Date('2026-11-09T00:01:00Z'))).toBe('2026-11-02')
    expect(lastFullWeek(WED)).toBe('2026-10-26')
    expect(parseWeek('2026-11-02')).toBe('2026-11-02')
    expect(parseWeek('2026-11-03')).toBeNull() // a Tuesday
    expect(parseWeek('2026-02-30')).toBeNull()
    expect(parseWeek('soon')).toBeNull()
  })
})

describe('reviewing ratings', () => {
  let app: Awaited<ReturnType<typeof testApp>>
  let admin: TestUser
  let owner: TestUser
  const prev = config.studioEnabled
  beforeAll(() => { (config as any).studioEnabled = true })
  afterAll(() => { (config as any).studioEnabled = prev; setDigestMailer(null) })
  beforeEach(async () => {
    await resetDb()
    app = await testApp()
    admin = await createUser({ role: 'admin', email: 'ada@virvi.io' })
    owner = await createUser({ name: 'Olive Owner', email: 'olive@example.com' })
  })
  const as = (u: TestUser) => ({ authorization: `Bearer ${tokenFor(u)}` })

  /** A rated revision of a fresh design. */
  async function rated(rating: 'up' | 'down', over: Partial<typeof studioRatings.$inferInsert> = {}, design?: { id: string }) {
    const d = design ?? await createDesign(owner, { kind: (over.kind as string) ?? 'wearable' })
    const rev = await addRevision(d, 'hat')
    const [r] = await db.insert(studioRatings).values({
      jobId: rev.jobId, designId: d.id, userId: owner.id, rating, kind: 'wearable', agent: 'claude', model: 'claude-opus-5-5',
      prompt: 'a neon cap', costUsd: 0.5, createdAt: WED, ...over,
    }).returning()
    return { r, rev, d }
  }

  describe('the 👎 queue', () => {
    const queue = (q = '', u = admin) => app.inject({ method: 'GET', url: `${A}/ratings${q}`, headers: as(u) })

    it('lists 👎s newest first with the note, renders, prompt, reply, agent, model and cost', async () => {
      const older = await rated('down', { tags: ['broken'], note: 'clips the hair', createdAt: new Date('2026-11-01T00:00:00Z') })
      const newer = await rated('down', { tags: ['size'], agent: 'codex', model: 'gpt-x' })
      await rated('up')
      await db.insert(studioRenders).values({ revisionId: older.rev.id, viewKey: 'spin-male-default', jobId: older.rev.jobId, frames: 36, status: 'ready' })
      await db.insert(studioMessages).values({ designId: older.d.id, role: 'agent', text: 'I made the cap.', jobId: older.rev.jobId })
      const res = await queue()
      expect(res.statusCode).toBe(200)
      const { ratings, nextCursor } = res.json()
      expect(nextCursor).toBeNull()
      expect(ratings.map((r: any) => r.id)).toEqual([newer.r.id, older.r.id])
      expect(ratings[1]).toMatchObject({
        tags: ['broken'], note: 'clips the hair', prompt: 'a neon cap', reply: 'I made the cap.', agent: 'claude', model: 'claude-opus-5-5',
        costUsd: 0.5, handledAt: null, autoCheck: false, kind: 'wearable',
        design: { id: older.d.id, name: 'Neon cap' }, owner: { id: owner.id, email: 'olive@example.com', name: 'Olive Owner' },
        pieces: [{ category: 'hat', number: 1, views: [{ viewKey: 'spin-male-default', url: expect.stringContaining('/api/studio/render-frames/') }] }],
      })
    })

    it('filters by kind, agent, model, tag and handled, and pages', async () => {
      const a = await rated('down', { tags: ['broken', 'size'] })
      const b = await rated('down', { kind: 'emote', agent: 'codex', model: 'gpt-x', tags: ['quality'] })
      await db.update(studioRatings).set({ handledAt: new Date() }).where(eq(studioRatings.id, b.r.id))
      const ids = async (q: string) => (await queue(q)).json().ratings.map((r: any) => r.id)
      expect(await ids('?kind=emote')).toEqual([b.r.id])
      expect(await ids('?agent=claude')).toEqual([a.r.id])
      expect(await ids('?model=gpt-x')).toEqual([b.r.id])
      expect(await ids('?tag=size')).toEqual([a.r.id])
      expect(await ids('?handled=false')).toEqual([a.r.id])
      expect(await ids('?handled=true')).toEqual([b.r.id])
      for (const q of ['?kind=hat', '?tag=ugly', '?handled=maybe', '?cursor=nope']) expect((await queue(q)).statusCode).toBe(400)
      for (let i = 0; i < 50; i++) await rated('down', { createdAt: new Date(WED.getTime() - (i + 1) * 1000) })
      const first = (await queue()).json()
      expect(first.ratings).toHaveLength(50)
      const second = (await queue(`?cursor=${first.nextCursor}`)).json()
      expect(second.ratings).toHaveLength(2)
      expect(new Set([...first.ratings, ...second.ratings].map((r: any) => r.id)).size).toBe(52)
    })

    it('marks a 👎 handled and "could be checked automatically"; a 👍 is not in the queue', async () => {
      const { r } = await rated('down')
      const { r: up } = await rated('up')
      const mark = (id: string, body: unknown) => app.inject({ method: 'PATCH', url: `${A}/ratings/${id}`, headers: as(admin), payload: body as any })
      expect((await mark(r.id, { handled: true, autoCheck: true })).json()).toMatchObject({ autoCheck: true, handledAt: expect.any(String) })
      const [row] = await db.select().from(studioRatings).where(eq(studioRatings.id, r.id))
      expect(row.handledBy).toBe(admin.id)
      expect((await mark(r.id, { handled: false })).json().handledAt).toBeNull()
      expect((await mark(up.id, { handled: true })).statusCode).toBe(404)
      expect((await mark(r.id, { handled: 'yes' })).statusCode).toBe(400)
      expect((await mark(r.id, {})).statusCode).toBe(400)
    })

    it('is for admins only', async () => {
      await rated('down')
      expect((await queue('', owner)).statusCode).toBe(403)
      expect((await app.inject({ method: 'GET', url: `${A}/digest`, headers: as(owner) })).statusCode).toBe(403)
    })
  })

  describe('the weekly digest', () => {
    it('counts by kind, agent and model, with top tags, worst designs, notes and auto-check groups', async () => {
      const worst = await createDesign(owner, { name: 'Bad cap' })
      await rated('down', { tags: ['broken'], note: 'Clips.', autoCheck: true }, worst)
      await rated('down', { tags: ['broken', 'size'], autoCheck: true }, worst)
      await rated('down', { kind: 'emote', agent: 'codex', model: 'gpt-x', tags: ['quality'] })
      await rated('up')
      await rated('down', { createdAt: new Date('2026-11-10T00:00:00Z') }) // next week
      const res = await app.inject({ method: 'GET', url: `${A}/digest?week=2026-11-02`, headers: as(admin) })
      expect(res.statusCode).toBe(200)
      const d = res.json()
      expect(d.totals).toEqual({ up: 1, down: 3 })
      expect(d.counts).toEqual([
        { kind: 'emote', agent: 'codex', model: 'gpt-x', up: 0, down: 1 },
        { kind: 'wearable', agent: 'claude', model: 'claude-opus-5-5', up: 1, down: 2 },
      ])
      expect(d.topTags).toEqual([
        { tag: 'broken', label: 'Looks broken or clipping', count: 2 },
        { tag: 'size', label: 'Wrong size or position', count: 1 },
        { tag: 'quality', label: 'Low quality', count: 1 },
      ])
      expect(d.worstDesigns[0]).toMatchObject({ id: worst.id, name: 'Bad cap', down: 2, up: 0 })
      expect(d.notes).toEqual([expect.objectContaining({ note: 'Clips.', designId: worst.id })])
      expect(d.autoCheckGroups.map((g: any) => [g.tag, g.kind, g.count])).toEqual([['broken', 'wearable', 2], ['size', 'wearable', 1]])
      expect((await app.inject({ method: 'GET', url: `${A}/digest?week=2026-11-03`, headers: as(admin) })).statusCode).toBe(400)
    })

    it('names a leader per kind only past the minimum sample', async () => {
      for (let i = 0; i < 19; i++) await rated('up')
      let rates = (await weekDigest('2026-11-02')).rates.find((k) => k.kind === 'wearable')!
      expect(rates.leader).toBeNull()
      expect(rates.rows[0]).toMatchObject({ agent: 'claude', total: 19, enough: false })
      await rated('down')
      for (let i = 0; i < 20; i++) await rated(i < 5 ? 'up' : 'down', { agent: 'codex', model: 'gpt-x' })
      rates = (await weekDigest('2026-11-02')).rates.find((k) => k.kind === 'wearable')!
      expect(rates.leader).toEqual({ agent: 'claude', model: 'claude-opus-5-5', rate: 19 / 20 })
      expect(rates.rows.every((r) => r.enough)).toBe(true)
    })

    it('mails every admin once a week, never twice, and not for a week with no ratings', async () => {
      const second = await createUser({ role: 'admin', email: 'bo@virvi.io' })
      await createUser({ role: 'admin', email: null })
      const sent: { to: string; subject: string; html: string }[] = []
      setDigestMailer(async (to, subject, html) => { sent.push({ to, subject, html }); return true })
      const monday = new Date('2026-11-09T00:01:00Z')
      // the week before had nothing: recorded, no email
      expect(await sendWeeklyDigest(new Date('2026-11-02T00:01:00Z'))).toBe('empty')
      expect(sent).toHaveLength(0)
      await rated('down', { tags: ['broken'], note: '<b>clips</b>' })
      await rated('up')
      const results = await Promise.all([sendWeeklyDigest(monday), sendWeeklyDigest(monday), sendWeeklyDigest(monday)])
      expect(results.filter((r) => r === 'sent')).toHaveLength(1)
      expect(sent.map((m) => m.to).sort()).toEqual(['ada@virvi.io', second.email].sort())
      expect(sent[0].subject).toBe('Design Studio ratings, week of 2026-11-02: 1 👍, 1 👎')
      expect(sent[0].html).toContain('&lt;b&gt;clips&lt;/b&gt;')
      expect(sent[0].html).toContain('not enough ratings yet')
      expect(await sendWeeklyDigest(new Date('2026-11-12T00:00:00Z'))).toBe('already')
      expect(sent).toHaveLength(2)
      const [row] = await db.select().from(studioDigestWeeks).where(eq(studioDigestWeeks.weekStart, '2026-11-02'))
      expect(row).toMatchObject({ ratings: 2, sentAt: expect.any(Date) })
    })
  })
})
