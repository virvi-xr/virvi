import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '../src/db/connection.js'
import { users, studioTrialSpendDays } from '../src/db/schema.js'
import { config } from '../src/config.js'
import { TRIAL_DAY, reservePrompt, refundPrompt, recordCost, promptStatus, usageDay } from '../src/studio/quota.js'
import { memoryStudioStore, setStudioStore } from '../src/studio/store.js'
import { setMachineDeps } from '../src/studio/machines.js'
import { issueTrialSession } from '../src/auth/trial.js'
import { resetDb } from './helpers/db.js'
import { testApp, createUser } from './helpers/factories.js'
import { fakeFly } from './helpers/studio.js'

const DAY1 = new Date('2026-11-05T12:00:00Z')
const DAY2 = new Date('2026-11-06T12:00:00Z')

async function makeTrial() {
  const u = await createUser({ email: null })
  await db.update(users).set({ isTrial: true, trialLastActiveAt: new Date() }).where(eq(users.id, u.id))
  return u
}

describe('trial quota', () => {
  beforeEach(resetDb)

  it('a trial gets 3 prompts in total, not per day', async () => {
    const u = await makeTrial()
    expect(await usageDay(u.id, DAY1)).toBe(TRIAL_DAY)
    for (let i = 0; i < 3; i++) expect(await reservePrompt(u.id, DAY1, { counted: true })).toEqual({ ok: true, day: TRIAL_DAY, from: 'allowance' })
    expect(await reservePrompt(u.id, DAY2, { counted: true })).toEqual({ ok: false, reason: 'allowance' })
    expect(await promptStatus(u.id, DAY2)).toMatchObject({ plan: 'trial', allowance: 3, used: 3, left: 0, trial: true, resetsAt: null })
  })

  it('two reservations at once on the last prompt: only one passes', async () => {
    const u = await makeTrial()
    for (let i = 0; i < 2; i++) await reservePrompt(u.id, DAY1, { counted: true })
    const rs = await Promise.all([reservePrompt(u.id, DAY1, { counted: true }), reservePrompt(u.id, DAY1, { counted: true })])
    expect(rs.filter((r) => r.ok)).toHaveLength(1)
  })

  it('the trial cost ceiling holds', async () => {
    const u = await makeTrial()
    await recordCost(u.id, TRIAL_DAY, 3.0)
    expect(await reservePrompt(u.id, DAY1, { counted: true })).toEqual({ ok: false, reason: 'cost_ceiling' })
  })

  it('gifts and credits never apply to a trial', async () => {
    const u = await makeTrial()
    await db.execute(`INSERT INTO studio_prompt_credits (user_id, balance, gifted) VALUES ('${u.id}', 5, 5)` as any)
    for (let i = 0; i < 3; i++) await reservePrompt(u.id, DAY1, { counted: true })
    expect(await reservePrompt(u.id, DAY1, { counted: true })).toEqual({ ok: false, reason: 'allowance' })
    expect(await promptStatus(u.id, DAY1)).toMatchObject({ credits: 0, gifted: 0 })
  })

  it("the global trial budget stops new trial prompts but not accounts'", async () => {
    const t = await makeTrial()
    const acct = await createUser()
    await db.insert(studioTrialSpendDays).values({ day: DAY1.toISOString().slice(0, 10), costUsd: config.trialDailyBudgetUsd })
    expect(await reservePrompt(t.id, DAY1, { counted: true })).toEqual({ ok: false, reason: 'trial_busy' })
    expect((await reservePrompt(acct.id, DAY1, { counted: true })).ok).toBe(true)
  })

  it("a trial's cost also adds to today's global spend", async () => {
    const t = await makeTrial()
    await recordCost(t.id, TRIAL_DAY, 1.5)
    const today = new Date().toISOString().slice(0, 10)
    const [row] = await db.select().from(studioTrialSpendDays).where(eq(studioTrialSpendDays.day, today))
    expect(row.costUsd).toBe(1.5)
  })

  it('a refunded trial prompt comes back', async () => {
    const u = await makeTrial()
    for (let i = 0; i < 3; i++) await reservePrompt(u.id, DAY1, { counted: true })
    await refundPrompt(u.id, TRIAL_DAY, 'allowance')
    expect((await reservePrompt(u.id, DAY2, { counted: true })).ok).toBe(true)
  })
})

