import { describe, it, expect, beforeEach, beforeAll, afterAll, afterEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '../src/db/connection.js'
import { users, studioDesigns, trialEvents } from '../src/db/schema.js'
import { config } from '../src/config.js'
import { sweepTrials } from '../src/auth/trial-sweep.js'
import { finishOAuth } from '../src/auth/trial-convert.js'
import { flushTrialEvents } from '../src/auth/trial-events.js'
import { issueTrialSession } from '../src/auth/trial.js'
import { setTurnstileFetch } from '../src/auth/turnstile.js'
import { memoryStudioStore, setStudioStore } from '../src/studio/store.js'
import { setMachineDeps } from '../src/studio/machines.js'
import { resetDb } from './helpers/db.js'
import { testApp, createUser } from './helpers/factories.js'
import { createDesign, fakeFly } from './helpers/studio.js'

const DAY = 86400_000
const NOW = new Date('2026-11-05T12:00:00Z')

describe('trial expiry and funnel', () => {
  let app: Awaited<ReturnType<typeof testApp>>
  const prev = { enabled: config.studioEnabled, image: config.studioWorkerImage, secret: config.turnstileSecretKey }
  beforeAll(() => {
    ;(config as any).studioEnabled = true
    ;(config as any).studioWorkerImage = 'registry.fly.io/vlm-studio-worker:test'
    ;(config as any).turnstileSecretKey = 'test-secret'
  })
  afterAll(() => {
    ;(config as any).studioEnabled = prev.enabled
    ;(config as any).studioWorkerImage = prev.image
    ;(config as any).turnstileSecretKey = prev.secret
    setStudioStore(null)
    setMachineDeps(null)
  })
  beforeEach(async () => {
    await resetDb()
    setStudioStore(memoryStudioStore())
    setMachineDeps({ fly: fakeFly() })
    app = await testApp()
  })
  afterEach(async () => { setTurnstileFetch(null); await app.close() })

  async function makeTrial(idleDays: number, opts: { isTrial?: boolean } = {}) {
    const u = await createUser({ email: opts.isTrial === false ? `c${Math.random()}@t.dev` : null, name: 'Guest' })
    await db.update(users).set({ isTrial: opts.isTrial ?? true, trialLastActiveAt: new Date(NOW.getTime() - idleDays * DAY) }).where(eq(users.id, u.id))
    return u
  }
  const events = async () => { await flushTrialEvents(); return db.select().from(trialEvents) }
  const bearer = (u: { id: string; displayName: string }) => ({
    authorization: `Bearer ${issueTrialSession(app, { id: u.id, displayName: u.displayName, role: 'creator', trialLastActiveAt: new Date() }).accessToken}`,
  })

  it('expires idle trials with their designs and files', async () => {
    const old = await makeTrial(15)
    const design = await createDesign(old, { machineId: 'm1' })
    const store = memoryStudioStore()
    const deleted: string[] = []
    const realDelete = store.deletePrefix.bind(store)
    store.deletePrefix = async (p: string) => { deleted.push(p); return realDelete(p) }
    setStudioStore(store)
    const fly = fakeFly()
    fly.machines.set('m1', { state: 'started', spec: {} as any })

    const r = await sweepTrials(NOW, { fly })
    expect(r).toEqual({ expired: 1 })
    expect(await db.select().from(users).where(eq(users.id, old.id))).toEqual([])
    expect(await db.select().from(studioDesigns).where(eq(studioDesigns.id, design.id))).toEqual([])
    expect(deleted).toEqual([`designs/${design.id}/`])
    expect(fly.calls.del).toEqual(['m1'])
    expect((await events()).filter((e) => e.kind === 'expired').map((e) => e.userId)).toEqual([old.id])
  })

  it('never touches a converted account or an active trial', async () => {
    const converted = await makeTrial(20, { isTrial: false })
    const active = await makeTrial(1)
    await createDesign(active)
    expect(await sweepTrials(NOW, { fly: fakeFly() })).toEqual({ expired: 0 })
    expect(await db.select().from(users).where(eq(users.id, converted.id))).toHaveLength(1)
    expect(await db.select().from(users).where(eq(users.id, active.id))).toHaveLength(1)
  })

  it('expires at most 100 trials a run', async () => {
    await db.insert(users).values(Array.from({ length: 101 }, () => ({ displayName: 'Guest', email: null, isTrial: true, trialLastActiveAt: new Date(NOW.getTime() - 30 * DAY) })))
    expect(await sweepTrials(NOW, { fly: fakeFly() })).toEqual({ expired: 100 })
    expect(await sweepTrials(NOW, { fly: fakeFly() })).toEqual({ expired: 1 })
  })

  it('records the funnel', async () => {
    setTurnstileFetch((async () => new Response(JSON.stringify({ success: true }))) as unknown as typeof fetch)
    const started = await app.inject({ method: 'POST', url: '/api/auth/trial', headers: { 'x-forwarded-for': '10.9.0.1' }, payload: { turnstileToken: 't', deviceId: 'device-funnel-xxxxxxx' } })
    expect(started.statusCode).toBe(201)
    const { accessToken, user } = started.json()
    const headers = { authorization: `Bearer ${accessToken}` }
    expect((await events()).map((e) => [e.kind, e.userId])).toEqual([['started', user.id]])

    const d = (await app.inject({ method: 'POST', url: '/api/studio/designs', headers, payload: { kind: 'wearable', agent: 'claude' } })).json()
    const p = await app.inject({ method: 'POST', url: `/api/studio/designs/${d.id}/prompts`, headers, payload: { text: 'a cap' } })
    expect(p.statusCode).toBeLessThan(300)
    expect((await events()).filter((e) => e.kind === 'prompt').map((e) => e.userId)).toEqual([user.id])

    const b1 = await app.inject({ method: 'GET', url: '/api/scenes', headers })
    expect(b1.statusCode).toBe(403)
    const b2 = await app.inject({ method: 'GET', url: '/api/scenes', headers })
    expect(b2.statusCode).toBe(403)
    // an in-handler refusal after the first one adds none
    for (let i = 0; i < 2; i++) await app.inject({ method: 'POST', url: '/api/studio/designs', headers, payload: { kind: 'wearable', agent: 'claude' } })
    const blocked = (await events()).filter((e) => e.kind === 'blocked')
    expect(blocked).toHaveLength(1)
    expect(blocked[0]).toMatchObject({ userId: user.id, action: 'GET /api/scenes' })

    const reg = await app.inject({ method: 'POST', url: '/api/auth/register', headers, payload: { email: 'f@test.dev', password: 'hunter2hunter2', displayName: 'F', fromAction: 'more_prompts' } })
    expect(reg.statusCode).toBe(201)
    const signed = (await events()).filter((e) => e.kind === 'signed_up')
    expect(signed).toHaveLength(1)
    expect(signed[0]).toMatchObject({ userId: user.id, action: 'more_prompts' })
  })

  it('records an in-handler refusal as the first blocked, and a login merge as signed_up', async () => {
    const t = await makeTrial(0)
    const h = bearer(t)
    for (let i = 0; i < config.trialDesigns; i++) await app.inject({ method: 'POST', url: '/api/studio/designs', headers: h, payload: { kind: 'wearable', agent: 'claude' } })
    for (let i = 0; i < 2; i++) await app.inject({ method: 'POST', url: '/api/studio/designs', headers: h, payload: { kind: 'wearable', agent: 'claude' } })
    const blocked = (await events()).filter((e) => e.kind === 'blocked')
    expect(blocked.map((e) => e.action)).toEqual(['more_designs'])

    await app.inject({ method: 'POST', url: '/api/auth/register', payload: { email: 'old@test.dev', password: 'hunter2hunter2', displayName: 'Old' } })
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', headers: h, payload: { email: 'old@test.dev', password: 'hunter2hunter2', fromAction: 'upload_more' } })
    expect(login.statusCode).toBe(200)
    const signed = (await events()).filter((e) => e.kind === 'signed_up')
    expect(signed).toHaveLength(1)
    expect(signed[0]).toMatchObject({ userId: t.id, action: 'upload_more' })
  })

  it('carries fromAction through the OAuth claim ticket into signed_up', async () => {
    const t = await makeTrial(0)
    const claim = await app.inject({ method: 'POST', url: '/api/auth/trial/claim', headers: bearer(t), payload: { fromAction: 'more_prompts' } })
    expect(claim.statusCode).toBe(200)
    await finishOAuth(app, { type: 'oauth', identifier: 'google:funnel1', email: 'g@test.dev', displayName: 'G', metadata: {} }, claim.json().ticket)
    const signed = (await events()).filter((e) => e.kind === 'signed_up')
    expect(signed).toHaveLength(1)
    expect(signed[0]).toMatchObject({ userId: t.id, action: 'more_prompts' })
  })
})
