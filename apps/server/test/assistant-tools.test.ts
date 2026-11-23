import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from 'vitest'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '../src/db/connection.js'
import { sceneElements, scenes } from '../src/db/schema.js'
import { config } from '../src/config.js'
import { TOOLS } from '../src/assistant/tools/index.js'
import { inject, runTool, toolsForModel } from '../src/assistant/tools/run.js'
import type { ToolCtx } from '../src/assistant/tools/types.js'
import { resetDb } from './helpers/db.js'
import { testApp, createUser, createScene, createElement, createInstance, randomWallet, tokenFor, type TestUser } from './helpers/factories.js'
import { addRevision, createDesign } from './helpers/studio.js'
import { DeployerError } from '../src/services/dcl/world-deployer.js'
import { FakeWorldsClient } from './helpers/fake-worlds.js'
import { setWorldsClient } from '../src/services/dcl/worlds-client.js'
import { approvePlan, proposeCard, recordDirect, undoAction } from '../src/assistant/actions.js'
import { destinationName, nextStep } from '../src/assistant/tools/deploy.js'
import { routeError } from '../src/assistant/tools/http.js'
import { isDashboardPath } from '../src/assistant/tools/local.js'
import { LABEL_TEXT_MAX, STUDIO_PAUSED, STUDIO_REFUSALS } from '../src/assistant/tools/studio.js'
import { sceneRoles, userAuthMethods, dclWorldDestinations, sceneDeployments, assistantActions, assistantShows, beats, eventSceneLinks, events, mediaAssets, organizations, orgMembers, raffles, scenePresetSchedules, screenShowings, studioDesigns, studioKindDefaults, users } from '../src/db/schema.js'
import { RAFFLE_HOST_TERMS, fillRules } from '@virvixr/shared'
import { RAFFLE_RULES_INCLUDED, RAFFLE_SEND_WEARABLE, cardTime } from '../src/assistant/tools/shows-tools.js'
import { setImageSizeReader } from '../src/beats/image.js'
import { BEATS_READY } from './helpers/beats-ready.js'

// The deployer is stubbed: a virvi destination's deploy route records a deployment row (or refuses), nothing is built
const deployer = vi.hoisted(() => ({ start: undefined as undefined | ((destinationId: string) => Promise<{ id: string }>) }))
vi.mock('../src/services/dcl/world-deployer.js', async (orig) => ({
  ...(await orig<typeof import('../src/services/dcl/world-deployer.js')>()),
  startVirviDeploy: (destinationId: string) => deployer.start!(destinationId),
}))

const IP = '198.51.100.23'

function ctxFor(app: FastifyInstance, user: TestUser): ToolCtx {
  const request = { headers: { authorization: `Bearer ${tokenFor(user)}` }, ip: IP } as unknown as FastifyRequest
  return { app, request, user: { id: user.id, email: user.email, role: user.role, orgId: null }, self: { email: user.email, wallets: [] }, walletRefs: [] }
}

