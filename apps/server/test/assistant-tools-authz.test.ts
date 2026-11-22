import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { db } from '../src/db/connection.js'
import { beats, beatScenes, events, eventSceneLinks, mediaAssets, raffles, sceneLibrary, scenePresetSchedules, screenShowings } from '../src/db/schema.js'
import { TOOLS } from '../src/assistant/tools/index.js'
import { runTool } from '../src/assistant/tools/run.js'
import type { ToolCtx } from '../src/assistant/tools/types.js'
import { resetDb } from './helpers/db.js'
import { createAnalyticsScene } from './helpers/analytics.js'
import { createSetup } from './helpers/setups.js'
import { testApp, createUser, createScene, createElement, createInstance, tokenFor, type TestUser } from './helpers/factories.js'
import { addRevision, createDesign } from './helpers/studio.js'
import { config } from '../src/config.js'
import { setImageSizeReader } from '../src/beats/image.js'
import { BEATS_READY } from './helpers/beats-ready.js'

/** Tools that read only the caller's own account: they take no ids, so A can't even name B's data. */
const ACCOUNT_SCOPED = ['get_plan', 'list_orgs', 'list_scenes', 'list_events', 'list_media', 'list_analytics_locations', 'search_help', 'open_page', 'list_designs', 'get_studio_usage', 'create_scene', 'create_design', 'create_event']

type Fixtures = Awaited<ReturnType<typeof fixtures>>

/** Everything is B's; A owns only `aScene`, used to reach for B's ids through A's own scene. */
async function fixtures() {
  const a = await createUser()
  const b = await createUser()
  const { scene: aScene } = await createScene(a, 'A scene')
  const { scene, preset } = await createScene(b, 'B scene')
  const element = await createElement(preset.id)
  const instance = await createInstance(element.id)
  const [schedule] = await db.insert(scenePresetSchedules).values({ sceneId: scene.id, presetId: preset.id, recurrence: 'daily', startDate: '2030-01-01', startTime: '20:00', timezone: 'UTC', durationMinutes: 60 }).returning()
  const [media] = await db.insert(mediaAssets).values({ ownerId: b.id, filename: 'b.png', contentType: 'image/png', sizeBytes: 1, storageKey: 'media/b/b.png', publicUrl: 'https://cdn.example/b.png' }).returning()
  const [libraryItem] = await db.insert(sceneLibrary).values({ sceneId: scene.id, mediaAssetId: media.id, addedBy: b.id }).returning()
  const [showing] = await db.insert(screenShowings).values({ sceneId: scene.id, elementId: element.id, title: 'B show', items: [{ url: 'https://cdn.example/b.mp4', duration: 60, kind: 'video' }], recurrence: 'daily', startDate: '2030-01-01', startTime: '20:00', timezone: 'UTC' }).returning()
  const [event] = await db.insert(events).values({ ownerId: b.id, name: 'B event', startTime: new Date(Date.now() - 2 * 3600_000), endTime: new Date(Date.now() - 3600_000) }).returning()
  await db.insert(eventSceneLinks).values({ eventId: event.id, sceneId: scene.id })
  const location = await createAnalyticsScene({ claimedByUserId: b.id, claimStatus: 'active' })
  await createSetup(location.id, scene.id)
  const design = await createDesign(b, { name: 'B design' })
  await addRevision(design, 'hat')
  const [raffle] = await db.insert(raffles).values({ sceneId: scene.id, createdBy: b.id, name: 'B raffle', prize: 'B prize', winnersCount: 1, mode: 'one_per_person', minPresentSeconds: 0, hostTermsAcceptedAt: new Date() }).returning()
  const [beat] = await db.insert(beats).values({ chain: 'polygon', ownerUserId: b.id, name: 'B beat', description: '', imageMediaId: media.id, startsAt: new Date(Date.now() + 2 * 3600_000), endsAt: new Date(Date.now() + 4 * 3600_000) }).returning()
  await db.insert(beatScenes).values({ beatId: beat.id, sceneId: scene.id })
  return { a, b, aScene, scene, preset, element, instance, schedule, media, libraryItem, showing, event, location, design, raffle, beat }
}

const when = { recurrence: 'daily' as const, startDate: '2031-01-01', startTime: '10:00', timezone: 'UTC' }

