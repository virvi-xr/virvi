import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { eq } from 'drizzle-orm'
import { createHash } from 'node:crypto'
import type { AssistantStreamEvent } from '@virvixr/shared'
import { db } from '../src/db/connection.js'
import { apiKeys, assistantActions, assistantConversations, assistantMessages, users, scenes } from '../src/db/schema.js'
import { config } from '../src/config.js'
import { buildApp } from '../src/app.js'
import { issueTrialSession } from '../src/auth/trial.js'
import { setAssistantModel, type ModelResult } from '../src/assistant/model.js'
import { resetDb } from './helpers/db.js'
import { z } from 'zod'
import type { FastifyRequest } from 'fastify'
import { proposeCard } from '../src/assistant/actions.js'
import { TOOLS } from '../src/assistant/tools/index.js'
import type { ToolCtx, ToolDef } from '../src/assistant/tools/types.js'
import { testApp, createUser, createScene, tokenFor, type TestUser } from './helpers/factories.js'

const usage = { input_tokens: 50, output_tokens: 10 }
const text = (t: string): ModelResult => ({ content: [{ type: 'text', text: t }], stopReason: 'end_turn', usage })
let n = 0
const tool = (name: string, input: unknown): ModelResult => ({ content: [{ type: 'tool_use', id: `toolu_r${++n}`, name, input }], stopReason: 'tool_use', usage })
function script(steps: ModelResult[]) {
  let i = 0
  setAssistantModel(async (_p, onText) => {
    const r = steps[Math.min(i++, steps.length - 1)]
    for (const b of r.content) if (b.type === 'text') onText(b.text)
    return r
  })
}

/** The `data:` events of an SSE body, in order. */
function events(body: string): AssistantStreamEvent[] {
  return body.split('\n\n').filter((c) => c.startsWith('data: ')).map((c) => JSON.parse(c.slice(6)))
}