describe('assistant tools, run as the owner', () => {
  let app: FastifyInstance
  let owner: TestUser
  let ctx: ToolCtx
  let sceneId: string
  let presetId: string
  const prevDisabled = config.assistantDisabledTools
  const prevDocs = config.docsDir

  beforeAll(async () => {
    app = await testApp()
  })
  afterAll(async () => {
    await app.close()
  })
  beforeEach(async () => {
    await resetDb()
    owner = await createUser()
    const { scene, preset } = await createScene(owner, 'Old Lounge')
    sceneId = scene.id
    presetId = preset.id
    ctx = ctxFor(app, owner)
  })
  afterEach(() => {
    ;(config as any).assistantDisabledTools = prevDisabled
    ;(config as any).docsDir = prevDocs
    vi.restoreAllMocks()
  })

  it('every write reads its before state', () => {
    for (const [name, def] of Object.entries(TOOLS)) if (def.effect === 'write') expect(def.before, name).toBeTypeOf('function')
  })

  it('every paid tool has preview()', () => {
    const paid = Object.values(TOOLS).filter((t) => t.effect === 'paid' || t.effect === 'public')
    expect(paid.map((t) => t.name)).toContain('send_studio_prompt')
    for (const def of paid) expect(def.preview, def.name).toBeTypeOf('function')
  })

  it('a paid tool without before() is a programming error', async () => {
    ;(TOOLS as any).test_paid = {
      name: 'test_paid', description: 'x', input: z.object({}), effect: 'paid',
      call: () => ({ method: 'GET', url: '/api/health' }), label: () => 'Paid', summarize: () => ({}),
    }
    try {
      await expect(runTool(ctx, 'test_paid', {})).rejects.toThrow(/is paid without before\(\)/)
    } finally {
      delete (TOOLS as any).test_paid
    }
  })

  it('update_scene renames, and its undo call restores the name', async () => {
    const r = await runTool(ctx, 'update_scene', { sceneId, name: 'Test Lounge' })
    expect(r).toMatchObject({ ok: true, status: 200, label: 'Rename scene to "Test Lounge"', orgName: null })
    if (!r.ok) throw new Error('failed')
    expect(r.after).toEqual({ name: 'Test Lounge' })
    expect(r.undo).toEqual({ method: 'PUT', url: `/api/scenes/${sceneId}`, body: { name: 'Old Lounge' } })
    expect((await db.query.scenes.findFirst({ where: eq(scenes.id, sceneId) }))!.name).toBe('Test Lounge')
    expect((await inject(ctx, r.undo!)).status).toBe(200)
    expect((await db.query.scenes.findFirst({ where: eq(scenes.id, sceneId) }))!.name).toBe('Old Lounge')
  })

  it("update_element merges partial properties and undoes with the element's full previous state", async () => {
    const props = { liveSrc: 'https://old.example/live.m3u8', offImageSrc: 'https://cdn.example/off.png', playlist: ['https://cdn.example/a.mp4'], volume: 0.5 }
    const el = await createElement(presetId, { properties: props })
    const r = await runTool(ctx, 'update_element', { sceneId, elementId: el.id, properties: { liveSrc: 'https://x/live.m3u8' } })
    expect(r.ok).toBe(true)
    if (!r.ok) throw new Error('failed')
    const now = await db.query.sceneElements.findFirst({ where: eq(sceneElements.id, el.id) })
    expect(now!.properties).toEqual({ ...props, liveSrc: 'https://x/live.m3u8' })
    expect(r.undo).toEqual({ method: 'PUT', url: `/api/elements/${el.id}`, body: { properties: props } })
    expect(r.after).toEqual({ properties: { ...props, liveSrc: 'https://x/live.m3u8' } })
    await inject(ctx, r.undo!)
    expect((await db.query.sceneElements.findFirst({ where: eq(sceneElements.id, el.id) }))!.properties).toEqual(props)
  })

  it('create_element gives an undo that deletes the element', async () => {
    const r = await runTool(ctx, 'create_element', { sceneId, presetId, type: 'image', name: 'Poster', properties: { textureSrc: 'https://cdn.example/p.png' } })
    expect(r.ok).toBe(true)
    if (!r.ok) throw new Error('failed')
    const [created] = await db.select().from(sceneElements).where(eq(sceneElements.presetId, presetId))
    expect(r.undo).toEqual({ method: 'DELETE', url: `/api/elements/${created.id}` })
    expect(r.after).toMatchObject({ id: created.id, type: 'image', name: 'Poster' })
    expect((await inject(ctx, r.undo!)).status).toBe(204)
    expect(await db.query.sceneElements.findFirst({ where: eq(sceneElements.id, created.id) })).toBeUndefined()
  })

  it('names the organization the scene belongs to', async () => {
    const { organizations } = await import('../src/db/schema.js')
    const [org] = await db.insert(organizations).values({ name: 'Acme', slug: `acme-${owner.id.slice(0, 8)}`, billingOwnerId: owner.id }).returning()
    await db.update(scenes).set({ orgId: org.id }).where(eq(scenes.id, sceneId))
    const r = await runTool(ctx, 'update_scene', { sceneId, description: 'New' })
    expect(r).toMatchObject({ ok: true, orgName: 'Acme' })
  })

  it('an unknown tool, or one switched off, is unknown_tool', async () => {
    expect(await runTool(ctx, 'drop_tables', {})).toMatchObject({ ok: false, status: 404, error: 'unknown_tool' })
    ;(config as any).assistantDisabledTools = ['get_scene']
    expect(await runTool(ctx, 'get_scene', { sceneId })).toMatchObject({ ok: false, status: 404, error: 'unknown_tool' })
    expect(toolsForModel().map((t) => t.name)).not.toContain('get_scene')
  })

  it('bad args are a 400 with the reason', async () => {
    const r = await runTool(ctx, 'update_scene', { sceneId: 123 })
    expect(r).toMatchObject({ ok: false, status: 400 })
    if (r.ok) throw new Error('passed')
    expect(r.error).toMatch(/sceneId/)
  })

  it("a route's refusal comes back with the route's own message", async () => {
    const r = await runTool(ctx, 'create_preset_schedule', { sceneId, presetId, recurrence: 'daily', startDate: '2031-01-01', startTime: '10:00', timezone: 'Mars/Olympus' })
    expect(r).toMatchObject({ ok: false, status: 400, error: 'Choose a timezone.' })
    // No message: the route's error code
    const { scene: other, preset: otherPreset } = await createScene(owner, 'Other')
    expect(other.id).not.toBe(sceneId)
    const r2 = await runTool(ctx, 'create_preset', { sceneId, name: 'Copy', fromPresetId: otherPreset.id })
    expect(r2).toMatchObject({ ok: false, status: 400, error: 'Preset does not belong to this scene' })
  })

  it('open_page accepts dashboard paths only', async () => {
    expect(await runTool(ctx, 'open_page', { path: '/scenes?id=abc', label: 'Your scene' })).toMatchObject({ ok: true, summary: { href: '/scenes?id=abc', label: 'Your scene' } })
    for (const path of ['/sync?scene=abc', '/drops', '/drops?id=g1', '/virvi-cities', '/cities', '/deploy', '/giveaways']) {
      expect(isDashboardPath(path), path).toBe(true)
    }
    for (const path of ['https://evil.example', 'javascript:alert(1)', '//evil.example', '/admin', '/scenes/../admin', '/scenes\\..\\admin', '/scenes/%2e%2e/admin']) {
      expect(await runTool(ctx, 'open_page', { path, label: 'x' }), path).toMatchObject({ ok: false, status: 400, error: 'Only Virvi dashboard pages can be opened.' })
    }
  })

  it('search_help finds docs pages, and nothing without docs', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'virvi-docs-'))
    mkdirSync(join(dir, 'guides'))
    writeFileSync(join(dir, 'guides', 'streaming.md'), '# Live streaming\n\nStart a live stream on a screen. Streaming needs a stream key.\n')
    writeFileSync(join(dir, 'index.md'), '# Welcome\n\nVirvi manages scenes.\n')
    ;(config as any).docsDir = dir
    const r = await runTool(ctx, 'search_help', { query: 'live streaming' })
    expect(r.ok).toBe(true)
    if (!r.ok) throw new Error('failed')
    expect(r.summary).toEqual([{ title: 'Live streaming', href: '/docs/guides/streaming', excerpt: expect.stringContaining('Start a live stream') }])
    ;(config as any).docsDir = join(dir, 'missing')
    expect(await runTool(ctx, 'search_help', { query: 'live' })).toMatchObject({ ok: true, summary: [] })
  })

  it("injects with the caller's own address, so each user has their own rate-limit bucket", async () => {
    const spy = vi.spyOn(app, 'inject')
    await runTool(ctx, 'get_scene', { sceneId })
    expect(spy).toHaveBeenCalled()
    for (const [opts] of spy.mock.calls) {
      expect(opts).toMatchObject({ remoteAddress: IP, headers: { authorization: ctx.request.headers.authorization } })
    }
  })

  it("someone else's email in a scene reaches the model as [email]", async () => {
    await db.update(scenes).set({ description: 'Ask bob@other.example for the keys' }).where(eq(scenes.id, sceneId))
    const r = await runTool(ctx, 'get_scene', { sceneId })
    expect(r.ok).toBe(true)
    if (!r.ok) throw new Error('failed')
    const text = JSON.stringify(r.summary)
    expect(text).toContain('Ask [email] for the keys')
    expect(text).not.toContain('bob@other.example')
  })

  it('every write works for the owner, and its undo applies', async () => {
    const { mediaAssets, sceneLibrary, scenePresetSchedules } = await import('../src/db/schema.js')
    const el = await createElement(presetId)
    const inst = await createInstance(el.id)
    const [second] = await db.insert((await import('../src/db/schema.js')).scenePresets).values({ sceneId, name: 'Night' }).returning()
    const [schedule] = await db.insert(scenePresetSchedules).values({ sceneId, presetId, recurrence: 'daily', startDate: '2030-01-01', startTime: '20:00', timezone: 'UTC', durationMinutes: 60 }).returning()
    const media = async (n: string) => (await db.insert(mediaAssets).values({ ownerId: owner.id, filename: `${n}.png`, contentType: 'image/png', sizeBytes: 1, storageKey: `media/${n}.png`, publicUrl: `https://cdn.example/${n}.png`, status: 'ready' }).returning())[0]
    const linked = await media('linked')
    const [item] = await db.insert(sceneLibrary).values({ sceneId, mediaAssetId: linked.id, addedBy: owner.id }).returning()
    const fresh = await media('fresh')
    const when = { recurrence: 'daily', startDate: '2031-01-01', startTime: '10:00', timezone: 'UTC' }
    const cases: Array<[string, Record<string, unknown>]> = [
      ['create_preset', { sceneId, name: 'Copy', fromPresetId: presetId }],
      ['rename_preset', { sceneId, presetId, name: 'Day' }],
      ['activate_preset', { sceneId, presetId: second.id }],
      ['set_element_live', { sceneId, elementId: el.id, enabled: true }],
      ['add_instance', { sceneId, elementId: el.id, position: { x: 2, y: 0, z: 2 } }],
      ['update_instance', { sceneId, instanceId: inst.id, position: { x: 5, y: 0, z: 5 }, scale: { x: 2, y: 2, z: 2 } }],
      ['create_preset_schedule', { sceneId, presetId: second.id, ...when, durationMinutes: 30, returnToPresetId: presetId }],
      ['update_preset_schedule', { sceneId, scheduleId: schedule.id, startTime: '21:00' }],
      ['add_to_library', { sceneId, mediaAssetId: fresh.id }],
      ['rename_library_item', { sceneId, itemId: item.id, name: 'Renamed' }],
      ['create_showing', { sceneId, elementId: el.id, title: 'Matinee', items: [{ url: 'https://cdn.example/m.mp4', duration: 60 }], ...when }],
    ]
    // create_scene and create_design can't be undone (their own tests)
    // create_giveaway is in assistant-tools-giveaways.test.ts. The event, raffle, BEAT and show writes have their own tests (show writes in assistant-shows.test.ts)
    const covered = new Set([...cases.map(([n]) => n), 'update_scene', 'update_element', 'create_element', 'create_scene', 'create_design', 'create_event', 'update_event', 'link_event_scene', 'create_beat_draft', 'start_show', 'attach_to_show', 'close_show', 'create_giveaway'])
    expect([...covered].sort()).toEqual(Object.values(TOOLS).filter((t) => t.effect === 'write').map((t) => t.name).sort())
    for (const [name, args] of cases) {
      const r = await runTool(ctx, name, args)
      expect(r, `${name}: ${JSON.stringify(r)}`).toMatchObject({ ok: true })
      if (!r.ok) continue
      expect(r.undo, name).not.toBeNull()
      expect(r.after, name).toBeTruthy()
      const undone = await inject(ctx, r.undo!)
      expect(undone.status, `${name} undo: ${JSON.stringify(undone.json)}`).toBeLessThan(300)
    }
    // Undo put things back
    const scene = await db.query.scenes.findFirst({ where: eq(scenes.id, sceneId), with: { presets: true } })
    expect(scene!.activePresetId).toBe(presetId)
    expect(scene!.presets.map((p) => p.name).sort()).toEqual(['Default', 'Night'])
    // The live route always writes the flag: off again, where it was unset before
    expect((await db.query.sceneElements.findFirst({ where: eq(sceneElements.id, el.id) }))!.properties).toEqual({ ...(el.properties as object), enableLiveStream: false })
    expect((await db.query.scenePresetSchedules.findFirst({ where: eq(scenePresetSchedules.id, schedule.id) }))!.startTime).toBe('20:00')
    expect((await db.query.mediaAssets.findFirst({ where: eq(mediaAssets.id, linked.id) }))!.filename).toBe('linked.png')
    expect(await db.select().from(sceneLibrary).where(eq(sceneLibrary.sceneId, sceneId))).toHaveLength(1)
  })

  it('create_scene makes a scene in the personal account, with no undo', async () => {
    const r = await runTool(ctx, 'create_scene', { name: 'New Club', description: 'Upstairs' })
    expect(r).toMatchObject({ ok: true, status: 201, label: 'Create scene "New Club"', orgName: null, undo: null })
    if (!r.ok) throw new Error('failed')
    const made = await db.query.scenes.findFirst({ where: eq(scenes.name, 'New Club') })
    expect(made).toMatchObject({ ownerId: owner.id, description: 'Upstairs' })
    expect(r.after).toEqual({ id: made!.id, name: 'New Club' })
    expect(r.summary).toEqual({ sceneId: made!.id, presetId: made!.activePresetId, name: 'New Club' })
  })

  it('adding a file already in the library has nothing to undo', async () => {
    const { mediaAssets, sceneLibrary } = await import('../src/db/schema.js')
    const [m] = await db.insert(mediaAssets).values({ ownerId: owner.id, filename: 'a.png', contentType: 'image/png', sizeBytes: 1, storageKey: 'media/a.png', publicUrl: 'https://cdn.example/a.png', status: 'ready' }).returning()
    await db.insert(sceneLibrary).values({ sceneId, mediaAssetId: m.id, addedBy: owner.id })
    expect(await runTool(ctx, 'add_to_library', { sceneId, mediaAssetId: m.id })).toMatchObject({ ok: true, undo: null })
  })

  it("someone else's email in a route's refusal reaches the model as [email]", async () => {
    const fake = (statusCode: number, body: string) => ({ ...ctx, app: { inject: async () => ({ statusCode, body }) } as unknown as FastifyInstance })
    const r = await runTool(fake(409, JSON.stringify({ error: 'taken', message: 'bob@other.example already has this' })), 'get_scene', { sceneId })
    expect(r).toMatchObject({ ok: false, status: 409, error: '[email] already has this' })
    // A body that isn't JSON is passed on as text, redacted too
    const r2 = await runTool(fake(500, 'upstream failed for carol@other.example'), 'list_scenes', {})
    expect(r2).toMatchObject({ ok: false, status: 500, error: 'upstream failed for [email]' })
    // The caller's own email stays
    const r3 = await runTool(fake(400, JSON.stringify({ message: `${owner.email} is not verified` })), 'list_scenes', {})
    expect(r3).toMatchObject({ ok: false, error: `${owner.email} is not verified` })
  })

  it('toolsForModel gives JSON schemas', () => {
    const t = toolsForModel().find((x) => x.name === 'update_scene')!
    expect(t.input_schema).toMatchObject({ type: 'object', properties: { sceneId: { type: 'string' } }, required: ['sceneId'] })
    expect(t.description.length).toBeGreaterThan(10)
  })
})