/** Valid args for every tool that names something, against B's fixtures. */
const SAMPLE: Record<string, (f: Fixtures) => unknown> = {
  get_scene: (f) => ({ sceneId: f.scene.id }),
  get_scene_publishing: (f) => ({ sceneId: f.scene.id }),
  get_preset_schedules: (f) => ({ sceneId: f.scene.id }),
  get_event: (f) => ({ eventId: f.event.id }),
  get_analytics_summary: (f) => ({ locationId: f.location.id, from: '2026-01-01T00:00:00Z', to: '2026-02-01T00:00:00Z' }),
  get_scene_errors: (f) => ({ sceneId: f.scene.id }),
  list_scene_library: (f) => ({ sceneId: f.scene.id }),
  list_scene_streams: (f) => ({ sceneId: f.scene.id }),
  list_showings: (f) => ({ elementId: f.element.id }),
  update_scene: (f) => ({ sceneId: f.scene.id, name: 'Taken', description: 'mine now' }),
  create_preset: (f) => ({ sceneId: f.scene.id, name: 'A preset' }),
  rename_preset: (f) => ({ sceneId: f.scene.id, presetId: f.preset.id, name: 'Renamed' }),
  activate_preset: (f) => ({ sceneId: f.scene.id, presetId: f.preset.id }),
  create_element: (f) => ({ sceneId: f.scene.id, presetId: f.preset.id, type: 'image', name: 'A image' }),
  update_element: (f) => ({ sceneId: f.scene.id, elementId: f.element.id, name: 'Taken', properties: { liveSrc: 'https://evil.example/live.m3u8' } }),
  set_element_live: (f) => ({ sceneId: f.scene.id, elementId: f.element.id, enabled: true }),
  add_instance: (f) => ({ sceneId: f.scene.id, elementId: f.element.id, position: { x: 2, y: 0, z: 2 } }),
  update_instance: (f) => ({ sceneId: f.scene.id, instanceId: f.instance.id, position: { x: 9, y: 9, z: 9 } }),
  create_preset_schedule: (f) => ({ sceneId: f.scene.id, presetId: f.preset.id, ...when, durationMinutes: 30 }),
  update_preset_schedule: (f) => ({ sceneId: f.scene.id, scheduleId: f.schedule.id, startTime: '11:00' }),
  add_to_library: (f) => ({ sceneId: f.scene.id, mediaAssetId: f.media.id }),
  rename_library_item: (f) => ({ sceneId: f.scene.id, itemId: f.libraryItem.id, name: 'Taken' }),
  create_showing: (f) => ({ sceneId: f.scene.id, elementId: f.element.id, title: 'A show', items: [{ url: 'https://cdn.example/a.mp4', duration: 60 }], ...when }),
  get_design: (f) => ({ designId: f.design.id }),
  send_studio_prompt: (f) => ({ designId: f.design.id, text: 'make it mine' }),
  get_finalize_quote: (f) => ({ designId: f.design.id }),
  open_finalize: (f) => ({ designId: f.design.id }),
  update_event: (f) => ({ eventId: f.event.id, name: 'Taken' }),
  link_event_scene: (f) => ({ eventId: f.event.id, sceneId: f.aScene.id }),
  list_scene_raffles: (f) => ({ sceneId: f.scene.id }),
  create_raffle: (f) => ({ sceneId: f.scene.id, name: 'A raffle', prize: 'A prize', winnersCount: 1, mode: 'one_per_person' }),
  schedule_raffle_open: (f) => ({ raffleId: f.raffle.id, opensAt: '2031-01-01T20:00:00Z' }),
  update_raffle_prize: (f) => ({ raffleId: f.raffle.id, prize: 'Taken' }),
  create_beat_draft: (f) => ({ name: 'A beat', startsAt: new Date(Date.now() + 5 * 3600_000).toISOString(), endsAt: new Date(Date.now() + 6 * 3600_000).toISOString(), sceneIds: [f.scene.id], imageMediaId: f.media.id }),
  get_beat: (f) => ({ beatId: f.beat.id }),
  open_beat_pay: (f) => ({ beatId: f.beat.id }),
}

function ctxFor(app: FastifyInstance, user: TestUser): ToolCtx {
  const request = { headers: { authorization: `Bearer ${tokenFor(user)}` }, ip: '203.0.113.9' } as unknown as FastifyRequest
  return { app, request, user: { id: user.id, email: user.email, role: user.role, orgId: null }, self: { email: user.email, wallets: [] } }
}

