import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach } from 'vitest'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { eq } from 'drizzle-orm'
import type { ShowItemKind, ShowView } from '@virvixr/shared'
import { db } from '../src/db/connection.js'
import { assistantConversations, assistantShows, beats, beatScenes, eventSceneLinks, events, mediaAssets, raffles, scenes, screenShowings, studioDesigns, studioJobs } from '../src/db/schema.js'
import { config } from '../src/config.js'
import { runTool } from '../src/assistant/tools/run.js'
import { recordDirect, undoAction } from '../src/assistant/actions.js'
import type { ToolCtx } from '../src/assistant/tools/types.js'
import { CURATION_DAYS, SHOW_TIMELINE, SHOW_TOO_SOON } from '../src/assistant/shows.js'
import { resetDb } from './helpers/db.js'
import { testApp, createUser, createScene, createElement, tokenFor, type TestUser } from './helpers/factories.js'
import { addRevision, createDesign, entitle } from './helpers/studio.js'
import { BEATS_READY } from './helpers/beats-ready.js'

const DAY = 86_400_000
const NOT_YOURS = "That isn't yours, or it's gone."
const WEARABLE_EXAMPLE = "Paste the wearable's Marketplace link, like https://decentraland.org/marketplace/contracts/0x…/items/0."
const CONTRACT = '0x' + 'ab'.repeat(20)
const ALL_KINDS: ShowItemKind[] = ['event', 'scene_link', 'showing', 'raffle', 'raffle_scheduled', 'beat', 'beat_paid', 'wearable_design', 'wearable_published']