describe('assistant Studio tools', () => {
  let app: FastifyInstance
  let owner: TestUser
  let ctx: ToolCtx
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
    owner = await createUser()
    ctx = ctxFor(app, owner)
  })

  /** The owner's ctx with GET /api/studio/usage answered by `usage`, and any other GET in `routes` by its body. */
  const withUsage = (usage: Record<string, unknown>, routes: Record<string, unknown> = {}) => ({
    ...ctx,
    app: {
      inject: async (opts: { url: string; method: string }) => {
        if (opts.method === 'GET' && opts.url === '/api/studio/usage') {
          return { statusCode: 200, body: JSON.stringify({ credits: 0, giftedPrompts: 0, paused: false, ...usage }) }
        }
        if (opts.method === 'GET' && Object.hasOwn(routes, opts.url)) return { statusCode: 200, body: JSON.stringify(routes[opts.url]) }
        return app.inject(opts as any)
      },
    } as unknown as FastifyInstance,
  })

  it('create_design uses the kind\'s default agent, else claude', async () => {
    // The free plan's open-design limit: each one is archived before the next
    const archiveAll = () => db.update(studioDesigns).set({ archivedAt: new Date() }).where(eq(studioDesigns.ownerId, owner.id))
    const r = await runTool(ctx, 'create_design', { kind: 'wearable', name: 'Neon cap' })
    expect(r).toMatchObject({ ok: true, status: 201, label: 'Start a wearable design "Neon cap"', undo: null, orgName: null })
    await archiveAll()
    await db.insert(studioKindDefaults).values({ kind: 'emote', agent: 'codex' })
    const r2 = await runTool(ctx, 'create_design', { kind: 'emote', name: 'Spin' })
    expect(r2).toMatchObject({ ok: true, label: 'Start an emote design "Spin"' })
    await archiveAll()
    const r3 = await runTool(ctx, 'create_design', { kind: 'scene', name: 'Club', agent: 'grok' })
    expect(r3).toMatchObject({ ok: true, label: 'Start a building design "Club"' })
    const rows = await db.select().from(studioDesigns).where(eq(studioDesigns.ownerId, owner.id))
    expect(Object.fromEntries(rows.map((d) => [d.name, d.agent]))).toEqual({ 'Neon cap': 'claude', Spin: 'codex', Club: 'grok' })
    await archiveAll()
    const r4 = await runTool(ctx, 'create_design', { kind: 'scene', name: 'Lamps', sceneShape: 'decor' })
    expect(r4).toMatchObject({ ok: true, label: 'Start a decor design "Lamps"', summary: { sceneShape: 'decor' } })
    expect(await runTool(ctx, 'create_design', { kind: 'wearable', name: 'X', sceneShape: 'decor' })).toMatchObject({ ok: false, status: 400 })
    if (!r.ok) throw new Error('failed')
    const made = rows.find((d) => d.name === 'Neon cap')!
    expect(r.after).toEqual({ id: made.id, name: 'Neon cap' })
    expect(r.summary).toMatchObject({ id: made.id, name: 'Neon cap', kind: 'wearable' })
  })

  it('list_designs, get_design and get_studio_usage read the routes', async () => {
    const d = await createDesign(owner, { name: 'Neon cap' })
    await addRevision(d, 'hat')
    expect(await runTool(ctx, 'list_designs', {})).toMatchObject({ ok: true, summary: [{ id: d.id, name: 'Neon cap', kind: 'wearable', status: 'idle' }] })
    const g = await runTool(ctx, 'get_design', { designId: d.id })
    expect(g).toMatchObject({ ok: true, summary: { id: d.id, name: 'Neon cap', kind: 'wearable', status: 'idle', activeJob: null } })
    if (!g.ok) throw new Error('failed')
    expect((g.summary as any).revisions).toHaveLength(1)
    expect((g.summary as any).pieces).toMatchObject([{ category: 'hat', revision: { number: 1 } }])
    const u = await runTool(ctx, 'get_studio_usage', {})
    expect(u.ok).toBe(true)
    if (!u.ok) throw new Error('failed')
    expect(Object.keys(u.summary as object).sort()).toEqual(['credits', 'freeFinalizes', 'giftedPrompts', 'promptsLeft', 'resetsAt'])
  })

  it('send_studio_prompt cards name the allowance it uses, in order: daily, gifted, bought', async () => {
    const d = await createDesign(owner, { name: 'Neon cap' })
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ promptsLeft: 5, credits: 2, giftedPrompts: 0 }, 'Uses 1 of your 3 prompts left today.'],
      [{ promptsLeft: 2, credits: 0, giftedPrompts: 0 }, 'Uses 1 of your 2 prompts left today.'],
      [{ promptsLeft: 1, credits: 0, giftedPrompts: 0 }, 'Uses 1 of your 1 prompt left today.'],
      [{ promptsLeft: 1, credits: 0, giftedPrompts: 1 }, 'Uses 1 gifted prompt (1 left).'],
      [{ promptsLeft: 2, credits: 2, giftedPrompts: 0 }, 'Uses 1 bought prompt (2 left).'],
    ]
    for (const [usage, line] of cases) {
      const c = await proposeCard(withUsage(usage), null, 'send_studio_prompt', { designId: d.id, text: 'a neon cap' })
      expect(c, line).toMatchObject({ kind: 'card', detail: `"Neon cap": ${line}` })
      if (!('kind' in c)) throw new Error('no card')
      expect(c.steps[0]).toMatchObject({ label: 'Send "a neon cap"', orgName: null, detail: `"Neon cap": ${line}` })
    }
    // Free even with nothing left
    const free = await proposeCard(withUsage({ promptsLeft: 0 }), null, 'send_studio_prompt', { designId: d.id, fixChecks: true })
    expect(free).toMatchObject({ kind: 'card', detail: `"Neon cap": This one is free: fixing what the checker found doesn't use your prompts.` })
    if (!('kind' in free)) throw new Error('no card')
    expect(free.steps[0].label).toBe('Fix what the checker found')
  })

  it('send_studio_prompt cards show what is sent: the text (whole, under the cost when the label cuts it) and the slots, masked but never shortened', async () => {
    const d = await createDesign(owner, { name: 'Neon cap' })
    const long = `${'a glowing neon cap with rivets '.repeat(140)}for bob@example.com and ${owner.email}`.slice(-3990)
    const c = await proposeCard(withUsage({ promptsLeft: 3 }), null, 'send_studio_prompt', { designId: d.id, text: long, selectedSlots: ['hat', 'eyewear'] })
    if (!('kind' in c)) throw new Error('no card')
    const label = c.steps[0].label
    const masked = long.trim().replace('bob@example.com', '[email]')
    expect(label).toBe(`Send "${long.trim().slice(0, LABEL_TEXT_MAX - 1).trimEnd()}…"`)
    expect(c.detail).toBe(`"Neon cap": Uses 1 of your 3 prompts left today.\nSlots: hat, eyewear\n${masked}`)
    expect(c.detail).toContain(owner.email)
    expect(c.detail).not.toContain('bob@example.com')
    const [row] = await db.select().from(assistantActions)
    expect(row).toMatchObject({ label, detail: c.detail })
    // A short text is all in the label, so the detail doesn't repeat it
    const short = await proposeCard(withUsage({ promptsLeft: 3 }), null, 'send_studio_prompt', { designId: d.id, text: 'mail bob@example.com a hat' })
    expect(short).toMatchObject({ detail: '"Neon cap": Uses 1 of your 3 prompts left today.', steps: [{ label: 'Send "mail [email] a hat"' }] })
  })

  it('send_studio_prompt for a paused account is refused in plain words, with no card, free or not', async () => {
    const d = await createDesign(owner)
    for (const args of [{ designId: d.id, text: 'a hat' }, { designId: d.id, fixChecks: true }]) {
      expect(await proposeCard(withUsage({ promptsLeft: 5, paused: true }), null, 'send_studio_prompt', args)).toEqual({ error: STUDIO_PAUSED })
    }
    expect(await db.select().from(assistantActions)).toHaveLength(0)
  })

  it("passes the Studio routes' refusal codes on in plain words, and leaves other routes' errors as they were", async () => {
    const other = await createUser()
    const theirs = await createDesign(other)
    expect(await runTool(ctx, 'get_design', { designId: theirs.id })).toMatchObject({ ok: false, status: 404, error: STUDIO_REFUSALS.design_not_found })
    const d = await createDesign(owner)
    // Nothing made yet, so nothing failed the checker
    expect(await runTool(ctx, 'send_studio_prompt', { designId: d.id, fixChecks: true })).toMatchObject({ ok: false, status: 409, error: STUDIO_REFUSALS.nothing_to_fix })
    expect(routeError(429, { error: 'cost_ceiling', code: 'cost_ceiling' }, STUDIO_REFUSALS)).toBe("Studio has hit today's limit. Try again after midnight UTC.")
    expect(routeError(404, { error: 'design_not_found' })).toBe('design_not_found')
    expect(routeError(403, { error: 'Your studio access is paused', code: 'studio_paused' }, STUDIO_REFUSALS)).toBe('Your studio access is paused')
  })

  it('send_studio_prompt with no prompts left is blocked, with a link to buy more and no row', async () => {
    const d = await createDesign(owner)
    await db.delete(assistantActions)
    expect(await proposeCard(withUsage({ promptsLeft: 0 }), null, 'send_studio_prompt', { designId: d.id, text: 'a hat' })).toEqual({
      blocked: 'No Studio prompts left. They reset at midnight UTC, or the user can buy more.',
      link: { label: 'Buy Studio prompts', href: '/studio' },
    })
    expect(await db.select().from(assistantActions)).toHaveLength(0)
  })

  it("send_studio_prompt on someone else's design is the route's refusal, with no row", async () => {
    const other = await createUser()
    const d = await createDesign(other)
    const c = await proposeCard(withUsage({ promptsLeft: 5 }), null, 'send_studio_prompt', { designId: d.id, text: 'a hat' })
    expect(c).toEqual({ error: STUDIO_REFUSALS.design_not_found })
    expect(await db.select().from(assistantActions)).toHaveLength(0)
  })

  it('send_studio_prompt takes exactly one of text or fixChecks', async () => {
    const d = await createDesign(owner)
    for (const args of [{ designId: d.id }, { designId: d.id, text: 'a hat', fixChecks: true }, { designId: d.id, fixChecks: false }, { designId: d.id, text: 'x'.repeat(4001) }]) {
      const r = await proposeCard(withUsage({ promptsLeft: 5 }), null, 'send_studio_prompt', args)
      expect(r, JSON.stringify(args).slice(0, 80)).toEqual({ error: expect.stringMatching(/text|fixChecks/) })
    }
    expect(await db.select().from(assistantActions)).toHaveLength(0)
    expect(await proposeCard(withUsage({ promptsLeft: 5 }), null, 'send_studio_prompt', { designId: d.id, text: 'x'.repeat(4000) })).toHaveProperty('kind', 'card')
  })

  it('get_finalize_quote and open_finalize read the quote; open_finalize links to the finalize step', async () => {
    const d = await createDesign(owner, { name: 'Neon cap' })
    await addRevision(d, 'hat')
    const q = await runTool(ctx, 'get_finalize_quote', { designId: d.id })
    expect(q).toMatchObject({ ok: true, summary: { totalCents: expect.any(Number), dueCents: expect.any(Number), giftsUsed: 0 } })
    if (!q.ok) throw new Error('failed')
    expect((q.summary as any).lines).toMatchObject([{ category: 'hat', amountCents: expect.any(Number) }])
    const o = await runTool(ctx, 'open_finalize', { designId: d.id })
    expect(o).toMatchObject({ ok: true, summary: { href: `/studio/${d.id}?step=finalize`, label: 'Finalize "Neon cap"', detail: expect.stringMatching(/^Total \$\d/) } })
    // A design read with no name never shows as "undefined"
    const nameless = await runTool(withUsage({}, { [`/api/studio/designs/${d.id}`]: { design: { id: d.id } } }), 'open_finalize', { designId: d.id })
    expect(nameless).toMatchObject({ ok: true, summary: { label: 'Finalize the design' } })
  })
})

