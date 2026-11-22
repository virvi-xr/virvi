import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { db } from '../src/db/connection.js'
import { events, eventSceneLinks, mediaAssets, sceneLibrary, scenePresetSchedules, screenShowings } from '../src/db/schema.js'
import { TOOLS } from '../src/assistant/tools/index.js'
import { runTool } from '../src/assistant/tools/run.js'
import type { ToolCtx } from '../src/assistant/tools/types.js'
import { resetDb } from './helpers/db.js'
import { createAnalyticsScene } from './helpers/analytics.js'
import { createSetup } from './helpers/setups.js'
import { testApp, createUser, createScene, createElement, createInstance, tokenFor, type TestUser } from './helpers/factories.js'
import { addRevision, createDesign } from './helpers/studio.js'
import { config } from '../src/config.js'

/** Tools that read only the caller's own account: they take no ids, so A can't even name B's data. */
const ACCOUNT_SCOPED = ['get_plan', 'list_orgs', 'list_scenes', 'list_events', 'list_media', 'list_analytics_locations', 'search_help', 'open_page', 'list_designs', 'get_studio_usage', 'create_scene', 'create_design']

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
  return { a, b, aScene, scene, preset, element, instance, schedule, media, libraryItem, showing, event, location, design }
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
  }
}

describe('assistant tools: authorization is the route\'s own', () => {
  let app: FastifyInstance
  let f: Fixtures

  const prevStudio = config.studioEnabled
  beforeAll(async () => {
    ;(config as any).studioEnabled = true
    app = await testApp()
  })
  afterAll(async () => {
    ;(config as any).studioEnabled = prevStudio
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
    const bIds = [f.scene.id, f.preset.id, f.element.id, f.instance.id, f.schedule.id, f.media.id, f.libraryItem.id, f.showing.id, f.event.id, f.location.id, f.design.id]
    const args: Record<string, unknown> = {
      search_help: { query: 'scene' }, open_page: { path: '/scenes', label: 'Scenes' },
      create_scene: { name: 'A new scene' }, create_design: { kind: 'wearable', name: 'A design', agent: 'claude' },
    }
    for (const name of ACCOUNT_SCOPED) {
      const r = await runTool(ctx, name, args[name] ?? {})
      expect(r.ok, `${name}: ${JSON.stringify(r)}`).toBe(true)
      const text = JSON.stringify(r)
      for (const id of bIds) expect(text, name).not.toContain(id)
    }
  })
})