describe('assistant routes', () => {
  let app: FastifyInstance
  let owner: TestUser
  let sceneId: string
  const prev = { enabled: config.assistantEnabled, audience: config.assistantAudience, billing: config.billingEnabled, perMinute: config.assistantMessagesPerMinute }
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
    // No billing: every signed-in account is on the assistant (the access rules have their own tests)
    set('assistantEnabled', true); set('assistantAudience', 'paid'); set('billingEnabled', false)
    owner = await createUser()
    sceneId = (await createScene(owner, 'Old Lounge')).scene.id
  })
  afterEach(() => {
    setAssistantModel(null)
    set('assistantEnabled', prev.enabled); set('assistantAudience', prev.audience); set('billingEnabled', prev.billing); set('assistantMessagesPerMinute', prev.perMinute)
  })

  const newConversation = async (u = owner) => {
    const res = await app.inject({ method: 'POST', url: '/api/assistant/conversations', headers: auth(u) })
    expect(res.statusCode).toBe(201)
    return res.json().id as string
  }
  const send = (conversationId: string, textIn: string, u = owner, headers: Record<string, string> = {}) =>
    app.inject({ method: 'POST', url: `/api/assistant/conversations/${conversationId}/messages`, headers: { ...auth(u), ...headers }, payload: { text: textIn, page: { path: '/scenes', sceneId } } })
  const sceneName = async () => (await db.query.scenes.findFirst({ where: eq(scenes.id, sceneId) }))!.name

  describe('access and the kill switch', () => {
    it('reports status per audience, and hidden for a trial', async () => {
      set('assistantAudience', 'admins')
      const admin = await createUser({ role: 'admin' })
      const a = await app.inject({ method: 'GET', url: '/api/assistant/status', headers: auth(admin) })
      expect(a.statusCode).toBe(200)
      expect(a.json()).toMatchObject({ state: 'ok', budget: { percentLeft: 100, warn: false } })
      // Dollars never leave the server
      expect(a.json()).not.toHaveProperty('budgetUsd')
      expect(a.json()).not.toHaveProperty('spentUsd')
      const plain = await app.inject({ method: 'GET', url: '/api/assistant/status', headers: auth(owner) })
      expect(plain.json()).toEqual({ state: 'hidden' })

      set('assistantAudience', 'paid'); set('billingEnabled', true)
      const free = await app.inject({ method: 'GET', url: '/api/assistant/status', headers: auth(owner) })
      expect(free.json()).toEqual({ state: 'locked', reason: 'plan' })

      const t = await createUser({ email: null })
      await db.update(users).set({ isTrial: true, trialLastActiveAt: new Date() }).where(eq(users.id, t.id))
      const { accessToken } = issueTrialSession(app, { id: t.id, displayName: t.displayName, role: 'creator', trialLastActiveAt: new Date() })
      const trial = await app.inject({ method: 'GET', url: '/api/assistant/status', headers: { authorization: `Bearer ${accessToken}` } })
      expect(trial.statusCode).toBe(200)
      expect(trial.json()).toEqual({ state: 'hidden' })
      // Every other route refuses a trial outright
      const list = await app.inject({ method: 'GET', url: '/api/assistant/conversations', headers: { authorization: `Bearer ${accessToken}` } })
      expect(list.statusCode).toBe(403)
    })

    it('reports hidden when switched off', async () => {
      set('assistantEnabled', false)
      const res = await app.inject({ method: 'GET', url: '/api/assistant/status', headers: auth(owner) })
      expect(res.statusCode).toBe(200)
      expect(res.json()).toEqual({ state: 'hidden' })
    })

    it('is 404 everywhere when switched off', async () => {
      const id = await newConversation()
      set('assistantEnabled', false)
      script([text('never')])
      const res = await send(id, 'Hello')
      expect(res.statusCode).toBe(404)
      expect(res.json()).toEqual({ error: 'assistant_unavailable' })
    })

    it('is 403 assistant_locked for a free user', async () => {
      set('billingEnabled', true)
      const res = await app.inject({ method: 'GET', url: '/api/assistant/conversations', headers: auth(owner) })
      expect(res.statusCode).toBe(403)
      expect(res.json()).toEqual({ error: 'assistant_locked', reason: 'plan' })
    })

    it('refuses an API key on every route, and reports hidden on status', async () => {
      const id = await newConversation()
      const key = 'virvi_' + 'b'.repeat(40)
      await db.insert(apiKeys).values({ userId: owner.id, name: 't', keyHash: createHash('sha256').update(key).digest('hex'), keyPrefix: key.slice(0, 8) } as any)
      const headers = { authorization: `Bearer ${key}` }
      script([text('never')])
      const status = await app.inject({ method: 'GET', url: '/api/assistant/status', headers })
      expect(status.json()).toEqual({ state: 'hidden' })
      const id0 = '00000000-0000-4000-8000-000000000000'
      for (const [method, url] of [
        ['GET', '/api/assistant/conversations'],
        ['GET', '/api/assistant/activity'],
        ['POST', '/api/assistant/conversations'],
        ['POST', `/api/assistant/conversations/${id}/messages`],
        ['POST', `/api/assistant/plans/${id0}/approve`],
        ['POST', `/api/assistant/actions/${id0}/undo`],
        ['POST', `/api/assistant/plans/${id0}/undo`],
      ] as const) {
        const res = await app.inject({ method, url, headers, payload: { text: 'Hi', page: { path: '/scenes' } } })
        expect(res.statusCode, `${method} ${url}`).toBe(403)
        expect(res.json()).toEqual({ error: 'assistant_session_only', message: 'The assistant works only when you are signed in to the dashboard.' })
      }
      expect(await db.select().from(assistantMessages)).toHaveLength(0)
    })

    it('is 503 when no model is configured', async () => {
      const prevKey = config.anthropicApiKey
      set('anthropicApiKey', null)
      try {
        const id = await newConversation()
        const res = await send(id, 'Hello')
        expect(res.statusCode).toBe(503)
        expect(res.json()).toEqual({ error: 'assistant_unconfigured' })
      } finally {
        set('anthropicApiKey', prevKey)
      }
    })
  })

  describe('conversations', () => {
    it('creates, lists and deletes; the action log outlives the conversation', async () => {
      const id = await newConversation()
      script([tool('update_scene', { sceneId, name: 'Test Lounge' }), text('Renamed.')])
      expect((await send(id, 'Rename my lounge to Test Lounge')).statusCode).toBe(200)

      const list = await app.inject({ method: 'GET', url: '/api/assistant/conversations', headers: auth(owner) })
      expect(list.json()).toEqual([{ id, title: 'Rename my lounge to Test Lounge', updatedAt: expect.any(String) }])
      const other = await createUser()
      expect((await app.inject({ method: 'GET', url: '/api/assistant/conversations', headers: auth(other) })).json()).toEqual([])

      const msgs = await app.inject({ method: 'GET', url: `/api/assistant/conversations/${id}/messages`, headers: auth(owner) })
      const views = msgs.json()
      // The tool_result row is hidden: one user view, one merged assistant view with its action
      expect(views.map((v: any) => v.role)).toEqual(['user', 'assistant'])
      expect(views[1]).toMatchObject({ text: 'Renamed.', actions: [{ tool: 'update_scene', status: 'done', canUndo: true }] })

      const del = await app.inject({ method: 'DELETE', url: `/api/assistant/conversations/${id}`, headers: auth(owner) })
      expect(del.statusCode).toBe(204)
      expect((await app.inject({ method: 'GET', url: `/api/assistant/conversations/${id}/messages`, headers: auth(owner) })).statusCode).toBe(404)
      expect(await db.select().from(assistantMessages)).toHaveLength(0)
      const actions = await db.select().from(assistantActions)
      expect(actions).toHaveLength(1)
      expect(actions[0].conversationId).toBeNull()
    })
  })

  describe('the stream', () => {
    it('streams events ending in done, with the CORS header', async () => {
      const id = await newConversation()
      script([text('Hi there')])
      const res = await send(id, 'Hello', owner, { origin: 'https://virvi.io' })
      expect(res.statusCode).toBe(200)
      expect(res.headers['content-type']).toBe('text/event-stream')
      expect(res.headers['cache-control']).toBe('no-cache')
      expect(res.headers['x-accel-buffering']).toBe('no')
      expect(res.headers['access-control-allow-origin']).toBe('https://virvi.io')
      expect(res.headers['x-request-id']).toBeTruthy()
      const evs = events(res.body)
      expect(evs.map((e) => e.type)).toEqual(['text', 'budget', 'done'])
    })

    it('refuses a second message while a turn is running', async () => {
      const id = await newConversation()
      let release!: () => void
      let started!: () => void
      const running = new Promise<void>((r) => { started = r })
      const held = new Promise<void>((r) => { release = r })
      setAssistantModel(async () => {
        started()
        await held
        return text('done')
      })
      const first = send(id, 'One')
      await running
      const second = await send(id, 'Two')
      expect(second.statusCode).toBe(409)
      expect(second.json()).toMatchObject({ error: 'assistant_busy' })
      release()
      expect((await first).statusCode).toBe(200)
      // Free again once the turn ends
      script([text('ok')])
      expect((await send(id, 'Three')).statusCode).toBe(200)
    })

    it('rate-limits new conversations per account', async () => {
      set('assistantMessagesPerMinute', 2)
      const limited = await buildApp({ rateLimit: true, logger: false, backfill: false })
      await limited.ready()
      try {
        const hit = () => limited.inject({ method: 'POST', url: '/api/assistant/conversations', headers: auth(owner) })
        expect((await hit()).statusCode).toBe(201)
        expect((await hit()).statusCode).toBe(201)
        expect((await hit()).statusCode).toBe(429)
      } finally {
        await limited.close()
      }
    })

    it('rate-limits messages per account', async () => {
      set('assistantMessagesPerMinute', 2)
      const limited = await buildApp({ rateLimit: true, logger: false, backfill: false })
      await limited.ready()
      try {
        const res = await limited.inject({ method: 'POST', url: '/api/assistant/conversations', headers: auth(owner) })
        const id = res.json().id
        script([text('ok')])
        const hit = () => limited.inject({ method: 'POST', url: `/api/assistant/conversations/${id}/messages`, headers: auth(owner), payload: { text: 'Hi', page: { path: '/scenes' } } })
        expect((await hit()).statusCode).toBe(200)
        expect((await hit()).statusCode).toBe(200)
        expect((await hit()).statusCode).toBe(429)
      } finally {
        await limited.close()
      }
    })
  })

  describe('plans and undo', () => {
    it('approves a plan over the stream, once', async () => {
      const id = await newConversation()
      const presetId = (await db.query.scenes.findFirst({ where: eq(scenes.id, sceneId) }))!.activePresetId!
      script([
        tool('propose_plan', { steps: [{ tool: 'update_scene', args: { sceneId, name: 'Test Lounge' } }, { tool: 'create_element', args: { sceneId, presetId, type: 'image', name: 'Poster' } }] }),
        text('Approve to go ahead.'),
      ])
      const proposed = events((await send(id, 'Rename it and add a poster')).body)
      const plan = proposed.find((e): e is Extract<AssistantStreamEvent, { type: 'plan' }> => e.type === 'plan')!.plan

      script([text('Both changes are done.')])
      const approve = () => app.inject({ method: 'POST', url: `/api/assistant/plans/${plan.planId}/approve`, headers: auth(owner), payload: { token: plan.token } })
      const res = await approve()
      expect(res.statusCode).toBe(200)
      const evs = events(res.body)
      expect(evs.filter((e) => e.type === 'action').map((e: any) => e.action.status)).toEqual(['done', 'done'])
      expect(evs.some((e) => e.type === 'text' && e.delta === 'Both changes are done.')).toBe(true)
      expect(evs.at(-1)?.type).toBe('done')
      expect(await sceneName()).toBe('Test Lounge')

      const again = await approve()
      expect(again.statusCode).toBe(409)
      expect(again.json()).toEqual({ error: 'used', message: 'This plan already ran.' })
      const forged = await app.inject({ method: 'POST', url: `/api/assistant/plans/${plan.planId}/approve`, headers: auth(owner), payload: { token: 'nope' } })
      expect(forged.statusCode).toBe(403)
      expect(forged.json()).toEqual({ error: 'invalid_token', message: "This approval isn't valid. Ask the assistant to propose the plan again." })

      // The approval text is hidden in the history
      const views = (await app.inject({ method: 'GET', url: `/api/assistant/conversations/${id}/messages`, headers: auth(owner) })).json()
      expect(views.map((v: any) => v.role)).toEqual(['user', 'assistant'])
      expect(JSON.stringify(views)).not.toContain('The user approved the plan')
      expect(views[1].actions).toHaveLength(2)

      // Undo the whole plan
      const undo = await app.inject({ method: 'POST', url: `/api/assistant/plans/${plan.planId}/undo`, headers: auth(owner) })
      expect(undo.statusCode).toBe(200)
      expect(undo.json().map((a: any) => a.status)).toEqual(['undone', 'undone'])
      expect(await sceneName()).toBe('Old Lounge')
    })

    it("says a card's refusals as a card: confirmed and sent, not a plan", async () => {
      const stub: ToolDef<{ prompt: string }> = {
        name: 'stub_card', description: 'test', input: z.object({ prompt: z.string() }), effect: 'paid',
        before: async () => ({ undo: null, after: () => null, orgName: null }),
        preview: async () => ({ detail: 'Uses 1 of your 3 prompts left today.' }),
        call: () => ({ method: 'POST', url: '/__never' }), label: () => 'Send "a hat"', summarize: (r) => r,
      }
      ;(TOOLS as Record<string, unknown>).stub_card = stub
      try {
        const id = await newConversation()
        const request = { headers: auth(owner), ip: '198.51.100.7' } as unknown as FastifyRequest
        const ctx: ToolCtx = { app, request, user: { id: owner.id, email: owner.email, role: owner.role, orgId: null }, self: { email: owner.email, wallets: [] }, walletRefs: [] }
        const card = await proposeCard(ctx, id, 'stub_card', { prompt: 'a hat' })
        if (!('kind' in card)) throw new Error('no card')
        const approve = (token: string) => app.inject({ method: 'POST', url: `/api/assistant/plans/${card.planId}/approve`, headers: auth(owner), payload: { token } })
        expect((await approve('nope')).json()).toEqual({ error: 'invalid_token', message: "This confirmation isn't valid. Ask the assistant again." })
        await db.update(assistantActions).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(assistantActions.planId, card.planId))
        const expired = await approve(card.token)
        expect(expired.statusCode).toBe(410)
        expect(expired.json()).toEqual({ error: 'expired', message: 'This expired. Ask again.' })
        await db.update(assistantActions).set({ status: 'done' }).where(eq(assistantActions.planId, card.planId))
        const used = await approve(card.token)
        expect(used.statusCode).toBe(409)
        expect(used.json()).toEqual({ error: 'used', message: 'This was already sent.' })
      } finally {
        delete (TOOLS as Record<string, unknown>).stub_card
      }
    })

    it('cancels a plan', async () => {
      const id = await newConversation()
      const presetId = (await db.query.scenes.findFirst({ where: eq(scenes.id, sceneId) }))!.activePresetId!
      script([tool('propose_plan', { steps: [{ tool: 'update_scene', args: { sceneId, name: 'A' } }, { tool: 'rename_preset', args: { sceneId, presetId, name: 'B' } }] }), text('Approve?')])
      const plan = (events((await send(id, 'Two things')).body).find((e) => e.type === 'plan') as any).plan
      const res = await app.inject({ method: 'POST', url: `/api/assistant/plans/${plan.planId}/cancel`, headers: auth(owner) })
      expect(res.statusCode).toBe(204)
      const rows = await db.select().from(assistantActions).where(eq(assistantActions.planId, plan.planId))
      expect(rows.every((r) => r.status === 'cancelled')).toBe(true)
    })

    it('undoes a write, and refuses once it was edited by hand', async () => {
      const id = await newConversation()
      script([tool('update_scene', { sceneId, name: 'Test Lounge' }), text('Renamed.')])
      const action = (events((await send(id, 'Rename it')).body).find((e) => e.type === 'action') as any).action
      const undo = await app.inject({ method: 'POST', url: `/api/assistant/actions/${action.id}/undo`, headers: auth(owner) })
      expect(undo.statusCode).toBe(200)
      expect(undo.json()).toMatchObject({ id: action.id, status: 'undone', canUndo: false })
      expect(await sceneName()).toBe('Old Lounge')

      script([tool('update_scene', { sceneId, name: 'Second Name' }), text('Renamed.')])
      const second = (events((await send(id, 'Rename it again')).body).find((e) => e.type === 'action') as any).action
      await app.inject({ method: 'PUT', url: `/api/scenes/${sceneId}`, headers: auth(owner), payload: { name: 'Hand Edit' } })
      const refused = await app.inject({ method: 'POST', url: `/api/assistant/actions/${second.id}/undo`, headers: auth(owner) })
      expect(refused.statusCode).toBe(409)
      expect(refused.json()).toEqual({ error: 'changed', message: "This changed after the assistant's edit, so Undo would overwrite it." })
      expect(await sceneName()).toBe('Hand Edit')
    })

    it('still undoes your own change after a downgrade or with the audience narrowed, but not when switched off', async () => {
      const id = await newConversation()
      const undo = (actionId: string) => app.inject({ method: 'POST', url: `/api/assistant/actions/${actionId}/undo`, headers: auth(owner) })
      const write = async (name: string) => {
        script([tool('update_scene', { sceneId, name }), text('Renamed.')])
        return (events((await send(id, 'Rename it')).body).find((e) => e.type === 'action') as any).action.id as string
      }
      const a = await write('First')
      set('billingEnabled', true) // a free account now: locked
      expect((await app.inject({ method: 'GET', url: '/api/assistant/conversations', headers: auth(owner) })).statusCode).toBe(403)
      expect((await undo(a)).statusCode).toBe(200)
      expect(await sceneName()).toBe('Old Lounge')

      set('billingEnabled', false)
      const b = await write('Second')
      set('assistantAudience', 'admins') // hidden for this account
      expect((await undo(b)).statusCode).toBe(200)
      // Someone else's action is still not found
      set('assistantAudience', 'paid')
      const c = await write('Third')
      set('assistantAudience', 'admins')
      const other = await createUser()
      expect((await app.inject({ method: 'POST', url: `/api/assistant/actions/${c}/undo`, headers: auth(other) })).statusCode).toBe(404)
      set('assistantEnabled', false)
      expect((await undo(c)).statusCode).toBe(404)
      expect(await sceneName()).toBe('Third')
    })

    it("is 404 for someone else's conversation, plan or action", async () => {
      const id = await newConversation()
      script([tool('update_scene', { sceneId, name: 'Test Lounge' }), text('Renamed.')])
      const action = (events((await send(id, 'Rename it')).body).find((e) => e.type === 'action') as any).action
      const other = await createUser()
      for (const [method, url] of [
        ['GET', `/api/assistant/conversations/${id}/messages`],
        ['DELETE', `/api/assistant/conversations/${id}`],
        ['POST', `/api/assistant/actions/${action.id}/undo`],
      ] as const) {
        const res = await app.inject({ method, url, headers: auth(other) })
        expect(res.statusCode, `${method} ${url}`).toBe(404)
      }
      expect((await send(id, 'Hi', other)).statusCode).toBe(404)
      expect(await db.select().from(assistantConversations)).toHaveLength(1)
    })
  })

  describe('activity', () => {
    const row = (o: Partial<typeof assistantActions.$inferInsert> = {}) => ({
      userId: owner.id, tool: 'update_scene', effect: 'write' as const, argsRedacted: {}, argsHash: 'h', label: 'Renamed a scene',
      status: 'done' as const, undo: { x: 1 }, finishedAt: new Date(), ...o,
    })
    const activity = (qs = '', u = owner) => app.inject({ method: 'GET', url: `/api/assistant/activity${qs}`, headers: auth(u) })

    it("lists only the caller's writes and paid runs, newest first, and leaves out reads and pending cards", async () => {
      const other = await createUser()
      const t = (n: number) => new Date(Date.UTC(2026, 10, 1, 0, 0, n))
      const [w] = await db.insert(assistantActions).values(row({ createdAt: t(1) })).returning()
      const [p] = await db.insert(assistantActions).values(row({ createdAt: t(2), effect: 'paid', tool: 'studio_prompt', undo: null })).returning()
      await db.insert(assistantActions).values([
        row({ createdAt: t(6), effect: 'public', tool: 'stub_public', undo: null }),
        row({ createdAt: t(3), effect: 'read' }),
        row({ createdAt: t(4), status: 'awaiting_confirmation', effect: 'paid' }),
        row({ createdAt: t(5), userId: other.id }),
      ])
      const res = await activity()
      expect(res.statusCode).toBe(200)
      const body = res.json()
      expect(body.items.map((i: any) => i.effect)).toEqual(['public', 'paid', 'write'])
      expect(body.items.map((i: any) => i.id).slice(1)).toEqual([p.id, w.id])
      expect(body.next).toBeNull()
      expect(body.items[2]).toMatchObject({ canUndo: true, effect: 'write', conversationId: null, createdAt: t(1).toISOString(), status: 'done' })
      expect(body.items[1]).toMatchObject({ canUndo: false, effect: 'paid' })
      expect(body.items[1]).not.toHaveProperty('undo')
    })

    it('pages with next and before without repeats or gaps, even for rows made in the same millisecond', async () => {
      const same = new Date(Date.UTC(2026, 10, 1, 0, 0, 0, 5))
      const ids: string[] = []
      for (let i = 0; i < 5; i++) ids.push((await db.insert(assistantActions).values(row({ createdAt: same })).returning())[0].id)
      await db.insert(assistantActions).values(row({ createdAt: new Date(Date.UTC(2026, 10, 1, 0, 0, 1)) }))
      const seen: string[] = []
      let before = ''
      for (let guard = 0; guard < 10; guard++) {
        const body = (await activity(`?limit=2${before}`)).json()
        seen.push(...body.items.map((i: any) => i.id))
        if (!body.next) break
        before = `&before=${encodeURIComponent(body.next)}`
      }
      expect(seen).toHaveLength(6)
      expect(new Set(seen).size).toBe(6)
      expect(new Set(seen.slice(1))).toEqual(new Set(ids))
    })

    it('has no next on a last page that is exactly full', async () => {
      for (let i = 0; i < 4; i++) await db.insert(assistantActions).values(row({ createdAt: new Date(Date.UTC(2026, 10, 1, 0, 0, i)) }))
      const first = (await activity('?limit=2')).json()
      expect(first.items).toHaveLength(2)
      expect(first.next).toEqual(expect.any(String))
      const last = (await activity(`?limit=2&before=${encodeURIComponent(first.next)}`)).json()
      expect(last.items).toHaveLength(2)
      expect(last.next).toBeNull()
      expect((await activity('?limit=4')).json().next).toBeNull()
    })

    it('accepts a plain ISO date for before', async () => {
      await db.insert(assistantActions).values([row({ createdAt: new Date('2026-11-01T00:00:00Z') }), row({ createdAt: new Date('2026-11-03T00:00:00Z') })])
      const body = (await activity('?before=2026-11-02T00:00:00.000Z')).json()
      expect(body.items).toHaveLength(1)
    })

    it('rejects a bad before or limit with 400', async () => {
      for (const qs of ['?before=yesterday', '?limit=0', '?limit=101', '?limit=abc', '?before=2026-11-01T00:00:00.000Z_nope']) {
        const res = await activity(qs)
        expect(res.statusCode, qs).toBe(400)
        expect(typeof res.json().message).toBe('string')
      }
    })

    it('works for a locked or hidden account like Undo, but not when switched off', async () => {
      await db.insert(assistantActions).values(row())
      set('billingEnabled', true)
      expect((await activity()).statusCode).toBe(200)
      set('assistantAudience', 'admins')
      expect((await activity()).json().items).toHaveLength(1)
      set('assistantEnabled', false)
      expect((await activity()).statusCode).toBe(404)
    })
  })
})