describe('assistant event, raffle and BEAT tools', () => {
  let app: FastifyInstance
  let owner: TestUser
  let ctx: ToolCtx
  let sceneId: string
  let presetId: string
  const prevBeats = config.beats
  const H = 3_600_000
  const later = (ms: number) => new Date(Date.now() + ms).toISOString()

  beforeAll(async () => {
    app = await testApp()
  })
  afterAll(async () => {
    await app.close()
  })
  beforeEach(async () => {
    await resetDb()
    ;(config as any).beats = { ...prevBeats, enabled: true, chain: 'polygon', ...BEATS_READY }
    setImageSizeReader(async () => ({ width: 1024, height: 1024 }))
    owner = await createUser({ wallet: randomWallet() })
    const made = await createScene(owner, 'Old Lounge')
    sceneId = made.scene.id
    presetId = made.preset.id
    ctx = ctxFor(app, owner)
  })
  afterEach(() => {
    ;(config as any).beats = prevBeats
    setImageSizeReader(null)
  })

  const raffleArgs = (over: Record<string, unknown> = {}) => ({ sceneId, name: 'Friday raffle', prize: 'A neon cap', winnersCount: 2, mode: 'one_per_person', ...over })
  async function draftRaffle(over: Record<string, unknown> = {}) {
    const res = await app.inject({ method: 'POST', url: `/api/scenes/${sceneId}/raffles`, headers: { authorization: `Bearer ${tokenFor(owner)}` }, payload: { ...raffleArgs(), acceptHostTerms: true, ...over } })
    expect(res.statusCode, res.body).toBe(201)
    return res.json().raffle as { id: string; name: string; prize: string }
  }
  async function image() {
    const [m] = await db.insert(mediaAssets).values({ ownerId: owner.id, filename: 'beat.png', contentType: 'image/png', sizeBytes: 1, storageKey: 'k', publicUrl: `https://cdn.example/${Math.random().toString(36).slice(2)}.png`, status: 'ready' }).returning()
    return m
  }
  const beatArgs = async (over: Record<string, unknown> = {}) => ({ name: 'Opening night', startsAt: later(2 * H), endsAt: later(4 * H), sceneIds: [sceneId], imageMediaId: (await image()).id, ...over })

  it('create_raffle always sends acceptHostTerms: true, and its card shows the host terms verbatim', async () => {
    const args = raffleArgs({ acceptHostTerms: false, opensAt: '2031-03-04T20:30:00Z' })
    const card = await proposeCard(ctx, null, 'create_raffle', args)
    if (!('kind' in card)) throw new Error(JSON.stringify(card))
    expect(card.detail).toBe(
      `"Old Lounge": Friday raffle, prize "A neon cap", 2 winners, opens 2031-03-04 20:30 UTC\n${RAFFLE_RULES_INCLUDED}\n\n${RAFFLE_HOST_TERMS}\nConfirming accepts these terms for this raffle.`,
    )
    expect(card.detail).toContain(RAFFLE_HOST_TERMS)
    expect(card.steps[0]).toMatchObject({ label: 'Create raffle "Friday raffle"', orgName: null })
    // The model's acceptHostTerms never reaches the route: the tool's own call sets it
    const def = TOOLS.create_raffle
    expect(def.effect).toBe('public')
    const planned = (await def.call(def.input.parse(args), ctx)) as { body: Record<string, unknown> }
    expect(planned.body.acceptHostTerms).toBe(true)
    const r = await runTool(ctx, 'create_raffle', args)
    expect(r, JSON.stringify(r)).toMatchObject({ ok: true, status: 201 })
    const [row] = await db.select().from(raffles)
    expect(row).toMatchObject({ name: 'Friday raffle', prize: 'A neon cap', winnersCount: 2, status: 'draft' })
    expect(row.hostTermsAcceptedAt).toBeInstanceOf(Date)
    expect(row.opensAt!.toISOString()).toBe('2031-03-04T20:30:00.000Z')
    // The official rules: the Raffles tab's template, filled with the prize, winners and the user's name
    expect(row.rules).toBe(fillRules('A neon cap', 2, 'Test User'))
    // One winner, no opening time
    const one = await proposeCard(ctx, null, 'create_raffle', raffleArgs({ winnersCount: 1 }))
    expect(one).toMatchObject({ detail: expect.stringMatching(/^"Old Lounge": Friday raffle, prize "A neon cap", 1 winner\nOfficial rules: included, from Virvi's template\.\n\n/) })
  })

  it("create_raffle's rules name the scene when the user's display name is blank", async () => {
    await db.update(users).set({ displayName: '  ' }).where(eq(users.id, owner.id))
    expect(await runTool(ctx, 'create_raffle', raffleArgs())).toMatchObject({ ok: true })
    expect((await db.select().from(raffles))[0].rules!.split('\n')[0]).toBe('Official rules. Prize: A neon cap. Winners: 2. Host: Old Lounge.')
  })

  describe('raffle cards for a show', () => {
    const prevAssistant = { enabled: config.assistantEnabled, audience: config.assistantAudience, billing: config.billingEnabled }
    beforeEach(() => {
      ;(config as any).assistantEnabled = true; (config as any).assistantAudience = 'paid'; (config as any).billingEnabled = false
    })
    afterEach(() => {
      ;(config as any).assistantEnabled = prevAssistant.enabled; (config as any).assistantAudience = prevAssistant.audience; (config as any).billingEnabled = prevAssistant.billing
    })
    const parisShow = async (raffleId?: string) => {
      const [event] = await db.insert(events).values({ ownerId: owner.id, name: 'Launch', startTime: new Date('2031-03-04T20:00:00Z'), endTime: new Date('2031-03-04T23:00:00Z'), timezone: 'Europe/Paris' }).returning()
      const [show] = await db.insert(assistantShows).values({ userId: owner.id, eventId: event.id, title: 'Launch', items: [{ id: crypto.randomUUID(), kind: 'raffle', label: 'Raffle', ref: raffleId ? { raffleId } : {} }] }).returning()
      return show
    }

    it('create_raffle for a show: the time in the event\'s timezone, and the wearable is the host\'s to send', async () => {
      const show = await parisShow()
      const card = await proposeCard(ctx, null, 'create_raffle', raffleArgs({ opensAt: '2031-03-04T20:30:00Z', showId: show.id }))
      if (!('kind' in card)) throw new Error(JSON.stringify(card))
      expect(card.detail).toBe(
        `"Old Lounge": Friday raffle, prize "A neon cap", 2 winners, opens 2031-03-04 21:30 Europe/Paris\n${RAFFLE_RULES_INCLUDED}\n${RAFFLE_SEND_WEARABLE}\n\n${RAFFLE_HOST_TERMS}\nConfirming accepts these terms for this raffle.`,
      )
      // The show id never reaches the raffle route
      const def = TOOLS.create_raffle
      const planned = (await def.call(def.input.parse(raffleArgs({ showId: show.id })), ctx)) as { body: Record<string, unknown> }
      expect(planned.body).not.toHaveProperty('showId')
    })

    it("create_raffle naming someone else's show is refused, with no card", async () => {
      const other = await createUser()
      const [theirs] = await db.insert(assistantShows).values({ userId: other.id, title: 'Theirs', items: [{ id: crypto.randomUUID(), kind: 'raffle', label: 'Raffle', ref: {} }] }).returning()
      expect(await proposeCard(ctx, null, 'create_raffle', raffleArgs({ showId: theirs.id }))).toEqual({ error: 'Show not found.' })
      expect(await db.select().from(assistantActions)).toHaveLength(0)
    })

    it("schedule_raffle_open for a raffle in a show shows the event's timezone", async () => {
      const r = await draftRaffle()
      await parisShow(r.id)
      expect(await proposeCard(ctx, null, 'schedule_raffle_open', { raffleId: r.id, opensAt: '2031-07-04T20:30:00Z' }))
        .toMatchObject({ detail: 'Open "Friday raffle" (prize "A neon cap") by itself at 2031-07-04 22:30 Europe/Paris' })
    })
  })

  it('card times name UTC, and an unknown zone falls back to UTC', () => {
    expect(cardTime('2031-03-04T20:30:00Z')).toBe('2031-03-04 20:30 UTC')
    expect(cardTime('2031-03-04T20:30:00Z', 'UTC')).toBe('2031-03-04 20:30 UTC')
    expect(cardTime('2031-03-04T23:30:00Z', 'America/New_York')).toBe('2031-03-04 18:30 America/New_York')
    expect(cardTime('2031-03-04T20:30:00Z', 'Not/AZone')).toBe('2031-03-04 20:30 UTC')
  })

  it("create_raffle for someone else's scene is refused, with no card", async () => {
    const other = await createUser()
    const theirs = (await createScene(other, 'Not mine')).scene.id
    const card = await proposeCard(ctx, null, 'create_raffle', raffleArgs({ sceneId: theirs }))
    expect(card).toHaveProperty('error')
    expect(await db.select().from(assistantActions)).toHaveLength(0)
    // A viewer of the scene can read it but not run raffles: refused before a card too
    const { sceneCollaborators } = await import('../src/db/schema.js')
    await db.insert(sceneCollaborators).values({ sceneId: theirs, userId: owner.id, role: 'viewer' })
    expect(await proposeCard(ctx, null, 'create_raffle', raffleArgs({ sceneId: theirs }))).toEqual({ error: "You can't run raffles in this scene." })
    expect(await db.select().from(assistantActions)).toHaveLength(0)
    expect(await db.select().from(raffles)).toHaveLength(0)
  })

  it('list_scene_raffles lists the scene\'s raffles', async () => {
    const r = await draftRaffle()
    expect(await runTool(ctx, 'list_scene_raffles', { sceneId })).toMatchObject({ ok: true, summary: [{ id: r.id, name: 'Friday raffle', prize: 'A neon cap', status: 'draft', opensAt: null }] })
  })

  it('schedule_raffle_open cards say when it opens, or that it stops opening by itself', async () => {
    const r = await draftRaffle()
    const on = await proposeCard(ctx, null, 'schedule_raffle_open', { raffleId: r.id, opensAt: '2031-03-04T20:30:00Z' })
    expect(on).toMatchObject({ kind: 'card', detail: 'Open "Friday raffle" (prize "A neon cap") by itself at 2031-03-04 20:30 UTC' })
    const off = await proposeCard(ctx, null, 'schedule_raffle_open', { raffleId: r.id, opensAt: null })
    expect(off).toMatchObject({ kind: 'card', detail: 'Stop "Friday raffle" (prize "A neon cap") opening by itself' })
    expect(await runTool(ctx, 'schedule_raffle_open', { raffleId: r.id, opensAt: '2031-03-04T20:30:00Z' })).toMatchObject({ ok: true })
    expect((await db.select().from(raffles))[0].opensAt!.toISOString()).toBe('2031-03-04T20:30:00.000Z')
  })

  /** Proposes the card and confirms it, as the user pressing Confirm. */
  async function confirmCard(name: string, args: unknown) {
    const card = await proposeCard(ctx, null, name, args)
    if (!('kind' in card)) throw new Error(JSON.stringify(card))
    const ran = await approvePlan(ctx, card.planId, card.token, () => {})
    expect(ran).toMatchObject({ done: 1, failed: null })
    return { card, actionId: card.steps[0].id }
  }

  it('update_raffle_prize is a card that names the old and new prize, and says when visitors see it', async () => {
    expect(TOOLS.update_raffle_prize.effect).toBe('public')
    const r = await draftRaffle()
    const draft = await proposeCard(ctx, null, 'update_raffle_prize', { raffleId: r.id, prize: 'Two neon caps' })
    expect(draft).toMatchObject({ kind: 'card', detail: '"Friday raffle": prize "A neon cap" becomes "Two neon caps".', steps: [{ label: 'Change the raffle prize to "Two neon caps"' }] })
    await db.update(raffles).set({ status: 'open', openedAt: new Date() }).where(eq(raffles.id, r.id))
    const open = await proposeCard(ctx, null, 'update_raffle_prize', { raffleId: r.id, prize: 'Two neon caps' })
    expect(open).toMatchObject({ detail: '"Friday raffle": prize "A neon cap" becomes "Two neon caps". Visitors in the scene see the new prize straight away.' })
    expect((await db.select().from(raffles))[0].prize).toBe('A neon cap')
  })

  it('update_raffle_prize keeps template rules in step with the prize, and leaves rules the user wrote alone', async () => {
    const templated = await draftRaffle({ rules: fillRules('A neon cap', 2, 'Test User') })
    const { card } = await confirmCard('update_raffle_prize', { raffleId: templated.id, prize: 'Two neon caps' })
    expect(card.detail).toContain('The official rules name the new prize.')
    expect((await db.select().from(raffles).where(eq(raffles.id, templated.id)))[0]).toMatchObject({ prize: 'Two neon caps', rules: fillRules('Two neon caps', 2, 'Test User') })

    const own = await draftRaffle({ rules: 'My own rules.' })
    const { card: c2 } = await confirmCard('update_raffle_prize', { raffleId: own.id, prize: 'Two neon caps' })
    expect(c2.detail).not.toContain('official rules')
    expect((await db.select().from(raffles).where(eq(raffles.id, own.id)))[0]).toMatchObject({ prize: 'Two neon caps', rules: 'My own rules.' })
  })

  it("update_raffle_prize's undo restores the prize and rules, and refuses once the prize was edited by hand", async () => {
    const r = await draftRaffle({ rules: fillRules('A neon cap', 2, 'Test User') })
    const a = await confirmCard('update_raffle_prize', { raffleId: r.id, prize: 'Two neon caps' })
    expect((await db.select().from(raffles))[0].prize).toBe('Two neon caps')
    expect(await undoAction(ctx, a.actionId)).toMatchObject({ status: 'undone' })
    expect((await db.select().from(raffles))[0]).toMatchObject({ prize: 'A neon cap', rules: fillRules('A neon cap', 2, 'Test User') })

    const b = await confirmCard('update_raffle_prize', { raffleId: r.id, prize: 'Three caps' })
    await db.update(raffles).set({ prize: 'A hand-picked prize' }).where(eq(raffles.id, r.id))
    expect(await undoAction(ctx, b.actionId)).toEqual({ error: 'changed' })
    expect((await db.select().from(raffles))[0].prize).toBe('A hand-picked prize')
  })

  describe('scene collaborators', () => {
    const short = (w: string) => `${w.slice(0, 6)}…${w.slice(-4)}`
    const withRefs = (...w: string[]) => ({ ...ctx, walletRefs: w })
    const rolesOf = async () => (await db.select().from(sceneRoles)).filter((r) => !r.revokedAt).map((r) => ({ wallet: r.walletAddress, role: r.role }))
    const give = (wallet: string, role: 'viewer' | 'editor' | 'cohost', userId: string | null = null) =>
      db.insert(sceneRoles).values({ sceneId, walletAddress: wallet, role, userId, grantedByUserId: owner.id })

    it('list_scene_collaborators lists roles with masked wallets', async () => {
      const w = randomWallet()
      const friend = await createUser({ name: 'Friend', wallet: w })
      await give(w, 'editor', friend.id)
      const other = randomWallet()
      await give(other, 'viewer')
      const r = await runTool(ctx, 'list_scene_collaborators', { sceneId })
      expect(r).toMatchObject({ ok: true })
      if (!r.ok) throw new Error('failed')
      const s = r.summary as any
      expect(s.host).toEqual({ displayName: 'Test User' })
      expect(s.roles).toEqual([
        { wallet: short(w), role: 'editor', displayName: 'Friend', signedIn: true },
        { wallet: short(other), role: 'viewer', displayName: null, signedIn: false },
      ])
      expect(JSON.stringify(s)).not.toContain(w)
    })

    it('add_scene_collaborator changes the role of someone on the scene by their short wallet, without a paste', async () => {
      const w = randomWallet()
      await give(w, 'viewer')
      const card = await proposeCard(ctx, null, 'add_scene_collaborator', { sceneId, wallet: short(w), role: 'editor' })
      if (!('kind' in card)) throw new Error(JSON.stringify(card))
      expect(card.detail).toBe(`${short(w)} is a viewer on "Old Lounge". They become editor: they can change the scene.`)
      expect(card.steps[0].label).toBe('Make a collaborator an editor')
      expect(await approvePlan(ctx, card.planId, card.token, () => {})).toMatchObject({ done: 1, failed: null })
      expect(await rolesOf()).toEqual([{ wallet: w, role: 'editor' }])
      expect(await undoAction(ctx, card.steps[0].id)).toMatchObject({ status: 'undone' })
      expect(await rolesOf()).toEqual([{ wallet: w, role: 'viewer' }])
    })

    it('a role-change card keeps to its person: a different wallet with the same short form is refused at the press', async () => {
      const a = '0x5678' + '0'.repeat(32) + 'beef'
      const b = '0x5678' + '2'.repeat(32) + 'beef'
      await give(a, 'viewer')
      const card = await proposeCard(ctx, null, 'add_scene_collaborator', { sceneId, wallet: '0x5678...beef', role: 'cohost' })
      if (!('kind' in card)) throw new Error(JSON.stringify(card))
      await db.update(sceneRoles).set({ revokedAt: new Date() }).where(eq(sceneRoles.walletAddress, a))
      await give(b, 'viewer')
      expect(await approvePlan(ctx, card.planId, card.token, () => {})).toMatchObject({ done: 0 })
      const [row] = await db.select().from(assistantActions)
      expect(row.error).toBe('The collaborators changed since the card. Ask again.')
      expect(await rolesOf()).toEqual([{ wallet: b, role: 'viewer' }])
    })

    it("a short wallet never adds someone who isn't on the scene, and two matches are refused", async () => {
      const w = randomWallet()
      expect(await proposeCard(ctx, null, 'add_scene_collaborator', { sceneId, wallet: short(w), role: 'editor' })).toEqual({ error: "That wallet doesn't have a role on this scene now. Ask the user to paste it." })
      const a = '0x1234' + '0'.repeat(32) + 'abcd'
      const b = '0x1234' + '1'.repeat(32) + 'abcd'
      await give(a, 'viewer')
      await give(b, 'viewer')
      expect(await proposeCard(ctx, null, 'add_scene_collaborator', { sceneId, wallet: '0x1234…abcd', role: 'editor' })).toEqual({ error: 'More than one collaborator has that short wallet. Ask the user to paste the wallet.' })
      expect(await rolesOf()).toEqual([{ wallet: a, role: 'viewer' }, { wallet: b, role: 'viewer' }])
    })

    it('add_scene_collaborator card names the short wallet, the role and what it can do', async () => {
      expect(TOOLS.add_scene_collaborator.effect).toBe('public')
      const w = randomWallet()
      const c = withRefs(w)
      const card = await proposeCard(c, null, 'add_scene_collaborator', { sceneId, wallet: '[wallet 1]', role: 'editor' })
      expect(card).toMatchObject({ kind: 'card', detail: `Add ${short(w)} to "Old Lounge" as editor: they can change the scene.`, steps: [{ label: 'Make a collaborator an editor' }] })
      const cohost = await proposeCard(c, null, 'add_scene_collaborator', { sceneId, wallet: '[wallet 1]', role: 'cohost' })
      expect(cohost).toMatchObject({ detail: expect.stringContaining('they can run the scene with you, including deploying it and changing its roles.') })
      const viewer = await proposeCard(c, null, 'add_scene_collaborator', { sceneId, wallet: '[wallet 1]', role: 'viewer' })
      expect(viewer).toMatchObject({ detail: expect.stringContaining("they can see the scene's analytics.") })
      expect(await rolesOf()).toEqual([])
    })

    it('add_scene_collaborator on an existing collaborator is a role change, undone to the old role', async () => {
      const w = randomWallet()
      await give(w, 'viewer')
      const c = withRefs(w)
      const card = await proposeCard(c, null, 'add_scene_collaborator', { sceneId, wallet: '[wallet 1]', role: 'editor' })
      if (!('kind' in card)) throw new Error(JSON.stringify(card))
      expect(card.detail).toBe(`${short(w)} is a viewer on "Old Lounge". They become editor: they can change the scene.`)
      expect(await approvePlan(c, card.planId, card.token, () => {})).toMatchObject({ done: 1, failed: null })
      expect(await rolesOf()).toEqual([{ wallet: w, role: 'editor' }])
      expect(await undoAction(c, card.steps[0].id)).toMatchObject({ status: 'undone' })
      expect(await rolesOf()).toEqual([{ wallet: w, role: 'viewer' }])
    })

    it('add_scene_collaborator undo of a role change refuses once the role was changed since', async () => {
      const w = randomWallet()
      await give(w, 'viewer')
      const c = withRefs(w)
      const card = await proposeCard(c, null, 'add_scene_collaborator', { sceneId, wallet: '[wallet 1]', role: 'editor' })
      if (!('kind' in card)) throw new Error(JSON.stringify(card))
      await approvePlan(c, card.planId, card.token, () => {})
      await db.update(sceneRoles).set({ role: 'cohost' }).where(eq(sceneRoles.walletAddress, w))
      expect(await undoAction(c, card.steps[0].id)).toEqual({ error: 'changed' })
      expect(await rolesOf()).toEqual([{ wallet: w, role: 'cohost' }])
    })

    it('add_scene_collaborator undo of a new collaborator refuses once they were revoked since', async () => {
      const w = randomWallet()
      const c = withRefs(w)
      const card = await proposeCard(c, null, 'add_scene_collaborator', { sceneId, wallet: '[wallet 1]', role: 'viewer' })
      if (!('kind' in card)) throw new Error(JSON.stringify(card))
      await approvePlan(c, card.planId, card.token, () => {})
      await db.update(sceneRoles).set({ revokedAt: new Date() }).where(eq(sceneRoles.walletAddress, w))
      expect(await undoAction(c, card.steps[0].id)).toEqual({ error: 'changed' })
      expect(await rolesOf()).toEqual([])
    })

    it('add_scene_collaborator for a new collaborator is undone by removing them', async () => {
      const w = randomWallet()
      const c = withRefs(w)
      const card = await proposeCard(c, null, 'add_scene_collaborator', { sceneId, wallet: '[wallet 1]', role: 'viewer' })
      if (!('kind' in card)) throw new Error(JSON.stringify(card))
      expect(await approvePlan(c, card.planId, card.token, () => {})).toMatchObject({ done: 1, failed: null })
      expect(await rolesOf()).toEqual([{ wallet: w, role: 'viewer' }])
      expect(await undoAction(c, card.steps[0].id)).toMatchObject({ status: 'undone' })
      expect(await rolesOf()).toEqual([])
    })

    it("add_scene_collaborator refuses an unknown reference and the host's wallet, with no card", async () => {
      const hostWallet = randomWallet()
      await db.insert(userAuthMethods).values({ userId: owner.id, type: 'wallet', identifier: hostWallet, metadata: { verified: true } })
      const c = withRefs(hostWallet)
      expect(await proposeCard(c, null, 'add_scene_collaborator', { sceneId, wallet: '[wallet 9]', role: 'editor' })).toEqual({ error: "I don't have that wallet. Ask the user to paste it again." })
      expect(await proposeCard(c, null, 'add_scene_collaborator', { sceneId, wallet: '[wallet 1]', role: 'editor' })).toEqual({ error: "That wallet is the scene's host." })
      expect(await rolesOf()).toEqual([])
    })
  })

  it('create_event names the organization, and its undo deletes only an event nobody changed', async () => {
    const [org] = await db.insert(organizations).values({ name: 'Acme', slug: `acme-${owner.id.slice(0, 8)}`, billingOwnerId: owner.id }).returning()
    await db.insert(orgMembers).values({ orgId: org.id, userId: owner.id, role: 'owner' })
    const request = { headers: { authorization: `Bearer ${tokenFor(owner, { orgId: org.id })}` }, ip: IP } as unknown as FastifyRequest
    const orgCtx: ToolCtx = { ...ctx, request, user: { ...ctx.user, orgId: org.id } }
    const args = { name: 'Launch party', startTime: '2031-01-01T20:00:00Z', endTime: '2031-01-01T22:00:00Z', timezone: 'Europe/London' }
    const a = await recordDirect(orgCtx, null, 'create_event', args)
    expect(a).toMatchObject({ status: 'done', canUndo: true, label: 'Create event "Launch party"', orgName: 'Acme' })
    const [made] = await db.select().from(events)
    expect(made).toMatchObject({ ownerId: owner.id, orgId: org.id, name: 'Launch party', timezone: 'Europe/London' })
    expect(await undoAction(orgCtx, a.id)).toMatchObject({ status: 'undone' })
    expect(await db.select().from(events)).toHaveLength(0)

    const b = await recordDirect(ctx, null, 'create_event', args)
    const [again] = await db.select().from(events)
    await db.update(events).set({ name: 'Renamed by hand' }).where(eq(events.id, again.id))
    expect(await undoAction(ctx, b.id)).toEqual({ error: 'changed' })
    expect(await db.select().from(events)).toHaveLength(1)
  })

  /** A preset schedule of the owner's scene that follows `eventId`, made by hand. */
  const followingSchedule = async (eventId: string) =>
    (await db.insert(scenePresetSchedules).values({ sceneId, presetId, eventId, recurrence: 'once', startDate: '2031-01-01', startTime: '20:00', timezone: 'UTC' }).returning())[0]

  it("create_event's undo refuses once something was attached to the event by hand, and keeps the event", async () => {
    const args = { name: 'Launch party', startTime: '2031-01-01T20:00:00Z', endTime: '2031-01-01T22:00:00Z' }
    // A scene linked by hand: deleting the event would drop the link
    const a = await recordDirect(ctx, null, 'create_event', args)
    const [e1] = await db.select().from(events)
    await db.insert(eventSceneLinks).values({ eventId: e1.id, sceneId })
    expect(await undoAction(ctx, a.id)).toEqual({ error: 'changed' })
    expect(await db.select().from(events).where(eq(events.id, e1.id))).toHaveLength(1)
    // A schedule that follows the event, added by hand
    const b = await recordDirect(ctx, null, 'create_event', args)
    const e2 = (await db.select().from(events)).find((e) => e.id !== e1.id)!
    await db.insert(eventSceneLinks).values({ eventId: e2.id, sceneId })
    await db.delete(eventSceneLinks).where(eq(eventSceneLinks.eventId, e2.id))
    await followingSchedule(e2.id)
    expect(await undoAction(ctx, b.id)).toEqual({ error: 'changed' })
    expect(await db.select().from(events).where(eq(events.id, e2.id))).toHaveLength(1)
    // Its description or timezone changed by hand
    const c = await recordDirect(ctx, null, 'create_event', args)
    const e3 = (await db.select().from(events)).find((e) => e.id !== e1.id && e.id !== e2.id)!
    await db.update(events).set({ timezone: 'Europe/Paris' }).where(eq(events.id, e3.id))
    expect(await undoAction(ctx, c.id)).toEqual({ error: 'changed' })
    expect(await db.select().from(events)).toHaveLength(3)
  })

  it("link_event_scene's undo refuses once a schedule or showing follows the event in that scene", async () => {
    const [e] = await db.insert(events).values({ ownerId: owner.id, name: 'Launch' }).returning()
    const a = await recordDirect(ctx, null, 'link_event_scene', { eventId: e.id, sceneId })
    const s = await followingSchedule(e.id)
    expect(await undoAction(ctx, a.id)).toEqual({ error: 'changed' })
    expect(await db.select().from(eventSceneLinks)).toHaveLength(1)
    expect(await db.select().from(scenePresetSchedules).where(eq(scenePresetSchedules.id, s.id))).toHaveLength(1)
    // A showing that follows it
    await db.delete(scenePresetSchedules)
    await db.delete(eventSceneLinks)
    const b = await recordDirect(ctx, null, 'link_event_scene', { eventId: e.id, sceneId })
    const el = await createElement(presetId)
    await db.insert(screenShowings).values({ sceneId, elementId: el.id, eventId: e.id, title: 'Matinee', items: [{ url: 'https://cdn.example/m.mp4', duration: 60, kind: 'video' }], recurrence: 'once', startDate: '2031-01-01', startTime: '20:00', timezone: 'UTC' })
    expect(await undoAction(ctx, b.id)).toEqual({ error: 'changed' })
    expect((await db.select().from(screenShowings))[0]).toMatchObject({ eventId: e.id })
  })

  it('update_event refuses an end before the start, against the event as it is', async () => {
    const [e] = await db.insert(events).values({ ownerId: owner.id, name: 'Launch', startTime: new Date('2031-01-01T20:00:00Z'), endTime: new Date('2031-01-01T22:00:00Z') }).returning()
    expect(await runTool(ctx, 'update_event', { eventId: e.id, endTime: '2031-01-01T19:00:00Z' })).toMatchObject({ ok: false, status: 400, error: 'The event must end after it starts.' })
    expect(await runTool(ctx, 'update_event', { eventId: e.id, startTime: '2031-01-01T23:00:00Z' })).toMatchObject({ ok: false, status: 400, error: 'The event must end after it starts.' })
    expect((await db.select().from(events))[0].endTime!.toISOString()).toBe('2031-01-01T22:00:00.000Z')
    expect(await runTool(ctx, 'update_event', { eventId: e.id, startTime: '2031-01-01T21:00:00Z' })).toMatchObject({ ok: true })
  })

  it('update_event changes only the fields given, and its undo puts them back', async () => {
    const [e] = await db.insert(events).values({ ownerId: owner.id, name: 'Launch', description: 'Old words', startTime: new Date('2031-01-01T20:00:00Z'), endTime: new Date('2031-01-01T22:00:00Z') }).returning()
    const a = await recordDirect(ctx, null, 'update_event', { eventId: e.id, name: 'Launch party', endTime: '2031-01-01T23:00:00Z' })
    expect(a).toMatchObject({ status: 'done', canUndo: true })
    const now = (await db.select().from(events))[0]
    expect(now).toMatchObject({ name: 'Launch party', description: 'Old words' })
    expect(now.endTime!.toISOString()).toBe('2031-01-01T23:00:00.000Z')
    expect(await undoAction(ctx, a.id)).toMatchObject({ status: 'undone' })
    const back = (await db.select().from(events))[0]
    expect(back.name).toBe('Launch')
    expect(back.endTime!.toISOString()).toBe('2031-01-01T22:00:00.000Z')
  })

  it('link_event_scene links the scene, and its undo unlinks it; a scene already linked has nothing to undo', async () => {
    const [e] = await db.insert(events).values({ ownerId: owner.id, name: 'Launch' }).returning()
    const a = await recordDirect(ctx, null, 'link_event_scene', { eventId: e.id, sceneId })
    expect(a).toMatchObject({ status: 'done', canUndo: true })
    expect(await db.select().from(eventSceneLinks)).toMatchObject([{ eventId: e.id, sceneId }])
    expect(await undoAction(ctx, a.id)).toMatchObject({ status: 'undone' })
    expect(await db.select().from(eventSceneLinks)).toHaveLength(0)
    await db.insert(eventSceneLinks).values({ eventId: e.id, sceneId })
    expect(await runTool(ctx, 'link_event_scene', { eventId: e.id, sceneId })).toMatchObject({ ok: true, undo: null })
  })

  it('create_beat_draft creates a draft, with no undo; get_beat reads it', async () => {
    const r = await runTool(ctx, 'create_beat_draft', await beatArgs({ supplyCap: 50, tradeable: true }))
    expect(r, JSON.stringify(r)).toMatchObject({ ok: true, status: 201, undo: null, label: 'Create a BEAT draft "Opening night"', summary: { status: 'draft', name: 'Opening night', supplyCap: 50 } })
    const [row] = await db.select().from(beats)
    expect(row).toMatchObject({ status: 'draft', ownerUserId: owner.id, supplyCap: 50, tradeable: true, locationType: 'scene' })
    const g = await runTool(ctx, 'get_beat', { beatId: row.id })
    expect(g).toMatchObject({ ok: true, summary: { id: row.id, name: 'Opening night', status: 'draft', supplyCap: 50, sceneIds: [sceneId] } })
    if (!g.ok) throw new Error('failed')
    expect(Object.keys(g.summary as object).sort()).toEqual(['endsAt', 'id', 'name', 'sceneIds', 'startsAt', 'status', 'supplyCap'])
  })

  it("open_beat_pay links a draft to its page with the server's total, and refuses a paid BEAT", async () => {
    const made = await runTool(ctx, 'create_beat_draft', await beatArgs())
    if (!made.ok) throw new Error(made.error)
    const beatId = (made.summary as { id: string }).id
    const quote = await app.inject({ method: 'GET', url: `/api/beats/${beatId}/quote?method=credit`, headers: { authorization: `Bearer ${tokenFor(owner)}` } })
    const cents = quote.json().cents as number
    const o = await runTool(ctx, 'open_beat_pay', { beatId })
    expect(o).toMatchObject({ ok: true, summary: { href: `/beats/${beatId}`, label: 'Pay for "Opening night"', detail: `Total $${(cents / 100).toFixed(2)}` } })
    await db.update(beats).set({ status: 'paid' }).where(eq(beats.id, beatId))
    expect(await runTool(ctx, 'open_beat_pay', { beatId })).toMatchObject({ ok: false, error: 'This BEAT is already paid for.' })
    await db.update(beats).set({ status: 'live' }).where(eq(beats.id, beatId))
    expect(await runTool(ctx, 'open_beat_pay', { beatId })).toMatchObject({ ok: false, error: 'This BEAT is already paid for.' })
    await db.update(beats).set({ status: 'ended' }).where(eq(beats.id, beatId))
    expect(await runTool(ctx, 'open_beat_pay', { beatId })).toMatchObject({ ok: false, error: 'This BEAT is over.' })
    await db.update(beats).set({ status: 'cancelled' }).where(eq(beats.id, beatId))
    expect(await runTool(ctx, 'open_beat_pay', { beatId })).toMatchObject({ ok: false, error: 'This BEAT is cancelled.' })
  })

  it('nextStep gives the next thing to try for each way a deploy ends', () => {
    expect(nextStep({ status: 'deployed', errorMessage: null }, null)).toBe("It's live. Nothing to do.")
    expect(nextStep({ status: 'awaiting_signature', errorMessage: null }, null)).toBe('It is waiting for your signature on its deploy page.')
    expect(nextStep({ status: 'building', errorMessage: null }, null)).toBe('It is still running. Check again in a minute.')
    expect(nextStep({ status: 'failed', errorMessage: 'Cancelled by user' }, null)).toBe('It was cancelled. Redeploy when you are ready.')
    expect(nextStep({ status: 'failed', errorMessage: 'x' }, { status: 'over_budget', statusDetail: 'Too many triangles' }))
      .toBe('The scene is over the size limit: Too many triangles. Remove or shrink models, then redeploy.')
    expect(nextStep({ status: 'failed', errorMessage: 'x' }, { status: 'needs_review', statusDetail: 'Two models failed' }))
      .toBe('Two models failed. Check the models on the deploy page, then redeploy.')
    expect(nextStep({ status: 'failed', errorMessage: "Couldn't reach Decentraland's servers. Try again in a minute." }, { status: 'ok', statusDetail: null }))
      .toBe("Decentraland couldn't be reached. Redeploy in a few minutes.")
    expect(nextStep({ status: 'failed', errorMessage: 'Decentraland rejected the deploy: bad parcels' }, { status: 'ok', statusDetail: null }))
      .toBe('Decentraland refused it. Open the deploy page to check the destination, then redeploy.')
    expect(nextStep({ status: 'failed', errorMessage: 'Something went wrong on our side while deploying. Try again in a few minutes.' }, null))
      .toBe('Redeploy in a few minutes. If it fails again, ask for help with the Help button.')
    expect(nextStep({ status: 'failed', errorMessage: 'x' }, { status: 'unreachable', statusDetail: null }))
      .toBe("Decentraland couldn't be reached. Redeploy in a few minutes.")
  })

  it('destinationName names a World or the parcels', () => {
    expect(destinationName({ kind: 'world', worldName: 'sun.dcl.eth', base: '0,0', parcels: ['0,0'] })).toBe('World "sun.dcl.eth"')
    expect(destinationName({ kind: 'parcels', worldName: null, base: '4,5', parcels: ['4,5'] })).toBe('Genesis City parcels at 4,5 (1 parcel)')
    expect(destinationName({ kind: 'parcels', worldName: null, base: '4,5', parcels: ['4,5', '4,6'] })).toBe('Genesis City parcels at 4,5 (2 parcels)')
  })

  describe('redeploy_scene', () => {
    const WALLET = '0x' + 'ab'.repeat(20)
    let worlds: FakeWorldsClient
    beforeEach(async () => {
      worlds = new FakeWorldsClient()
      setWorldsClient(worlds)
      deployer.start = async (destinationId) => {
        const [row] = await db.insert(sceneDeployments).values({ sceneId, platform: 'decentraland', status: 'building', deploymentType: 'world', target: {}, destinationId }).returning()
        return row
      }
      // The owner's verified wallet, so the deploy route's own owner check passes
      await db.insert(userAuthMethods).values({ userId: owner.id, type: 'wallet', identifier: WALLET, metadata: { verified: true } })
    })
    afterEach(() => setWorldsClient(null))

    const dest = async (o: Partial<typeof dclWorldDestinations.$inferInsert>) => {
      const [d] = await db.insert(dclWorldDestinations).values({ sceneId, ownerUserId: owner.id, ownerWallet: WALLET, worldName: null, base: '0,0', parcels: ['0,0'], mode: 'virvi', grantedAt: new Date(), ...o }).returning()
      if (d.worldName) worlds.deployers.set(d.worldName, { owner: WALLET, deployers: [] })
      return d
    }

    it('is a public card naming each destination and how it deploys', async () => {
      expect(TOOLS.redeploy_scene.effect).toBe('public')
      const w = await dest({ worldName: 'sun.dcl.eth' })
      const p = await dest({ kind: 'parcels', mode: 'sign', grantedAt: null })
      const card = await proposeCard(ctx, null, 'redeploy_scene', { sceneId, destinationIds: [w.id, p.id] })
      expect(card).toMatchObject({
        kind: 'card',
        detail: 'Redeploy "Old Lounge":\n- World "sun.dcl.eth": Virvi deploys it now\n- Genesis City parcels at 0,0 (1 parcel): you sign it on its deploy page',
        steps: [{ label: 'Redeploy the scene to 2 destinations' }],
      })
      const one = await proposeCard(ctx, null, 'redeploy_scene', { sceneId, destinationIds: [w.id] })
      expect(one).toMatchObject({ steps: [{ label: 'Redeploy the scene to 1 destination' }] })
    })

    it('deploys only the destinations the card named', async () => {
      const w = await dest({ worldName: 'sun.dcl.eth' })
      await dest({ worldName: 'moon.dcl.eth', base: '5,5', parcels: ['5,5'] })
      await confirmCard('redeploy_scene', { sceneId, destinationIds: [w.id] })
      const rows = await db.select().from(sceneDeployments)
      expect(rows.map((r) => r.destinationId)).toEqual([w.id])
    })

    it("reports each destination, and one failing doesn't stop the rest", async () => {
      const w1 = await dest({ worldName: 'sun.dcl.eth' })
      const w2 = await dest({ worldName: 'moon.dcl.eth', base: '5,5', parcels: ['5,5'] })
      const card = await proposeCard(ctx, null, 'redeploy_scene', { sceneId, destinationIds: [w1.id, w2.id] })
      if (!('kind' in card)) throw new Error(JSON.stringify(card))
      const start = deployer.start!
      deployer.start = async (id) => {
        if (id === w1.id) throw new DeployerError(409, 'deploy_in_progress', 'A deploy is already running.')
        return start(id)
      }
      expect(await approvePlan(ctx, card.planId, card.token, () => {})).toMatchObject({ done: 1, failed: null })
      const [row] = await db.select().from(assistantActions)
      const [dep] = await db.select().from(sceneDeployments)
      expect(row.status).toBe('done')
      expect(JSON.parse(row.resultSummary!)).toEqual({
        deployed: [{ destinationId: w2.id, name: 'World "moon.dcl.eth"', deploymentId: dep.id }],
        failed: [{ destinationId: w1.id, name: 'World "sun.dcl.eth"', error: 'A deploy is already running.' }],
        toSign: [],
      })
    })

    it('reports a named destination switched to signing since the card', async () => {
      const w1 = await dest({ worldName: 'sun.dcl.eth' })
      const w2 = await dest({ worldName: 'moon.dcl.eth', base: '5,5', parcels: ['5,5'] })
      const card = await proposeCard(ctx, null, 'redeploy_scene', { sceneId, destinationIds: [w1.id, w2.id] })
      if (!('kind' in card)) throw new Error(JSON.stringify(card))
      await db.update(dclWorldDestinations).set({ mode: 'sign' }).where(eq(dclWorldDestinations.id, w2.id))
      expect(await approvePlan(ctx, card.planId, card.token, () => {})).toMatchObject({ done: 1 })
      const [row] = await db.select().from(assistantActions)
      expect(JSON.parse(row.resultSummary!)).toMatchObject({ failed: [], toSign: [{ destinationId: w2.id, name: 'World "moon.dcl.eth"' }] })
      expect((await db.select().from(sceneDeployments)).map((r) => r.destinationId)).toEqual([w1.id])
    })

    it('leaves a destination switched to Virvi since the card to its deploy page, as the card said', async () => {
      const w = await dest({ worldName: 'sun.dcl.eth' })
      const p = await dest({ worldName: 'moon.dcl.eth', base: '5,5', parcels: ['5,5'], mode: 'sign' })
      const card = await proposeCard(ctx, null, 'redeploy_scene', { sceneId, destinationIds: [w.id, p.id], deployIds: [w.id, p.id] })
      if (!('kind' in card)) throw new Error(JSON.stringify(card))
      // The card decides what Virvi deploys, whatever the model passed
      const [stored] = await db.select().from(assistantActions)
      expect((stored.args as any).deployIds).toEqual([w.id])
      await db.update(dclWorldDestinations).set({ mode: 'virvi', grantedAt: new Date() }).where(eq(dclWorldDestinations.id, p.id))
      expect(await approvePlan(ctx, card.planId, card.token, () => {})).toMatchObject({ done: 1, failed: null })
      const [row] = await db.select().from(assistantActions)
      expect(JSON.parse(row.resultSummary!)).toMatchObject({ toSign: [{ destinationId: p.id, name: 'World "moon.dcl.eth"' }] })
      expect((await db.select().from(sceneDeployments)).map((r) => r.destinationId)).toEqual([w.id])
    })

    it('when every deploy fails, names each destination with its own reason', async () => {
      const w1 = await dest({ worldName: 'sun.dcl.eth' })
      const w2 = await dest({ worldName: 'moon.dcl.eth', base: '5,5', parcels: ['5,5'] })
      const p = await dest({ kind: 'parcels', base: '9,9', parcels: ['9,9'], mode: 'sign', grantedAt: null })
      const card = await proposeCard(ctx, null, 'redeploy_scene', { sceneId, destinationIds: [w1.id, w2.id, p.id] })
      if (!('kind' in card)) throw new Error(JSON.stringify(card))
      deployer.start = async (id) => {
        if (id === w1.id) throw new DeployerError(409, 'deploy_in_progress', 'A deploy is already running.')
        throw new DeployerError(502, 'catalyst_unreachable', 'unreachable')
      }
      await approvePlan(ctx, card.planId, card.token, () => {})
      const [row] = await db.select().from(assistantActions)
      expect(row.status).toBe('failed')
      expect(row.error).toBe(
        'World "sun.dcl.eth": A deploy is already running.\nWorld "moon.dcl.eth": Decentraland couldn\'t be reached. Try again in a few minutes.\nStill to sign on their deploy pages: Genesis City parcels at 9,9 (1 parcel).',
      )
    })

    it('a destination removed since the card is reported and the rest still deploy', async () => {
      const w1 = await dest({ worldName: 'sun.dcl.eth' })
      const w2 = await dest({ worldName: 'moon.dcl.eth', base: '5,5', parcels: ['5,5'] })
      const card = await proposeCard(ctx, null, 'redeploy_scene', { sceneId, destinationIds: [w1.id, w2.id] })
      if (!('kind' in card)) throw new Error(JSON.stringify(card))
      await db.delete(dclWorldDestinations).where(eq(dclWorldDestinations.id, w1.id))
      expect(await approvePlan(ctx, card.planId, card.token, () => {})).toMatchObject({ done: 1, failed: null })
      const [row] = await db.select().from(assistantActions)
      const [dep] = await db.select().from(sceneDeployments)
      expect(dep.destinationId).toBe(w2.id)
      expect(JSON.parse(row.resultSummary!)).toMatchObject({
        deployed: [{ destinationId: w2.id, deploymentId: dep.id }],
        failed: [{ destinationId: w1.id, error: "That destination wasn't found." }],
        toSign: [],
      })
    })

    it('fails only when every deploy failed', async () => {
      const w1 = await dest({ worldName: 'sun.dcl.eth' })
      deployer.start = async () => {
        throw new DeployerError(409, 'deploy_in_progress', 'A deploy is already running.')
      }
      expect(await runTool(ctx, 'redeploy_scene', { sceneId, destinationIds: [w1.id] })).toMatchObject({ ok: false, status: 409, error: 'World "sun.dcl.eth": A deploy is already running.' })
    })

    it('with only signing destinations offers no card', async () => {
      const p = await dest({ kind: 'parcels', mode: 'sign', grantedAt: null })
      expect(await proposeCard(ctx, null, 'redeploy_scene', { sceneId, destinationIds: [p.id] })).toEqual({ error: 'Each of these destinations needs your signature: open their deploy pages to redeploy.' })
    })

    it("refuses a destination that isn't the scene's", async () => {
      const other = (await createScene(owner, 'Other')).scene
      const [d] = await db.insert(dclWorldDestinations).values({ sceneId: other.id, ownerUserId: owner.id, ownerWallet: WALLET, worldName: 'other.dcl.eth', base: '9,9', parcels: ['9,9'], mode: 'virvi' }).returning()
      expect(await proposeCard(ctx, null, 'redeploy_scene', { sceneId, destinationIds: [d.id] })).toEqual({ error: "That destination isn't one of this scene's." })
    })
  })

  async function seedDeploys() {
    const [dest] = await db.insert(dclWorldDestinations).values({ sceneId, ownerUserId: owner.id, ownerWallet: owner.wallet ?? '0xabc', worldName: 'sun.dcl.eth', base: '0,0', parcels: ['0,0'], mode: 'virvi', status: 'over_budget', statusDetail: 'Too many triangles' }).returning()
    const target = { parcels: ['0,0'], contentServer: 'https://x', adminCode: 'secret-code' }
    const [failed] = await db.insert(sceneDeployments).values({ sceneId, platform: 'decentraland', status: 'failed', deploymentType: 'world', target, errorMessage: 'Decentraland rejected the deploy: too big', destinationId: dest.id, createdAt: new Date(Date.now() - 120_000) }).returning()
    const [ok] = await db.insert(sceneDeployments).values({ sceneId, platform: 'decentraland', status: 'deployed', deploymentType: 'world', target, destinationId: dest.id, deployedAt: new Date(), createdAt: new Date(Date.now() - 60_000) }).returning()
    return { dest, failed, ok }
  }

  it("get_deploy_status returns the deployment's status, message, destination name and next step", async () => {
    const { failed } = await seedDeploys()
    const r = await runTool(ctx, 'get_deploy_status', { deploymentId: failed.id })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const s = r.summary as Record<string, unknown>
    expect(Object.keys(s).sort()).toEqual(['createdAt', 'deployedAt', 'destination', 'errorMessage', 'id', 'next', 'platform', 'status'].sort())
    expect(s).toMatchObject({ status: 'failed', destination: 'World "sun.dcl.eth"', errorMessage: 'Decentraland rejected the deploy: too big', next: 'The scene is over the size limit: Too many triangles. Remove or shrink models, then redeploy.' })
    expect(JSON.stringify(s)).not.toContain('secret-code')
  })

  it('get_deploy_status for a healthy destination has exactly the brief keys', async () => {
    const { ok, dest } = await seedDeploys()
    await db.update(dclWorldDestinations).set({ status: 'ok', statusDetail: null }).where(eq(dclWorldDestinations.id, dest.id))
    const r = await runTool(ctx, 'get_deploy_status', { deploymentId: ok.id })
    expect(r.ok && Object.keys(r.summary as object).sort()).toEqual(['createdAt', 'deployedAt', 'destination', 'errorMessage', 'id', 'next', 'platform', 'status'])
  })

  it("explain_deploy_failure picks the scene's latest failed deployment, or says none failed", async () => {
    const empty = await runTool(ctx, 'explain_deploy_failure', { sceneId })
    expect(empty).toMatchObject({ ok: true, summary: { failed: null, message: 'No deploy of this scene has failed recently.' } })
    const { failed, ok } = await seedDeploys()
    const r = await runTool(ctx, 'explain_deploy_failure', { sceneId })
    expect(r).toMatchObject({ ok: true, summary: { id: failed.id, newerDeployed: true, destination: 'World "sun.dcl.eth"' } })
    const named = await runTool(ctx, 'explain_deploy_failure', { sceneId, deploymentId: ok.id })
    expect(named).toMatchObject({ ok: true, summary: { id: ok.id, next: "It's live. Nothing to do." } })
    const missing = await runTool(ctx, 'explain_deploy_failure', { sceneId, deploymentId: crypto.randomUUID() })
    expect(missing).toMatchObject({ ok: false, status: 404, error: "That deploy isn't one of this scene's recent deploys." })
  })
})
