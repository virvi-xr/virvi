import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { createHash, createHmac } from 'node:crypto'
import { eq, and } from 'drizzle-orm'
import type { AssistantActionView, AssistantPlanView } from '@virvixr/shared'
import { db } from '../src/db/connection.js'
import { assistantActions, mediaAssets, organizations, sceneElements, scenePresetSchedules, scenePresets, scenes } from '../src/db/schema.js'
import { approvePlan, cancelPlan, proposeCard, proposePlan, recordDirect, undoAction, undoPlan } from '../src/assistant/actions.js'
import { inject } from '../src/assistant/tools/run.js'
import { TOOLS } from '../src/assistant/tools/index.js'
import { ToolError, type ToolCtx, type ToolDef } from '../src/assistant/tools/types.js'
import { z } from 'zod'
import { resetDb } from './helpers/db.js'
import { testApp, createUser, createScene, createElement, createInstance, tokenFor, type TestUser } from './helpers/factories.js'

function ctxFor(app: FastifyInstance, user: TestUser): ToolCtx {
  const request = { headers: { authorization: `Bearer ${tokenFor(user)}` }, ip: '198.51.100.41' } as unknown as FastifyRequest
  return { app, request, user: { id: user.id, email: user.email, role: user.role, orgId: null }, self: { email: user.email, wallets: [] } }
}

const sceneName = async (id: string) => (await db.query.scenes.findFirst({ where: eq(scenes.id, id) }))!.name
const rowsOf = (planId: string) => db.select().from(assistantActions).where(eq(assistantActions.planId, planId)).orderBy(assistantActions.step)
const isPlan = (p: AssistantPlanView | { error: string }): p is AssistantPlanView => !('error' in p)