describe('assistant shows', () => {
  let app: FastifyInstance
  let owner: TestUser
  let other: TestUser
  let sceneId: string
  let elementId: string
  let mediaId: string
  const prev = { enabled: config.assistantEnabled, audience: config.assistantAudience, billing: config.billingEnabled, studio: config.studioEnabled, beats: config.beats }
  const set = (k: string, v: unknown) => { ;(config as any)[k] = v }
  const auth = (u: TestUser) => ({ authorization: `Bearer ${tokenFor(u)}` })

  beforeAll(async () => {
    app = await testApp()
  })
  afterAll(async () => {
    await app.close()
  })
  beforeEach(async () => {
    await resetDb()
    set('assistantEnabled', true); set('assistantAudience', 'paid'); set('billingEnabled', false)
    set('studioEnabled', true)
    set('beats', { ...prev.beats, enabled: true, chain: 'polygon', ...BEATS_READY })
    owner = await createUser()
    other = await createUser()
    const { scene, preset } = await createScene(owner, 'Lounge')
    sceneId = scene.id
    elementId = (await createElement(preset.id)).id
    const [media] = await db.insert(mediaAssets).values({ ownerId: owner.id, filename: 'a.png', contentType: 'image/png', sizeBytes: 1, storageKey: 'media/a/a.png', publicUrl: 'https://cdn.example/a.png' }).returning()
    mediaId = media.id
  })
  afterEach(() => {
    set('assistantEnabled', prev.enabled); set('assistantAudience', prev.audience); set('billingEnabled', prev.billing)
    set('studioEnabled', prev.studio); set('beats', prev.beats)
  })

  const call = async (u: TestUser, method: 'GET' | 'POST' | 'PATCH', url: string, payload?: unknown) => {
    const res = await app.inject({ method, url, headers: auth(u), ...(payload === undefined ? {} : { payload: payload as any }) })
    return { status: res.statusCode, json: res.body ? res.json() : null }
  }
  const create = async (body: Record<string, unknown>, u = owner): Promise<ShowView> => {
    const r = await call(u, 'POST', '/api/assistant/shows', body)
    expect(r.status, JSON.stringify(r.json)).toBe(201)
    return r.json
  }
  const show = async (id: string, u = owner): Promise<ShowView> => {
    const r = await call(u, 'GET', `/api/assistant/shows/${id}`)
    expect(r.status, JSON.stringify(r.json)).toBe(200)
    return r.json
  }
  const attach = (s: ShowView, kind: ShowItemKind, body: Record<string, unknown>, u = owner) =>
    call(u, 'PATCH', `/api/assistant/shows/${s.id}/items/${s.items.find((i) => i.kind === kind)!.id}`, body)
  const item = (s: ShowView, kind: ShowItemKind) => {
    const i = s.items.find((x) => x.kind === kind)!
    return { state: i.state, note: i.note }
  }
  const everything = () => create({ title: 'Friday night', items: ALL_KINDS.map((kind) => ({ kind, label: `Do ${kind}` })) })

  const newEvent = async (u = owner, startInDays = 30) =>
    (await db.insert(events).values({ ownerId: u.id, name: 'Friday', startTime: new Date(Date.now() + startInDays * DAY), endTime: new Date(Date.now() + startInDays * DAY + 3600_000) }).returning())[0]
  const newRaffle = async (inScene = sceneId, over: Partial<typeof raffles.$inferInsert> = {}) =>
    (await db.insert(raffles).values({ sceneId: inScene, createdBy: owner.id, name: 'Cap raffle', prize: 'A cap', winnersCount: 1, mode: 'one_per_person', hostTermsAcceptedAt: new Date(), ...over }).returning())[0]
  const newBeat = async (over: Partial<typeof beats.$inferInsert> = {}) => {
    const [beat] = await db.insert(beats).values({ chain: 'polygon', ownerUserId: owner.id, name: 'Friday BEAT', description: '', imageMediaId: mediaId, startsAt: new Date(Date.now() + 2 * DAY), endsAt: new Date(Date.now() + 2 * DAY + 3600_000), ...over }).returning()
    await db.insert(beatScenes).values({ beatId: beat.id, sceneId })
    return beat
  }
  const newShowing = async () =>
    (await db.insert(screenShowings).values({ sceneId, elementId, title: 'Opening film', items: [{ url: 'https://cdn.example/a.mp4', duration: 60, kind: 'video' }], recurrence: 'once', startDate: '2031-01-01', startTime: '20:00', timezone: 'UTC' }).returning())[0]

  describe('item states', () => {
    it('a new show: everything to do, the published wearable waiting for its link', async () => {
      const s = await everything()
      expect(s).toMatchObject({ title: 'Friday night', eventId: null, closedAt: null })
      expect(s.items.map((i) => i.kind)).toEqual(ALL_KINDS)
      expect(new Set(s.items.map((i) => i.id)).size).toBe(ALL_KINDS.length)
      for (const kind of ALL_KINDS.filter((k) => k !== 'wearable_published')) expect(item(s, kind), kind).toEqual({ state: 'todo', note: null })
      expect(item(s, 'wearable_published')).toEqual({ state: 'waiting', note: 'Publish it on Decentraland, then paste its Marketplace link.' })
    })

    it('event: done once attached, which also sets the show\'s event; skipped once deleted', async () => {
      const s = await everything()
      const ev = await newEvent()
      expect((await attach(s, 'event', { ref: { eventId: ev.id } })).status).toBe(200)
      const now = await show(s.id)
      expect(now.eventId).toBe(ev.id)
      expect(item(now, 'event')).toEqual({ state: 'done', note: null })
      await db.delete(events).where(eq(events.id, ev.id))
      expect(item(await show(s.id), 'event')).toEqual({ state: 'skipped', note: 'This was deleted.' })
    })

    it('scene_link: to do until the scene is linked to the show\'s event, then done; skipped when the scene is no longer the user\'s', async () => {
      const s = await everything()
      const ev = await newEvent()
      await attach(s, 'event', { ref: { eventId: ev.id } })
      expect((await attach(s, 'scene_link', { ref: { sceneId } })).status).toBe(200)
      expect(item(await show(s.id), 'scene_link')).toEqual({ state: 'todo', note: null })
      await db.insert(eventSceneLinks).values({ eventId: ev.id, sceneId })
      expect(item(await show(s.id), 'scene_link')).toEqual({ state: 'done', note: null })
      await db.update(scenes).set({ ownerId: other.id }).where(eq(scenes.id, sceneId))
      expect(item(await show(s.id), 'scene_link')).toEqual({ state: 'skipped', note: 'This was deleted.' })
    })

    it('showing: done once attached; skipped once deleted', async () => {
      const s = await everything()
      const sh = await newShowing()
      expect((await attach(s, 'showing', { ref: { showingId: sh.id } })).status).toBe(200)
      expect(item(await show(s.id), 'showing')).toEqual({ state: 'done', note: null })
      await db.delete(screenShowings).where(eq(screenShowings.id, sh.id))
      expect(item(await show(s.id), 'showing')).toEqual({ state: 'skipped', note: 'This was deleted.' })
    })

    it('raffle and raffle_scheduled: done, waiting (with the failed opening), done when scheduled or opened; both skipped once deleted', async () => {
      const s = await everything()
      const r = await newRaffle()
      expect((await attach(s, 'raffle', { ref: { raffleId: r.id } })).status).toBe(200)
      let now = await show(s.id)
      expect(item(now, 'raffle')).toEqual({ state: 'done', note: null })
      // raffle_scheduled reads the show's raffle when it has none of its own
      expect(item(now, 'raffle_scheduled')).toEqual({ state: 'waiting', note: null })
      await db.update(raffles).set({ openError: 'Another raffle is already open in this scene.' }).where(eq(raffles.id, r.id))
      expect(item(await show(s.id), 'raffle_scheduled')).toEqual({ state: 'waiting', note: 'Another raffle is already open in this scene.' })
      await db.update(raffles).set({ openError: null, opensAt: new Date(Date.now() + DAY) }).where(eq(raffles.id, r.id))
      expect(item(await show(s.id), 'raffle_scheduled')).toEqual({ state: 'done', note: null })
      for (const status of ['open', 'drawn', 'closed'] as const) {
        await db.update(raffles).set({ opensAt: null, status }).where(eq(raffles.id, r.id))
        expect(item(await show(s.id), 'raffle_scheduled'), status).toEqual({ state: 'done', note: null })
      }
      await db.delete(raffles).where(eq(raffles.id, r.id))
      now = await show(s.id)
      expect(item(now, 'raffle')).toEqual({ state: 'skipped', note: 'This was deleted.' })
      expect(item(now, 'raffle_scheduled')).toEqual({ state: 'skipped', note: 'This was deleted.' })
    })

    it('raffle_scheduled attached on its own reads its own raffle', async () => {
      const s = await everything()
      const r = await newRaffle(sceneId, { opensAt: new Date(Date.now() + DAY) })
      expect((await attach(s, 'raffle_scheduled', { ref: { raffleId: r.id } })).status).toBe(200)
      const now = await show(s.id)
      expect(item(now, 'raffle')).toEqual({ state: 'todo', note: null })
      expect(item(now, 'raffle_scheduled')).toEqual({ state: 'done', note: null })
    })

    it('a raffle in a scene the user no longer runs is skipped', async () => {
      const s = await everything()
      const r = await newRaffle()
      await attach(s, 'raffle', { ref: { raffleId: r.id } })
      await db.update(scenes).set({ ownerId: other.id }).where(eq(scenes.id, sceneId))
      expect(item(await show(s.id), 'raffle')).toEqual({ state: 'skipped', note: 'This was deleted.' })
    })

    it('beat and beat_paid: done once attached, waiting for payment until it isn\'t a draft; skipped once deleted', async () => {
      const s = await everything()
      const b = await newBeat()
      expect((await attach(s, 'beat', { ref: { beatId: b.id } })).status).toBe(200)
      let now = await show(s.id)
      expect(item(now, 'beat')).toEqual({ state: 'done', note: null })
      expect(item(now, 'beat_paid')).toEqual({ state: 'waiting', note: 'Waiting for payment.' })
      await db.update(beats).set({ status: 'paid' }).where(eq(beats.id, b.id))
      expect(item(await show(s.id), 'beat_paid')).toEqual({ state: 'done', note: null })
      await db.delete(beats).where(eq(beats.id, b.id))
      now = await show(s.id)
      expect(item(now, 'beat')).toEqual({ state: 'skipped', note: 'This was deleted.' })
      expect(item(now, 'beat_paid')).toEqual({ state: 'skipped', note: 'This was deleted.' })
    })

    it('wearable_design: to do, waiting while a job runs, done once a piece is finalized; skipped once deleted', async () => {
      const s = await everything()
      const d = await createDesign(owner)
      expect((await attach(s, 'wearable_design', { ref: { designId: d.id } })).status).toBe(200)
      expect(item(await show(s.id), 'wearable_design')).toEqual({ state: 'todo', note: null })
      const [job] = await db.insert(studioJobs).values({ designId: d.id, type: 'prompt', status: 'queued', payload: {} }).returning()
      expect(item(await show(s.id), 'wearable_design')).toEqual({ state: 'waiting', note: null })
      await db.update(studioJobs).set({ status: 'done' }).where(eq(studioJobs.id, job.id))
      const rev = await addRevision(d, 'hat')
      expect(item(await show(s.id), 'wearable_design')).toEqual({ state: 'todo', note: null })
      await entitle(d, rev)
      expect(item(await show(s.id), 'wearable_design')).toEqual({ state: 'done', note: null })
      await db.delete(studioDesigns).where(eq(studioDesigns.id, d.id))
      expect(item(await show(s.id), 'wearable_design')).toEqual({ state: 'skipped', note: 'This was deleted.' })
    })

    it('wearable_published: done once its Marketplace link is pasted', async () => {
      const s = await everything()
      const url = `https://decentraland.org/marketplace/contracts/${CONTRACT}/items/3`
      expect((await attach(s, 'wearable_published', { wearable: url })).status).toBe(200)
      expect(item(await show(s.id), 'wearable_published')).toEqual({ state: 'done', note: null })
    })
  })

  describe('timeline and warning', () => {
    const wearableShow = (startInDays: number | null, kinds: ShowItemKind[] = ['raffle', 'wearable_design', 'wearable_published']) =>
      create({ title: 'Wearable raffle', ...(startInDays === null ? {} : { startTime: new Date(Date.now() + startInDays * DAY).toISOString() }), items: kinds.map((kind) => ({ kind, label: kind })) })

    it('is 7 days', () => {
      expect(CURATION_DAYS).toBe(7)
    })

    it('a wearable to design: the timeline, and the warning when the start is 6 days away but not 8', async () => {
      const soon = await wearableShow(6)
      expect(soon.timeline).toBe(SHOW_TIMELINE)
      expect(soon.timeline).toBe("Making the wearable takes a few days in Studio, then Decentraland curation, so I can't name it as the prize until it's published. I'll keep it on the checklist.")
      expect(soon.warning).toBe(SHOW_TOO_SOON)
      expect(soon.warning).toBe("This event starts in fewer than 7 days. A new wearable may not be through Decentraland curation by then. A wearable you've already published would be safer.")
      const later = await wearableShow(8)
      expect(later).toMatchObject({ timeline: SHOW_TIMELINE, warning: null })
      expect(await wearableShow(null)).toMatchObject({ timeline: SHOW_TIMELINE, warning: null })
    })

    it('no wearable to design: neither', async () => {
      expect(await wearableShow(2, ['raffle', 'beat'])).toMatchObject({ timeline: null, warning: null })
    })

    it('once the event is attached, its start counts instead of the one given', async () => {
      const s = await wearableShow(8, ['event', 'wearable_design'])
      expect(s.warning).toBeNull()
      const ev = await newEvent(owner, 6)
      await attach(s, 'event', { ref: { eventId: ev.id } })
      expect((await show(s.id)).warning).toBe(SHOW_TOO_SOON)
      await db.update(events).set({ startTime: new Date(Date.now() + 8 * DAY) }).where(eq(events.id, ev.id))
      expect((await show(s.id)).warning).toBeNull()
    })

    it('no warning once the wearable is designed', async () => {
      const s = await wearableShow(6)
      const d = await createDesign(owner)
      await attach(s, 'wearable_design', { ref: { designId: d.id } })
      await entitle(d, await addRevision(d, 'hat'))
      expect(await show(s.id)).toMatchObject({ timeline: SHOW_TIMELINE, warning: null })
    })
  })

  describe('attaching', () => {
    it("another user's raffle is refused with 404, and the show is unchanged", async () => {
      const s = await everything()
      const theirs = (await createScene(other, 'Their lounge')).scene
      const r = await newRaffle(theirs.id)
      const before = await db.select().from(assistantShows)
      const res = await attach(s, 'raffle', { ref: { raffleId: r.id } })
      expect(res).toEqual({ status: 404, json: { error: 'not_found', message: NOT_YOURS } })
      expect(await db.select().from(assistantShows)).toEqual(before)
    })

    it("another user's event, scene, showing, BEAT or design is refused the same way", async () => {
      const s = await everything()
      const { scene: theirScene, preset } = await createScene(other, 'Their lounge')
      const theirEvent = await newEvent(other)
      const [theirShowing] = await db.insert(screenShowings).values({ sceneId: theirScene.id, elementId: (await createElement(preset.id)).id, title: 'Theirs', items: [{ url: 'https://cdn.example/b.mp4', duration: 60, kind: 'video' }], recurrence: 'once', startDate: '2031-01-01', startTime: '20:00', timezone: 'UTC' }).returning()
      const [theirMedia] = await db.insert(mediaAssets).values({ ownerId: other.id, filename: 'b.png', contentType: 'image/png', sizeBytes: 1, storageKey: 'media/b/b.png', publicUrl: 'https://cdn.example/b.png' }).returning()
      const [theirBeat] = await db.insert(beats).values({ chain: 'polygon', ownerUserId: other.id, name: 'Theirs', description: '', imageMediaId: theirMedia.id, startsAt: new Date(Date.now() + DAY), endsAt: new Date(Date.now() + DAY + 3600_000) }).returning()
      await db.insert(beatScenes).values({ beatId: theirBeat.id, sceneId: theirScene.id })
      const theirDesign = await createDesign(other)
      const before = await db.select().from(assistantShows)
      const tries: Array<[ShowItemKind, Record<string, string>]> = [
        ['event', { eventId: theirEvent.id }], ['scene_link', { sceneId: theirScene.id }], ['showing', { showingId: theirShowing.id }],
        ['beat', { beatId: theirBeat.id }], ['beat_paid', { beatId: theirBeat.id }], ['wearable_design', { designId: theirDesign.id }],
        ['raffle', { raffleId: crypto.randomUUID() }],
      ]
      for (const [kind, ref] of tries) expect(await attach(s, kind, { ref }), kind).toEqual({ status: 404, json: { error: 'not_found', message: NOT_YOURS } })
      expect(await db.select().from(assistantShows)).toEqual(before)
    })

    it('a ref the item does not take, or that is not an id, is refused', async () => {
      const s = await everything()
      const r = await newRaffle()
      expect((await attach(s, 'beat', { ref: { raffleId: r.id } })).status).toBe(400)
      expect((await attach(s, 'raffle', { ref: { raffleId: 'not-an-id' } })).status).toBe(400)
      expect((await attach(s, 'raffle', { wearable: `https://decentraland.org/marketplace/contracts/${CONTRACT}/items/1` })).status).toBe(400)
      expect((await attach(s, 'raffle', {})).status).toBe(400)
    })

    it('an empty ref clears the item; clearing the event item clears the show\'s event', async () => {
      const s = await everything()
      const ev = await newEvent()
      await attach(s, 'event', { ref: { eventId: ev.id } })
      expect((await attach(s, 'event', { ref: {} })).status).toBe(200)
      const now = await show(s.id)
      expect(now.eventId).toBeNull()
      expect(item(now, 'event')).toEqual({ state: 'todo', note: null })
    })

    it('bad wearable shapes are refused with the example, and the show is unchanged', async () => {
      const s = await everything()
      const before = await db.select().from(assistantShows)
      const bad = [
        'https://decentraland.org/marketplace/contracts/0x1234/items/1',
        `https://evil.example/marketplace/contracts/${CONTRACT}/items/1`,
        `http://decentraland.org/marketplace/contracts/${CONTRACT}/items/1`,
        `https://decentraland.org/marketplace/contracts/${CONTRACT}/items/one`,
        `https://decentraland.org/marketplace/contracts/${CONTRACT}/tokens/1`,
        'a cool hat',
        42,
        { contract: '0xnothex', itemId: '1' },
        { contract: CONTRACT, itemId: 'one' },
        { contract: CONTRACT },
        { url: `https://decentraland.org/marketplace/contracts/${CONTRACT}/items/1` },
      ]
      for (const wearable of bad) {
        expect(await attach(s, 'wearable_published', { wearable }), JSON.stringify(wearable)).toEqual({ status: 400, json: { error: 'bad_wearable', message: WEARABLE_EXAMPLE } })
      }
      expect(await db.select().from(assistantShows)).toEqual(before)
    })

    it('a Marketplace link or a contract and item id is stored', async () => {
      const s = await everything()
      const upper = '0x' + 'AB'.repeat(20)
      expect((await attach(s, 'wearable_published', { wearable: `https://decentraland.org/marketplace/contracts/${upper}/items/12` })).status).toBe(200)
      expect((await show(s.id)).items.find((i) => i.kind === 'wearable_published')!.wearable).toEqual({ contract: CONTRACT, itemId: '12', url: `https://decentraland.org/marketplace/contracts/${CONTRACT}/items/12` })
      expect((await attach(s, 'wearable_published', { wearable: { contract: CONTRACT, itemId: '0' } })).status).toBe(200)
      expect((await show(s.id)).items.find((i) => i.kind === 'wearable_published')!.wearable).toEqual({ contract: CONTRACT, itemId: '0', url: `https://decentraland.org/marketplace/contracts/${CONTRACT}/items/0` })
      expect((await attach(s, 'wearable_published', { wearable: null })).status).toBe(200)
      expect(item(await show(s.id), 'wearable_published').state).toBe('waiting')
    })

    it('an item that is not in the show is 404, and a closed show takes no changes', async () => {
      const s = await everything()
      expect((await call(owner, 'PATCH', `/api/assistant/shows/${s.id}/items/${crypto.randomUUID()}`, { ref: {} })).status).toBe(404)
      expect((await call(owner, 'POST', `/api/assistant/shows/${s.id}/close`)).status).toBe(200)
      expect((await attach(s, 'event', { ref: {} })).status).toBe(409)
    })
  })

  describe('routes', () => {
    it('creating checks the title and 1 to 20 items of known kinds', async () => {
      const bad = [
        { title: '', items: [{ kind: 'raffle', label: 'x' }] },
        { title: 'x', items: [] },
        { title: 'x', items: Array.from({ length: 21 }, () => ({ kind: 'raffle', label: 'x' })) },
        { title: 'x', items: [{ kind: 'fireworks', label: 'x' }] },
        { title: 'x', items: [{ kind: 'raffle', label: '' }] },
        { title: 'x', startTime: 'friday', items: [{ kind: 'raffle', label: 'x' }] },
      ]
      for (const body of bad) expect((await call(owner, 'POST', '/api/assistant/shows', body)).status, JSON.stringify(body)).toBe(400)
      const ok = await create({ title: 'x', items: Array.from({ length: 20 }, () => ({ kind: 'raffle', label: 'x' })) })
      expect(ok.items).toHaveLength(20)
    })

    it('lists open shows newest first, by event when asked; a closed show drops out', async () => {
      const ev = await newEvent()
      const first = await create({ title: 'First', items: [{ kind: 'event', label: 'Event' }] })
      const second = await create({ title: 'Second', items: [{ kind: 'raffle', label: 'Raffle' }] })
      await create({ title: 'Theirs', items: [{ kind: 'raffle', label: 'Raffle' }] }, other)
      await attach(first, 'event', { ref: { eventId: ev.id } })
      // Attaching touches the show: it is the newest now
      expect((await call(owner, 'GET', '/api/assistant/shows')).json.shows.map((s: ShowView) => s.title)).toEqual(['First', 'Second'])
      expect((await call(owner, 'GET', `/api/assistant/shows?eventId=${ev.id}`)).json.shows.map((s: ShowView) => s.title)).toEqual(['First'])
      expect((await call(owner, 'GET', '/api/assistant/shows?eventId=nope')).status).toBe(400)
      const closed = await call(owner, 'POST', `/api/assistant/shows/${second.id}/close`)
      expect(closed.status).toBe(200)
      expect(closed.json.closedAt).toEqual(expect.any(String))
      expect((await call(owner, 'GET', '/api/assistant/shows')).json.shows.map((s: ShowView) => s.title)).toEqual(['First'])
      expect((await show(second.id)).closedAt).toEqual(closed.json.closedAt)
    })

    it("another user's show is 404 on every route", async () => {
      const s = await everything()
      for (const [method, url, payload] of [
        ['GET', `/api/assistant/shows/${s.id}`, undefined],
        ['PATCH', `/api/assistant/shows/${s.id}/items/${s.items[0].id}`, { ref: {} }],
        ['POST', `/api/assistant/shows/${s.id}/close`, undefined],
      ] as const) {
        expect((await call(other, method, url, payload)).status, `${method} ${url}`).toBe(404)
      }
      expect((await call(other, 'GET', '/api/assistant/shows')).json.shows).toEqual([])
      expect((await show(s.id)).closedAt).toBeNull()
    })

    it('names the organization, and keeps the conversation when it is the user\'s', async () => {
      const [conv] = await db.insert(assistantConversations).values({ userId: owner.id, title: 'Chat' }).returning()
      const [theirConv] = await db.insert(assistantConversations).values({ userId: other.id, title: 'Chat' }).returning()
      const s = await create({ title: 'x', conversationId: conv.id, items: [{ kind: 'raffle', label: 'x' }] })
      expect(s.orgName).toBeNull()
      expect((await db.select().from(assistantShows).where(eq(assistantShows.id, s.id)))[0].conversationId).toBe(conv.id)
      expect((await call(owner, 'POST', '/api/assistant/shows', { title: 'x', conversationId: theirConv.id, items: [{ kind: 'raffle', label: 'x' }] })).status).toBe(404)
    })

    it('uses the assistant\'s own access: off means 404', async () => {
      set('assistantEnabled', false)
      expect((await call(owner, 'GET', '/api/assistant/shows')).status).toBe(404)
    })
  })

  describe('tools', () => {
    let ctx: ToolCtx
    beforeEach(() => {
      const request = { headers: { authorization: `Bearer ${tokenFor(owner)}` }, ip: '198.51.100.7' } as unknown as FastifyRequest
      ctx = { app, request, user: { id: owner.id, email: owner.email, role: owner.role, orgId: null }, self: { email: owner.email, wallets: [] } }
    })

    it('start_show returns the timeline and warning, and its undo closes the show', async () => {
      const r = await runTool(ctx, 'start_show', { title: 'Wearable raffle', startTime: new Date(Date.now() + 3 * DAY).toISOString(), items: [{ kind: 'wearable_design', label: 'Design the cap' }, { kind: 'raffle', label: 'Raffle it' }] })
      expect(r).toMatchObject({ ok: true, summary: { title: 'Wearable raffle', timeline: SHOW_TIMELINE, warning: SHOW_TOO_SOON } })
      const a = await recordDirect(ctx, null, 'start_show', { title: 'Second', items: [{ kind: 'raffle', label: 'Raffle it' }] })
      expect(a).toMatchObject({ status: 'done', canUndo: true, label: 'Start the show "Second"' })
      const [row] = await db.select().from(assistantShows).where(eq(assistantShows.title, 'Second'))
      expect(await undoAction(ctx, a.id)).toMatchObject({ status: 'undone' })
      expect((await db.select().from(assistantShows).where(eq(assistantShows.id, row.id)))[0].closedAt).not.toBeNull()
    })

    it('get_show and list_shows read the user\'s shows', async () => {
      const s = await everything()
      expect(await runTool(ctx, 'get_show', { showId: s.id })).toMatchObject({ ok: true, summary: { id: s.id, items: expect.any(Array) } })
      expect(await runTool(ctx, 'list_shows', {})).toMatchObject({ ok: true, summary: [{ id: s.id, title: 'Friday night' }] })
    })

    it("attach_to_show's undo puts the previous ref back, and refuses once the item changed since", async () => {
      const s = await everything()
      const r1 = await newRaffle()
      const raffleItem = s.items.find((i) => i.kind === 'raffle')!
      const a = await recordDirect(ctx, null, 'attach_to_show', { showId: s.id, itemId: raffleItem.id, ref: { raffleId: r1.id } })
      expect(a).toMatchObject({ status: 'done', canUndo: true })
      expect(item(await show(s.id), 'raffle').state).toBe('done')
      expect(await undoAction(ctx, a.id)).toMatchObject({ status: 'undone' })
      expect(item(await show(s.id), 'raffle').state).toBe('todo')

      const b = await recordDirect(ctx, null, 'attach_to_show', { showId: s.id, itemId: raffleItem.id, ref: { raffleId: r1.id } })
      await attach(s, 'raffle', { ref: {} })
      expect(await undoAction(ctx, b.id)).toEqual({ error: 'changed' })
    })

    it('attach_to_show passes on the route\'s refusals', async () => {
      const s = await everything()
      const theirs = await newRaffle((await createScene(other, 'Theirs')).scene.id)
      const raffleItem = s.items.find((i) => i.kind === 'raffle')!
      expect(await runTool(ctx, 'attach_to_show', { showId: s.id, itemId: raffleItem.id, ref: { raffleId: theirs.id } })).toMatchObject({ ok: false, status: 404, error: NOT_YOURS })
      const pub = s.items.find((i) => i.kind === 'wearable_published')!
      expect(await runTool(ctx, 'attach_to_show', { showId: s.id, itemId: pub.id, wearable: 'a hat' })).toMatchObject({ ok: false, status: 400, error: WEARABLE_EXAMPLE })
    })

    it('close_show closes it', async () => {
      const s = await everything()
      expect(await runTool(ctx, 'close_show', { showId: s.id })).toMatchObject({ ok: true })
      expect((await show(s.id)).closedAt).not.toBeNull()
    })
  })
})