describe('trial studio routes', () => {
  let app: Awaited<ReturnType<typeof testApp>>
  const prev = { enabled: config.studioEnabled, image: config.studioWorkerImage }
  beforeAll(() => {
    ;(config as any).studioEnabled = true
    ;(config as any).studioWorkerImage = 'registry.fly.io/vlm-studio-worker:test'
  })
  afterAll(() => {
    ;(config as any).studioEnabled = prev.enabled
    ;(config as any).studioWorkerImage = prev.image
    setStudioStore(null)
    setMachineDeps(null)
  })
  beforeEach(async () => {
    await resetDb()
    setStudioStore(memoryStudioStore())
    setMachineDeps({ fly: fakeFly() })
    app = await testApp()
  })

  async function trialHeaders() {
    const u = await makeTrial()
    const s = issueTrialSession(app, { id: u.id, displayName: u.displayName, role: 'creator', trialLastActiveAt: new Date() })
    return { authorization: `Bearer ${s.accessToken}` }
  }

  it('a trial creates a design (201) and lists it back (200)', async () => {
    const headers = await trialHeaders()
    const c = await app.inject({ method: 'POST', url: '/api/studio/designs', headers, payload: { kind: 'wearable', agent: 'claude' } })
    expect(c.statusCode).toBe(201)
    const l = await app.inject({ method: 'GET', url: '/api/studio/designs', headers })
    expect(l.statusCode).toBe(200)
    expect(l.json()).toHaveLength(1)
  })

  it('a third design is refused with account_required / more_designs, archived ones included', async () => {
    const headers = await trialHeaders()
    const make = () => app.inject({ method: 'POST', url: '/api/studio/designs', headers, payload: { kind: 'wearable', agent: 'claude' } })
    const a = await make()
    expect((await make()).statusCode).toBe(201)
    await app.inject({ method: 'PATCH', url: `/api/studio/designs/${a.json().id}`, headers, payload: { archived: true } })
    const third = await make()
    expect(third.statusCode).toBe(403)
    expect(third.json()).toMatchObject({ error: 'account_required', action: 'more_designs' })
  })

  it('usage shows trial, 3 left and the trial design limit', async () => {
    const headers = await trialHeaders()
    const r = await app.inject({ method: 'GET', url: '/api/studio/usage', headers })
    expect(r.statusCode).toBe(200)
    expect(r.json()).toMatchObject({ trial: true, left: 3, promptsLeft: 3, openDesignLimit: 2, resetsAt: null })
  })

  it('prompt route: out of prompts is account_required, a spent budget is trial_busy', async () => {
    const headers = await trialHeaders()
    const d = (await app.inject({ method: 'POST', url: '/api/studio/designs', headers, payload: { kind: 'wearable', agent: 'claude' } })).json()
    const id = (await app.inject({ method: 'GET', url: '/api/studio/designs', headers })).json()[0].id
    expect(id).toBe(d.id)
    await db.insert(studioTrialSpendDays).values({ day: new Date().toISOString().slice(0, 10), costUsd: config.trialDailyBudgetUsd })
    const busy = await app.inject({ method: 'POST', url: `/api/studio/designs/${id}/prompts`, headers, payload: { text: 'a cap' } })
    expect(busy.statusCode).toBe(429)
    expect(busy.json()).toEqual({ error: 'trial_busy', message: 'Free tries are busy right now — create an account to keep going.' })
    await db.delete(studioTrialSpendDays)
    const [{ id: uid }] = await db.select({ id: users.id }).from(users)
    for (let i = 0; i < 3; i++) await reservePrompt(uid, new Date(), { counted: true })
    const out = await app.inject({ method: 'POST', url: `/api/studio/designs/${id}/prompts`, headers, payload: { text: 'a cap' } })
    expect(out.statusCode).toBe(403)
    expect(out.json()).toEqual({ error: 'account_required', action: 'more_prompts' })
  })
  it('a trial at its cost ceiling is account_required, not cost_ceiling', async () => {
    const headers = await trialHeaders()
    await app.inject({ method: 'POST', url: '/api/studio/designs', headers, payload: { kind: 'wearable', agent: 'claude' } })
    const id = (await app.inject({ method: 'GET', url: '/api/studio/designs', headers })).json()[0].id
    const [{ id: uid }] = await db.select({ id: users.id }).from(users)
    await recordCost(uid, TRIAL_DAY, config.trialCostCeilingUsd)
    const res = await app.inject({ method: 'POST', url: `/api/studio/designs/${id}/prompts`, headers, payload: { text: 'a cap' } })
    expect([res.statusCode, res.json()]).toEqual([403, { error: 'account_required', action: 'more_prompts' }])
  })
})
