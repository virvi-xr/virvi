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
import { testApp, createUser, createScene, createElement, createInstance, tokenFor, type TestUser } from './helpers/factories.js'
import { addRevision, createDesign } from './helpers/studio.js'
import { proposeCard } from '../src/assistant/actions.js'
import { assistantActions, studioDesigns, studioKindDefaults } from '../src/db/schema.js'

const IP = '198.51.100.23'

function ctxFor(app: FastifyInstance, user: TestUser): ToolCtx {
  const request = { headers: { authorization: `Bearer ${tokenFor(user)}` }, ip: IP } as unknown as FastifyRequest
  return { app, request, user: { id: user.id, email: user.email, role: user.role, orgId: null }, self: { email: user.email, wallets: [] } }
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
    const paid = Object.values(TOOLS).filter((t) => t.effect === 'paid')
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
    const covered = new Set([...cases.map(([n]) => n), 'update_scene', 'update_element', 'create_element', 'create_scene', 'create_design'])
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

  /** The owner's ctx with GET /api/studio/usage answered by `usage` (or refused, to prove it isn't read). */
  const withUsage = (usage: Record<string, unknown> | 'unread') => ({
    ...ctx,
    app: {
      inject: async (opts: { url: string; method: string }) => {
        if (opts.method === 'GET' && opts.url === '/api/studio/usage') {
          if (usage === 'unread') throw new Error('usage was read')
          return { statusCode: 200, body: JSON.stringify({ credits: 0, giftedPrompts: 0, ...usage }) }
        }
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
      expect(c.steps[0]).toMatchObject({ label: 'Send a Studio prompt', orgName: null })
    }
    const free = await proposeCard(withUsage('unread'), null, 'send_studio_prompt', { designId: d.id, fixChecks: true })
    expect(free).toMatchObject({ kind: 'card', detail: `"Neon cap": This one is free: fixing what the checker found doesn't use your prompts.` })
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
    expect(c).toEqual({ error: 'design_not_found' })
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
  })
})