describe('assistant action log, plans and undo', () => {
  let app: FastifyInstance
  let owner: TestUser
  let ctx: ToolCtx
  let sceneId: string
  let presetId: string

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

  const twoStep = () => [
    { tool: 'update_scene', args: { sceneId, name: 'Test Lounge' } },
    { tool: 'create_element', args: { sceneId, presetId, type: 'image', name: 'Poster' } },
  ]
  async function propose(steps = twoStep()): Promise<AssistantPlanView> {
    const p = await proposePlan(ctx, null, steps)
    if (!isPlan(p)) throw new Error(p.error)
    return p
  }

  describe('recordDirect', () => {
    it('stores a write as done, with undo, and undoes it', async () => {
      const a = await recordDirect(ctx, null, 'update_scene', { sceneId, name: 'Test Lounge' })
      expect(a).toMatchObject({ tool: 'update_scene', label: 'Rename scene to "Test Lounge"', status: 'done', canUndo: true, error: null, planId: null })
      expect(a).not.toHaveProperty('undo')
      expect(a).not.toHaveProperty('after')
      const [row] = await db.select().from(assistantActions).where(eq(assistantActions.id, a.id))
      expect(row.undo).toEqual({ method: 'PUT', url: `/api/scenes/${sceneId}`, body: { name: 'Old Lounge' } })
      expect(row.after).toEqual({ name: 'Test Lounge' })
      expect(row.effect).toBe('write')
      expect(row.argsHash).toMatch(/^[0-9a-f]{64}$/)
      expect(await sceneName(sceneId)).toBe('Test Lounge')

      const u = await undoAction(ctx, a.id)
      expect(u).toMatchObject({ id: a.id, status: 'undone', canUndo: false })
      expect(await sceneName(sceneId)).toBe('Old Lounge')
      expect(await undoAction(ctx, a.id)).toEqual({ error: 'not_undoable' })
    })

    it('stores a read as done, with nothing to undo', async () => {
      const a = await recordDirect(ctx, null, 'get_scene', { sceneId })
      expect(a).toMatchObject({ tool: 'get_scene', status: 'done', canUndo: false })
      const [row] = await db.select().from(assistantActions).where(eq(assistantActions.id, a.id))
      expect(row.effect).toBe('read')
      expect(row.undo).toBeNull()
      expect(await undoAction(ctx, a.id)).toEqual({ error: 'not_undoable' })
    })

    it("names the organization on a write the route refused after its target checked out", async () => {
      const [org] = await db.insert(organizations).values({ name: 'Acme', slug: `acme-${owner.id.slice(0, 8)}`, billingOwnerId: owner.id }).returning()
      await db.update(scenes).set({ orgId: org.id }).where(eq(scenes.id, sceneId))
      const a = await recordDirect(ctx, null, 'create_preset', { sceneId, name: 'Copy', fromPresetId: '00000000-0000-4000-8000-000000000000' })
      expect(a).toMatchObject({ status: 'failed', orgName: 'Acme' })
    })

    it("stores a refused write as failed, with the route's reason", async () => {
      const other = await createUser()
      const { scene } = await createScene(other, 'Not Yours')
      const a = await recordDirect(ctx, null, 'update_scene', { sceneId: scene.id, name: 'Mine now' })
      expect(a.status).toBe('failed')
      expect(a.canUndo).toBe(false)
      expect(a.error).toBeTruthy()
      expect(await sceneName(scene.id)).toBe('Not Yours')
    })

    it("keeps other people's emails out of the stored args, but runs with the exact ones", async () => {
      const a = await recordDirect(ctx, null, 'update_scene', { sceneId, description: 'Ask someone@else.example' })
      const [row] = await db.select().from(assistantActions).where(eq(assistantActions.id, a.id))
      expect(JSON.stringify(row.argsRedacted)).not.toContain('someone@else.example')
      expect((await db.query.scenes.findFirst({ where: eq(scenes.id, sceneId) }))!.description).toBe('Ask someone@else.example')
    })
  })

  describe('undo', () => {
    it('refuses when the scene was renamed by hand since, and leaves the manual name', async () => {
      const a = await recordDirect(ctx, null, 'update_scene', { sceneId, name: 'Test Lounge' })
      expect((await inject(ctx, { method: 'PUT', url: `/api/scenes/${sceneId}`, body: { name: 'Hand Named' } })).status).toBe(200)
      expect(await undoAction(ctx, a.id)).toEqual({ error: 'changed' })
      expect(await sceneName(sceneId)).toBe('Hand Named')
      const [row] = await db.select().from(assistantActions).where(eq(assistantActions.id, a.id))
      expect(row.status).toBe('done')
    })

    it('undoes element property and placement edits that nobody touched since', async () => {
      const el = await createElement(presetId, { properties: { liveSrc: 'https://old.example/live.m3u8', volume: 0.5 } })
      const inst = await createInstance(el.id)
      const e = await recordDirect(ctx, null, 'update_element', { sceneId, elementId: el.id, properties: { liveSrc: 'https://new.example/live.m3u8' } })
      const i = await recordDirect(ctx, null, 'update_instance', { sceneId, instanceId: inst.id, position: { x: 1.1, y: 0.3, z: -2.7 } })
      expect(await undoAction(ctx, i.id)).toMatchObject({ status: 'undone' })
      expect(await undoAction(ctx, e.id)).toMatchObject({ status: 'undone' })
      expect((await db.query.sceneElements.findFirst({ where: eq(sceneElements.id, el.id) }))!.properties).toEqual({ liveSrc: 'https://old.example/live.m3u8', volume: 0.5 })
    })

    it("undoing a property change keeps a later hand rename, and restores the property", async () => {
      const el = await createElement(presetId, { properties: { liveSrc: 'https://old.example/live.m3u8' } })
      const a = await recordDirect(ctx, null, 'update_element', { sceneId, elementId: el.id, properties: { liveSrc: 'https://new.example/live.m3u8' } })
      expect((await inject(ctx, { method: 'PUT', url: `/api/elements/${el.id}`, body: { name: 'Hand Named' } })).status).toBe(200)
      expect(await undoAction(ctx, a.id)).toMatchObject({ status: 'undone' })
      const now = (await db.query.sceneElements.findFirst({ where: eq(sceneElements.id, el.id) }))!
      expect(now.name).toBe('Hand Named')
      expect(now.properties).toEqual({ liveSrc: 'https://old.example/live.m3u8' })
    })

    it('undoes a schedule time and duration change that nobody touched since', async () => {
      const [schedule] = await db.insert(scenePresetSchedules).values({ sceneId, presetId, recurrence: 'daily', startDate: '2030-01-01', startTime: '20:00', timezone: 'UTC', durationMinutes: 60 }).returning()
      const a = await recordDirect(ctx, null, 'update_preset_schedule', { sceneId, scheduleId: schedule.id, startTime: '21:30', durationMinutes: 45 })
      expect(a.status).toBe('done')
      expect(await undoAction(ctx, a.id)).toMatchObject({ status: 'undone' })
      const now = (await db.query.scenePresetSchedules.findFirst({ where: eq(scenePresetSchedules.id, schedule.id) }))!
      expect([now.startTime, now.durationMinutes]).toEqual(['20:00', 60])
    })

    it('refuses to undo a create that was edited by hand since, and keeps it', async () => {
      const a = await recordDirect(ctx, null, 'create_element', { sceneId, presetId, type: 'image', name: 'Poster' })
      const [el] = await db.select().from(sceneElements).where(eq(sceneElements.presetId, presetId))
      expect((await inject(ctx, { method: 'PUT', url: `/api/elements/${el.id}`, body: { name: 'Hand Named' } })).status).toBe(200)
      expect(await undoAction(ctx, a.id)).toEqual({ error: 'changed' })
      expect(await db.select().from(sceneElements).where(eq(sceneElements.id, el.id))).toHaveLength(1)
    })

    it('undoes every kind of create nobody touched since', async () => {
      const el = await createElement(presetId)
      const [media] = await db.insert(mediaAssets).values({ ownerId: owner.id, filename: 'a.png', contentType: 'image/png', sizeBytes: 1, storageKey: 'media/a.png', publicUrl: 'https://cdn.example/a.png', status: 'ready' }).returning()
      const when = { recurrence: 'daily', startDate: '2031-01-01', startTime: '10:00', timezone: 'UTC' }
      const cases: Array<[string, Record<string, unknown>]> = [
        ['create_element', { sceneId, presetId, type: 'image', name: 'Poster', properties: { textureSrc: 'https://cdn.example/p.png' } }],
        ['create_preset', { sceneId, name: 'Copy', fromPresetId: presetId }],
        ['add_instance', { sceneId, elementId: el.id, position: { x: 1.1, y: 0.3, z: -2.7 } }],
        ['create_preset_schedule', { sceneId, presetId, ...when, durationMinutes: 30 }],
        ['add_to_library', { sceneId, mediaAssetId: media.id }],
        ['create_showing', { sceneId, elementId: el.id, title: 'Matinee', items: [{ url: 'https://cdn.example/m.mp4', duration: 60 }], ...when }],
      ]
      for (const [name, args] of cases) {
        const a = await recordDirect(ctx, null, name, args)
        expect(a.status, `${name}: ${a.error}`).toBe('done')
        expect(await undoAction(ctx, a.id), name).toMatchObject({ status: 'undone' })
      }
      expect(await db.select().from(sceneElements).where(eq(sceneElements.presetId, presetId))).toHaveLength(1)
      expect(await db.select().from(scenePresets).where(eq(scenePresets.sceneId, sceneId))).toHaveLength(1)
      expect(await db.select().from(scenePresetSchedules).where(eq(scenePresetSchedules.sceneId, sceneId))).toHaveLength(0)
    })

    it('refuses after 7 days', async () => {
      const a = await recordDirect(ctx, null, 'update_scene', { sceneId, name: 'Test Lounge' })
      const old = new Date(Date.now() - 8 * 24 * 3600 * 1000)
      await db.update(assistantActions).set({ createdAt: old, finishedAt: old }).where(eq(assistantActions.id, a.id))
      expect(await undoAction(ctx, a.id)).toEqual({ error: 'expired' })
      expect(await sceneName(sceneId)).toBe('Test Lounge')
    })

    it("can't undo someone else's action", async () => {
      const a = await recordDirect(ctx, null, 'update_scene', { sceneId, name: 'Test Lounge' })
      const b = ctxFor(app, await createUser())
      expect(await undoAction(b, a.id)).toEqual({ error: 'not_found' })
      expect(await undoAction(b, 'not-a-uuid')).toEqual({ error: 'not_found' })
      expect(await sceneName(sceneId)).toBe('Test Lounge')
    })

    it('treats a created element that was since deleted by hand as changed', async () => {
      const a = await recordDirect(ctx, null, 'create_element', { sceneId, presetId, type: 'image', name: 'Poster' })
      const [el] = await db.select().from(sceneElements).where(eq(sceneElements.presetId, presetId))
      await db.delete(sceneElements).where(eq(sceneElements.id, el.id))
      expect(await undoAction(ctx, a.id)).toEqual({ error: 'changed' })
    })
  })

  describe('plans', () => {
    it('a two-step plan runs both steps in order, and undoPlan restores the name and removes the element', async () => {
      const plan = await propose()
      expect(plan.steps.map((s) => [s.step, s.tool, s.status, s.label])).toEqual([
        [1, 'update_scene', 'awaiting_confirmation', 'Rename scene to "Test Lounge"'],
        [2, 'create_element', 'awaiting_confirmation', 'Add image "Poster"'],
      ])
      expect(new Date(plan.expiresAt).getTime() - Date.now()).toBeGreaterThan(9 * 60 * 1000)
      expect(await sceneName(sceneId)).toBe('Old Lounge')

      const seen: AssistantActionView[] = []
      const r = await approvePlan(ctx, plan.planId, plan.token, (a) => seen.push(a))
      expect(r).toEqual({ done: 2, failed: null })
      expect(seen.map((s) => [s.step, s.status])).toEqual([[1, 'done'], [2, 'done']])
      expect(await sceneName(sceneId)).toBe('Test Lounge')
      expect(await db.select().from(sceneElements).where(eq(sceneElements.presetId, presetId))).toHaveLength(1)

      const u = await undoPlan(ctx, plan.planId)
      expect(u).toMatchObject({ refused: null })
      if ('error' in u) throw new Error(u.error)
      expect(u.undone.map((s) => s.step)).toEqual([2, 1])
      expect(await sceneName(sceneId)).toBe('Old Lounge')
      expect(await db.select().from(sceneElements).where(eq(sceneElements.presetId, presetId))).toHaveLength(0)
    })

    it('a token approves once: the second time is used', async () => {
      const plan = await propose()
      expect(await approvePlan(ctx, plan.planId, plan.token, () => {})).toEqual({ done: 2, failed: null })
      expect(await approvePlan(ctx, plan.planId, plan.token, () => {})).toEqual({ error: 'used' })
      expect(await db.select().from(sceneElements).where(eq(sceneElements.presetId, presetId))).toHaveLength(1)
    })

    it('of two approvals at once, one runs the plan and the other is used', async () => {
      const plan = await propose()
      const both = await Promise.all([approvePlan(ctx, plan.planId, plan.token, () => {}), approvePlan(ctx, plan.planId, plan.token, () => {})])
      expect(both).toEqual(expect.arrayContaining([{ done: 2, failed: null }, { error: 'used' }]))
      expect(await db.select().from(sceneElements).where(eq(sceneElements.presetId, presetId))).toHaveLength(1)
    })

    it('an altered token is invalid', async () => {
      const plan = await propose()
      const flip = (c: string) => (c === 'A' ? 'B' : 'A')
      const altered = flip(plan.token[0]) + plan.token.slice(1)
      expect(await approvePlan(ctx, plan.planId, altered, () => {})).toEqual({ error: 'invalid_token' })
      const [mac, ms] = plan.token.split('.')
      expect(await approvePlan(ctx, plan.planId, `${mac}.${Number(ms) + 60_000}`, () => {})).toEqual({ error: 'invalid_token' })
      expect(await approvePlan(ctx, plan.planId, 'garbage', () => {})).toEqual({ error: 'invalid_token' })
      expect(await sceneName(sceneId)).toBe('Old Lounge')
      expect((await rowsOf(plan.planId)).map((r) => r.status)).toEqual(['awaiting_confirmation', 'awaiting_confirmation'])
    })

    it('an expired token is expired', async () => {
      const plan = await propose()
      await db.update(assistantActions).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(assistantActions.planId, plan.planId))
      expect(await approvePlan(ctx, plan.planId, plan.token, () => {})).toEqual({ error: 'expired' })
      expect(await sceneName(sceneId)).toBe('Old Lounge')
    })

    it("another user can't approve A's plan with A's token", async () => {
      const plan = await propose()
      const b = ctxFor(app, await createUser())
      expect(await approvePlan(b, plan.planId, plan.token, () => {})).toEqual({ error: 'invalid_token' })
      expect(await sceneName(sceneId)).toBe('Old Lounge')
      expect(await approvePlan(ctx, plan.planId, plan.token, () => {})).toEqual({ done: 2, failed: null })
    })

    it('a token built without the secret is invalid', async () => {
      const plan = await propose()
      const rows = await rowsOf(plan.planId)
      const ms = plan.token.split('.')[1]
      const stepsHash = createHash('sha256').update(rows.map((r) => r.argsHash).join(',')).digest('hex')
      const forged = createHmac('sha256', 'not-the-secret').update(`${plan.planId}.${owner.id}.${stepsHash}.${ms}`).digest('base64url') + '.' + ms
      expect(await approvePlan(ctx, plan.planId, forged, () => {})).toEqual({ error: 'invalid_token' })
      expect(await sceneName(sceneId)).toBe('Old Lounge')
    })

    it('runs the stored args, whatever else the request carried', async () => {
      const plan = await propose()
      const body = { token: plan.token, steps: [{ tool: 'update_scene', args: { sceneId, name: 'Swapped' } }, { tool: 'create_element', args: { sceneId, presetId, type: 'video', name: 'Evil' } }] }
      // approvePlan takes no steps: only the plan id and token from a request reach it
      expect(await approvePlan(ctx, plan.planId, body.token, () => {})).toEqual({ done: 2, failed: null })
      expect(await sceneName(sceneId)).toBe('Test Lounge')
      expect((await db.select().from(sceneElements).where(eq(sceneElements.presetId, presetId))).map((e) => e.name)).toEqual(['Poster'])
    })

    it('refuses to run a step whose stored args no longer match its hash', async () => {
      const plan = await propose()
      const [first] = await rowsOf(plan.planId)
      await db.update(assistantActions).set({ args: { sceneId, name: 'Swapped' } }).where(eq(assistantActions.id, first.id))
      const r = await approvePlan(ctx, plan.planId, plan.token, () => {})
      expect(r).toMatchObject({ done: 0, failed: { step: 1, status: 'failed' } })
      expect(await sceneName(sceneId)).toBe('Old Lounge')
    })

    it('refuses read-only, one-step, too-long and unknown-tool plans', async () => {
      expect(await proposePlan(ctx, null, [{ tool: 'get_scene', args: { sceneId } }, { tool: 'update_scene', args: { sceneId, name: 'X' } }])).toHaveProperty('error')
      expect(await proposePlan(ctx, null, [{ tool: 'update_scene', args: { sceneId, name: 'X' } }])).toHaveProperty('error')
      expect(await proposePlan(ctx, null, Array.from({ length: 11 }, (_, i) => ({ tool: 'update_scene', args: { sceneId, name: `X${i}` } })))).toHaveProperty('error')
      expect(await proposePlan(ctx, null, [{ tool: 'nope', args: {} }, { tool: 'update_scene', args: { sceneId, name: 'X' } }])).toHaveProperty('error')
      expect(await proposePlan(ctx, null, [{ tool: 'update_scene', args: { sceneId } }, { tool: 'update_scene', args: { sceneId, name: 'X' } }])).toHaveProperty('error')
      expect(await db.select().from(assistantActions)).toHaveLength(0)
    })

    it("refuses early when a step targets someone else's scene", async () => {
      const other = await createUser()
      const { scene } = await createScene(other, 'Not Yours')
      const p = await proposePlan(ctx, null, [{ tool: 'update_scene', args: { sceneId, name: 'X' } }, { tool: 'update_scene', args: { sceneId: scene.id, name: 'Mine' } }])
      expect(p).toHaveProperty('error')
      expect((p as { error: string }).error).toMatch(/^Step 2/)
      expect(await db.select().from(assistantActions)).toHaveLength(0)
    })

    it('stops at the first failure: step 1 done, step 2 failed, step 3 cancelled', async () => {
      const el = await createElement(presetId)
      const plan = await propose([
        { tool: 'update_scene', args: { sceneId, name: 'Test Lounge' } },
        { tool: 'update_element', args: { sceneId, elementId: el.id, name: 'Renamed' } },
        { tool: 'rename_preset', args: { sceneId, presetId, name: 'Evening' } },
      ])
      await db.delete(sceneElements).where(eq(sceneElements.id, el.id))
      const seen: AssistantActionView[] = []
      const r = await approvePlan(ctx, plan.planId, plan.token, (a) => seen.push(a))
      expect(r).toMatchObject({ done: 1, failed: { step: 2, status: 'failed' } })
      expect((await rowsOf(plan.planId)).map((x) => x.status)).toEqual(['done', 'failed', 'cancelled'])
      expect(seen.map((s) => [s.step, s.status])).toEqual([[1, 'done'], [2, 'failed'], [3, 'cancelled']])
      expect(await sceneName(sceneId)).toBe('Test Lounge')
      expect((await db.query.scenePresets.findFirst({ where: eq(scenePresets.id, presetId) }))!.name).toBe('Default')
    })

    it('cancelPlan cancels a waiting plan, which then reads as used', async () => {
      const plan = await propose()
      await cancelPlan(owner.id, plan.planId)
      expect((await rowsOf(plan.planId)).map((x) => x.status)).toEqual(['cancelled', 'cancelled'])
      expect(await approvePlan(ctx, plan.planId, plan.token, () => {})).toEqual({ error: 'used' })
      expect(await sceneName(sceneId)).toBe('Old Lounge')
    })

    it("cancelPlan leaves someone else's plan alone", async () => {
      const plan = await propose()
      await cancelPlan((await createUser()).id, plan.planId)
      expect(await db.select().from(assistantActions).where(and(eq(assistantActions.planId, plan.planId), eq(assistantActions.status, 'awaiting_confirmation')))).toHaveLength(2)
    })

    it('undoPlan stops at the first refusal', async () => {
      const plan = await propose([
        { tool: 'update_scene', args: { sceneId, name: 'Test Lounge' } },
        { tool: 'rename_preset', args: { sceneId, presetId, name: 'Evening' } },
      ])
      await approvePlan(ctx, plan.planId, plan.token, () => {})
      await db.update(scenePresets).set({ name: 'By Hand' }).where(eq(scenePresets.id, presetId))
      const u = await undoPlan(ctx, plan.planId)
      if ('error' in u) throw new Error(u.error)
      expect(u.undone).toHaveLength(0)
      expect(u.refused).toMatchObject({ error: 'changed', action: { step: 2 } })
      expect(await sceneName(sceneId)).toBe('Test Lounge')
    })
  })
})

