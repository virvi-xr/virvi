import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { config } from '../src/config.js'
import { db } from '../src/db/connection.js'
import { subscriptions } from '../src/db/schema.js'
import { clearPlanPrices, setStripe } from '../src/integrations/stripe.js'
import { resetDb } from './helpers/db.js'
import { createUser } from './helpers/factories.js'
import { affordable, assistantAccess, budgetWindow, monthlyBudgetUsd, recordAssistantUsage } from '../src/assistant/access.js'
import { callCostUsd, modelPrice } from '../src/assistant/pricing.js'

const d = (s: string) => new Date(s)
const PRICES: Record<string, { unit_amount: number; interval: string }> = {
  price_creator: { unit_amount: 1900, interval: 'month' },
  price_pro: { unit_amount: 4900, interval: 'month' },
  price_creator_yr: { unit_amount: 19000, interval: 'year' },
}

describe('assistant pricing', () => {
  it('prices known models and throws on unknown ones', () => {
    expect(modelPrice('claude-sonnet-5-5')).toEqual({ inPerMTok: 2, outPerMTok: 10, cacheReadPerMTok: 0.2, cacheWritePerMTok: 2.5 })
    expect(modelPrice('claude-opus-5-5').outPerMTok).toBe(20)
    expect(() => modelPrice('claude-nope')).toThrow(/claude-nope/)
  })
  it('costs a call including cache tokens', () => {
    const c = callCostUsd('claude-sonnet-5-5', { input_tokens: 1_000_000, output_tokens: 100_000, cache_read_input_tokens: 1_000_000, cache_creation_input_tokens: null })
    expect(c).toBeCloseTo(2 + 1 + 0.2, 10)
  })
})

describe('budget math', () => {
  it('monthly window is the billing period', () => {
    const w = budgetWindow(d('2026-11-05T10:00:00Z'), d('2026-12-05T10:00:00Z'), 'month', d('2026-11-20T00:00:00Z'))
    expect(w).toEqual({ start: d('2026-11-05T10:00:00Z'), end: d('2026-12-05T10:00:00Z') })
  })
  it('annual window anchored on the 31st clamps in February', () => {
    const ps = d('2026-01-31T00:00:00Z'), pe = d('2027-01-31T00:00:00Z')
    expect(budgetWindow(ps, pe, 'year', d('2026-02-10T00:00:00Z'))).toEqual({ start: d('2026-01-31T00:00:00Z'), end: d('2026-02-28T00:00:00Z') })
    expect(budgetWindow(ps, pe, 'year', d('2026-02-28T12:00:00Z'))).toEqual({ start: d('2026-02-28T00:00:00Z'), end: d('2026-03-31T00:00:00Z') })
  })
  it('annual window anchored on the 15th', () => {
    const ps = d('2026-03-15T00:00:00Z'), pe = d('2027-03-15T00:00:00Z')
    expect(budgetWindow(ps, pe, 'year', d('2026-07-20T00:00:00Z'))).toEqual({ start: d('2026-07-15T00:00:00Z'), end: d('2026-08-15T00:00:00Z') })
    expect(budgetWindow(ps, pe, 'year', d('2026-07-14T23:59:59Z'))).toEqual({ start: d('2026-06-15T00:00:00Z'), end: d('2026-07-15T00:00:00Z') })
  })
  it('annual window clamps a now outside the period', () => {
    const ps = d('2026-03-15T00:00:00Z'), pe = d('2027-03-15T00:00:00Z')
    expect(budgetWindow(ps, pe, 'year', d('2026-01-01T00:00:00Z'))).toEqual({ start: ps, end: d('2026-04-15T00:00:00Z') })
    expect(budgetWindow(ps, pe, 'year', d('2027-06-01T00:00:00Z'))).toEqual({ start: d('2027-02-15T00:00:00Z'), end: pe })
  })
  it('budgets 70% of the monthly payment', () => {
    expect(monthlyBudgetUsd(1900, 'month')).toBeCloseTo(13.3, 10)
    expect(monthlyBudgetUsd(19000, 'year')).toBeCloseTo(11.0833, 4)
  })
})