/** Everything B can see about the scene, read as B. */
async function snapshot(app: FastifyInstance, f: Fixtures) {
  const headers = { authorization: `Bearer ${tokenFor(f.b)}` }
  const get = async (url: string) => {
    const res = await app.inject({ method: 'GET', url, headers })
    expect(res.statusCode).toBe(200)
    return res.json()
  }
  const scene = await get(`/api/scenes/${f.scene.id}`)
  const schedules = (await get(`/api/scenes/${f.scene.id}/preset-schedules`)).schedules.map((s: any) => ({ ...s, nextRuns: undefined }))
  return {
    scene,
    schedules,
    library: await get(`/api/scenes/${f.scene.id}/library`),
    showings: (await get(`/api/elements/${f.element.id}/showings`)).showings.map((s: any) => ({ id: s.id, title: s.title, startTime: s.startTime })),
    design: await get(`/api/studio/designs/${f.design.id}`),
    event: await get(`/api/events/${f.event.id}`),
    raffle: await get(`/api/raffles/${f.raffle.id}`),
    beat: await get(`/api/beats/${f.beat.id}`),
    beats: await get('/api/beats'),
  }
}

describe('assistant tools: authorization is the route\'s own', () => {
  let app: FastifyInstance
  let f: Fixtures

  const prevStudio = config.studioEnabled
  const prevBeats = config.beats
  beforeAll(async () => {
    ;(config as any).studioEnabled = true
    ;(config as any).beats = { ...prevBeats, enabled: true, chain: 'polygon', ...BEATS_READY }
    setImageSizeReader(async () => ({ width: 1024, height: 1024 }))
    app = await testApp()
  })
  afterAll(async () => {
    ;(config as any).studioEnabled = prevStudio
    ;(config as any).beats = prevBeats
    setImageSizeReader(null)
    await app.close()
  })
  beforeEach(async () => {
    await resetDb()
    f = await fixtures()
  })

  it('has a sample for every tool that names something', () => {
    expect(Object.keys(SAMPLE).sort()).toEqual(Object.keys(TOOLS).filter((n) => !ACCOUNT_SCOPED.includes(n)).sort())
  })

  it('every SAMPLE tool, run as A against B\'s data, is refused and changes nothing', async () => {
    const before = await snapshot(app, f)
    const ctx = ctxFor(app, f.a)
    for (const [name, args] of Object.entries(SAMPLE)) {
      const r = await runTool(ctx, name, args(f))
      expect(r.ok, name).toBe(false)
      expect([403, 404], `${name} gave ${r.status}`).toContain(r.status)
    }
    expect(await snapshot(app, f)).toEqual(before)
  })

  it('B\'s element named through A\'s own scene is refused', async () => {
    const before = await snapshot(app, f)
    const ctx = ctxFor(app, f.a)
    const r = await runTool(ctx, 'update_element', { sceneId: f.aScene.id, elementId: f.element.id, name: 'Taken' })
    expect(r).toMatchObject({ ok: false, status: 404, error: "That element isn't in this scene." })
    expect(await snapshot(app, f)).toEqual(before)
  })

  it('account-scoped tools show A none of B\'s ids', async () => {
    const ctx = ctxFor(app, f.a)
    const bIds = [f.scene.id, f.preset.id, f.element.id, f.instance.id, f.schedule.id, f.media.id, f.libraryItem.id, f.showing.id, f.event.id, f.location.id, f.design.id, f.raffle.id, f.beat.id]
    const args: Record<string, unknown> = {
      search_help: { query: 'scene' }, open_page: { path: '/scenes', label: 'Scenes' },
      create_scene: { name: 'A new scene' }, create_event: { name: 'A event', startTime: '2031-01-01T20:00:00Z', endTime: '2031-01-01T22:00:00Z' }, create_design: { kind: 'wearable', name: 'A design', agent: 'claude' },
    }
    for (const name of ACCOUNT_SCOPED) {
      const r = await runTool(ctx, name, args[name] ?? {})
      expect(r.ok, `${name}: ${JSON.stringify(r)}`).toBe(true)
      const text = JSON.stringify(r)
      for (const id of bIds) expect(text, name).not.toContain(id)
    }
  })
})