describe('assistant confirmation cards', () => {
  let app: FastifyInstance
  let owner: TestUser
  let ctx: ToolCtx
  let calls = 0
  let refuse = false
  let mode: 'ok' | 'blocked' | 'before404' = 'ok'

  const stub: ToolDef<{ prompt: string }> = {
    name: 'stub_paid',
    description: 'test',
    input: z.object({ prompt: z.string().trim() }),
    effect: 'paid',
    before: async () => {
      if (mode === 'before404') throw new ToolError(404, 'Design not found')
      return { undo: null, after: () => null, orgName: 'Acme' }
    },
    preview: async () => (mode === 'blocked' ? { blocked: 'No prompts left', link: { label: 'Buy Studio prompts', href: '/studio' } } : { detail: 'Uses 1 of your 3 prompts left today.' }),
    call: (a) => ({ method: 'POST', url: '/__stub_paid', body: a }),
    label: (a) => `Run stub: ${a.prompt}`,
    summarize: (r) => r,
  }

  beforeAll(async () => {
    const { buildApp } = await import('../src/app.js')
    app = await buildApp({ rateLimit: false, logger: false, backfill: false })
    app.post('/__stub_paid', async (_req, reply) => {
      calls++
      if (refuse) return reply.code(403).send({ error: 'No prompts left today' })
      return { ok: true }
    })
    await app.ready()
    ;(TOOLS as Record<string, unknown>).stub_paid = stub
    ;(TOOLS as Record<string, unknown>).stub_public = { ...stub, name: 'stub_public', effect: 'public', call: (a: { prompt: string }) => ({ method: 'POST', url: '/__stub_paid', body: a }) }
  })
  afterAll(async () => {
    delete (TOOLS as Record<string, unknown>).stub_paid
    delete (TOOLS as Record<string, unknown>).stub_public
    await app.close()
  })
  beforeEach(async () => {
    await resetDb()
    owner = await createUser()
    ctx = ctxFor(app, owner)
    calls = 0
    refuse = false
    mode = 'ok'
  })

  const card = async () => {
    const c = await proposeCard(ctx, null, 'stub_paid', { prompt: '  a hat ' })
    if (!('kind' in c)) throw new Error(JSON.stringify(c))
    return c
  }

  it('offers a one-step card with the detail, and stores a paid row with the exact args', async () => {
    const c = await card()
    expect(c).toMatchObject({ kind: 'card', detail: 'Uses 1 of your 3 prompts left today.' })
    expect(c.steps).toHaveLength(1)
    expect(c.steps[0]).toMatchObject({ status: 'awaiting_confirmation', step: 1, label: 'Run stub: a hat', orgName: 'Acme' })
    const [row] = await rowsOf(c.planId)
    expect(row).toMatchObject({ effect: 'paid', detail: 'Uses 1 of your 3 prompts left today.', args: { prompt: 'a hat' }, argsRedacted: { prompt: 'a hat' }, label: 'Run stub: a hat', orgName: 'Acme' })
    expect(calls).toBe(0)
  })

  it('runs once on approval, then the token is used', async () => {
    const c = await card()
    expect(await approvePlan(ctx, c.planId, c.token, () => {})).toEqual({ done: 1, failed: null })
    expect(calls).toBe(1)
    expect(await approvePlan(ctx, c.planId, c.token, () => {})).toEqual({ error: 'used' })
    expect(calls).toBe(1)
  })

  it('cancelPlan cancels a card', async () => {
    const c = await card()
    expect(await cancelPlan(owner.id, c.planId)).toBe(1)
    expect(await approvePlan(ctx, c.planId, c.token, () => {})).toEqual({ error: 'used' })
    expect(calls).toBe(0)
  })

  it('a blocked preview returns the link and writes no row', async () => {
    mode = 'blocked'
    expect(await proposeCard(ctx, null, 'stub_paid', { prompt: 'x' })).toEqual({ blocked: 'No prompts left', link: { label: 'Buy Studio prompts', href: '/studio' } })
    expect(await db.select().from(assistantActions)).toHaveLength(0)
  })

  it('a before() that throws ToolError returns an error and writes no row', async () => {
    mode = 'before404'
    expect(await proposeCard(ctx, null, 'stub_paid', { prompt: 'x' })).toEqual({ error: 'Design not found' })
    expect(await db.select().from(assistantActions)).toHaveLength(0)
  })

  it('refuses unknown tools, non-paid tools and bad args without a row', async () => {
    expect(await proposeCard(ctx, null, 'nope', {})).toHaveProperty('error')
    expect(await proposeCard(ctx, null, 'get_scene', {})).toHaveProperty('error')
    expect(await proposeCard(ctx, null, 'stub_paid', { prompt: 5 })).toHaveProperty('error')
    expect(await db.select().from(assistantActions)).toHaveLength(0)
  })

  it('proposePlan refuses a paid step', async () => {
    const r = await proposePlan(ctx, null, [{ tool: 'stub_paid', args: { prompt: 'x' } }, { tool: 'stub_paid', args: { prompt: 'y' } }])
    expect(r).toEqual({ error: "Step 1: stub_paid needs its own confirmation, so it can't be in a plan. Call it on its own." })
    expect(await db.select().from(assistantActions)).toHaveLength(0)
  })

  it('offers a card for a public tool, stores a public row, and runs it once on approval', async () => {
    const c = await proposeCard(ctx, null, 'stub_public', { prompt: 'a raffle' })
    if (!('kind' in c)) throw new Error(JSON.stringify(c))
    expect(c.kind).toBe('card')
    expect((await rowsOf(c.planId))[0]).toMatchObject({ effect: 'public', args: { prompt: 'a raffle' } })
    expect(calls).toBe(0)
    expect(await approvePlan(ctx, c.planId, c.token, () => {})).toEqual({ done: 1, failed: null })
    expect(calls).toBe(1)
  })

  it('proposePlan refuses a public step', async () => {
    const r = await proposePlan(ctx, null, [{ tool: 'stub_public', args: { prompt: 'x' } }, { tool: 'stub_public', args: { prompt: 'y' } }])
    expect(r).toEqual({ error: "Step 1: stub_public needs its own confirmation, so it can't be in a plan. Call it on its own." })
    expect(await db.select().from(assistantActions)).toHaveLength(0)
  })

  it("marks the step failed with the route's own words when it refuses at approval", async () => {
    const c = await card()
    refuse = true
    const r = await approvePlan(ctx, c.planId, c.token, () => {})
    expect(r).toMatchObject({ done: 0, failed: { status: 'failed', error: 'No prompts left today' } })
    expect((await rowsOf(c.planId))[0]).toMatchObject({ status: 'failed', error: 'No prompts left today' })
  })
})