describe('assistantAccess', () => {
  const NOW = d('2026-11-20T12:00:00Z')
  const prev = {
    enabled: config.assistantEnabled, audience: config.assistantAudience, billing: config.billingEnabled, adminBudget: config.assistantAdminBudgetUsd,
    creator: process.env.STRIPE_PRICE_CREATOR, pro: process.env.STRIPE_PRICE_PRO,
  }
  const set = (k: string, v: unknown) => { ;(config as any)[k] = v }
  beforeEach(async () => {
    await resetDb()
    set('assistantEnabled', true); set('assistantAudience', 'paid'); set('billingEnabled', true)
    process.env.STRIPE_PRICE_CREATOR = 'price_creator'
    process.env.STRIPE_PRICE_PRO = 'price_pro'
    clearPlanPrices()
    setStripe({ prices: { retrieve: async (id: string) => {
      const p = PRICES[id]
      return { unit_amount: p.unit_amount, currency: 'usd', recurring: { interval: p.interval } }
    } } })
  })
  afterEach(() => {
    set('assistantEnabled', prev.enabled); set('assistantAudience', prev.audience); set('billingEnabled', prev.billing); set('assistantAdminBudgetUsd', prev.adminBudget)
    for (const [k, v] of [['STRIPE_PRICE_CREATOR', prev.creator], ['STRIPE_PRICE_PRO', prev.pro]] as const) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
    setStripe(null); clearPlanPrices()
  })

  const authUser = (u: { id: string; email: string | null; role: string }, extra: object = {}) => ({ id: u.id, email: u.email, role: u.role, orgId: null, kind: 'account' as const, ...extra })
  async function subscribe(userId: string, tier: 'creator' | 'pro' | 'free' | 'studio', over: Partial<typeof subscriptions.$inferInsert> = {}) {
    await db.delete(subscriptions)
    await db.insert(subscriptions).values({
      userId, tier, status: 'active', currentPeriodStart: d('2026-11-05T00:00:00Z'), currentPeriodEnd: d('2026-12-05T00:00:00Z'), ...over,
    })
  }
  const use = (userId: string, day: string, cost: number) => recordAssistantUsage(userId, d(`${day}T10:00:00Z`), { input_tokens: 10, output_tokens: 5 }, cost, true)

  it('gives a Creator monthly user a full budget resetting at the period end', async () => {
    const u = await createUser(); await subscribe(u.id, 'creator')
    const a = await assistantAccess(authUser(u), NOW)
    expect(a).toMatchObject({ state: 'ok', budget: { percentLeft: 100, warn: false, resetsAt: '2026-12-05T00:00:00.000Z' } })
    expect(a.budgetUsd).toBeCloseTo(13.3, 10)
  })

  it('does not count usage from a previous period after renewal', async () => {
    const u = await createUser(); await subscribe(u.id, 'creator')
    await use(u.id, '2026-10-20', 13)
    expect((await assistantAccess(authUser(u), d('2026-10-25T00:00:00Z'))).state).toBe('ok')
    await use(u.id, '2026-11-10', 6.65)
    expect((await assistantAccess(authUser(u), NOW)).budget).toMatchObject({ percentLeft: 50 })
    await subscribe(u.id, 'creator', { currentPeriodStart: d('2026-12-05T00:00:00Z'), currentPeriodEnd: d('2027-01-05T00:00:00Z') })
    expect(await assistantAccess(authUser(u), d('2026-12-10T00:00:00Z'))).toMatchObject({ budget: { percentLeft: 100 }, spentUsd: 0 })
  })

  it('applies a downgrade at once and locks free and canceled users', async () => {
    const u = await createUser(); await subscribe(u.id, 'pro')
    expect((await assistantAccess(authUser(u), NOW)).budgetUsd).toBeCloseTo(34.3, 10)
    await subscribe(u.id, 'creator')
    expect((await assistantAccess(authUser(u), NOW)).budgetUsd).toBeCloseTo(13.3, 10)
    await subscribe(u.id, 'free')
    expect(await assistantAccess(authUser(u), NOW)).toEqual({ state: 'locked', reason: 'plan' })
    await subscribe(u.id, 'creator', { status: 'canceled' })
    expect(await assistantAccess(authUser(u), NOW)).toEqual({ state: 'locked', reason: 'plan' })
    await subscribe(u.id, 'creator', { status: 'trialing' })
    expect(await assistantAccess(authUser(u), NOW)).toEqual({ state: 'locked', reason: 'plan' })
  })

  it('locks a plan whose price is unknown', async () => {
    const u = await createUser(); await subscribe(u.id, 'studio')
    expect(await assistantAccess(authUser(u), NOW)).toEqual({ state: 'locked', reason: 'plan' })
  })

  it('budgets an annual plan by the month slice', async () => {
    process.env.STRIPE_PRICE_CREATOR = 'price_creator_yr'; clearPlanPrices()
    const u = await createUser()
    await subscribe(u.id, 'creator', { currentPeriodStart: d('2026-03-15T00:00:00Z'), currentPeriodEnd: d('2027-03-15T00:00:00Z') })
    const a = await assistantAccess(authUser(u), d('2026-07-20T00:00:00Z'))
    expect(a.budgetUsd).toBeCloseTo(11.0833, 4)
    expect(a.budget).toMatchObject({ resetsAt: '2026-08-15T00:00:00.000Z' })
  })

  it('warns at 80% and stops at 100%', async () => {
    const u = await createUser(); await subscribe(u.id, 'creator')
    await use(u.id, '2026-11-10', 13.3 * 0.815)
    const warn = await assistantAccess(authUser(u), NOW)
    expect(warn.budget).toMatchObject({ warn: true, percentLeft: 18 })
    expect(affordable(warn, 0.01)).toBe(true)
    await use(u.id, '2026-11-11', 13.3 * 0.2 + 1)
    const out = await assistantAccess(authUser(u), NOW)
    expect(out.budget).toMatchObject({ percentLeft: 0, warn: true })
    expect(affordable(out, 0.01)).toBe(false)
  })

  it('hides from non-admins and serves admins when the audience is admins', async () => {
    set('assistantAudience', 'admins')
    const u = await createUser(); await subscribe(u.id, 'creator')
    expect(await assistantAccess(authUser(u), NOW)).toEqual({ state: 'hidden' })
    const admin = await createUser({ role: 'admin' })
    set('assistantAdminBudgetUsd', 20)
    const a = await assistantAccess(authUser(admin), NOW)
    expect(a).toMatchObject({ state: 'ok', budgetUsd: 20, budget: { resetsAt: '2026-12-01T00:00:00.000Z' } })
  })

  it('has no cap without billing', async () => {
    set('billingEnabled', false)
    const u = await createUser()
    const a = await assistantAccess(authUser(u), NOW)
    expect(a).toEqual({ state: 'ok', budget: { percentLeft: 100, warn: false, resetsAt: null } })
    expect(affordable(a, 1000)).toBe(true)
  })

  it('locks trial users and hides everything when disabled', async () => {
    const u = await createUser()
    expect(await assistantAccess(authUser(u, { kind: 'trial' }), NOW)).toEqual({ state: 'locked', reason: 'trial' })
    expect(await assistantAccess(authUser(u, { trial: true }), NOW)).toEqual({ state: 'locked', reason: 'trial' })
    set('assistantEnabled', false)
    const admin = await createUser({ role: 'admin' })
    expect(await assistantAccess(authUser(admin), NOW)).toEqual({ state: 'hidden' })
    expect(await assistantAccess(authUser(u, { kind: 'trial' }), NOW)).toEqual({ state: 'hidden' })
  })

  it('adds usage into one row per day', async () => {
    const u = await createUser()
    await recordAssistantUsage(u.id, NOW, { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100 }, 0.5, true)
    await recordAssistantUsage(u.id, NOW, { input_tokens: 1, output_tokens: 2 }, 0.25, false)
    const { assistantUsage } = await import('../src/db/schema.js')
    const rows = await db.select().from(assistantUsage)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ day: '2026-11-20', messages: 1, tokensIn: 111, tokensOut: 7, costUsd: 0.75 })
  })
})
