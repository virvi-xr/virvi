import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { eq } from 'drizzle-orm'
import type { AssistantStreamEvent } from '@virvixr/shared'
import { db } from '../src/db/connection.js'
import { assistantActions, assistantConversations, assistantMessages, users, scenes } from '../src/db/schema.js'
import { config } from '../src/config.js'
import { buildApp } from '../src/app.js'
import { issueTrialSession } from '../src/auth/trial.js'
import { setAssistantModel, type ModelResult } from '../src/assistant/model.js'
import { resetDb } from './helpers/db.js'
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
      expect(again.json()).toEqual({ error: 'used' })

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
})
