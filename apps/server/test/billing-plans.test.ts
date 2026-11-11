import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { config } from '../src/config.js'
import { clearPlanPrices, setStripe } from '../src/integrations/stripe.js'
import { resetDb } from './helpers/db.js'
import { testApp, createUser, tokenFor } from './helpers/factories.js'

describe('plans and checkout', () => {
  let app: Awaited<ReturnType<typeof testApp>>
  let sessions: any[]
  let retrieved: string[]
  const prev = { enabled: config.billingEnabled, creator: process.env.STRIPE_PRICE_CREATOR, pro: process.env.STRIPE_PRICE_PRO, studio: process.env.STRIPE_PRICE_STUDIO }
  beforeEach(async () => {
    await resetDb()
    ;(config as any).billingEnabled = true
    process.env.STRIPE_PRICE_CREATOR = 'price_real_creator'
    process.env.STRIPE_PRICE_PRO = 'price_real_pro'
    delete process.env.STRIPE_PRICE_STUDIO
    clearPlanPrices()
    sessions = []
    retrieved = []
    setStripe({
      customers: { create: async () => ({ id: 'cus_1' }) },
      checkout: { sessions: { create: async (s: any) => { sessions.push(s); return { url: 'https://checkout.stripe.test/s' } } } },
      prices: {
        retrieve: async (id: string) => {
          retrieved.push(id)
          if (id === 'price_real_pro') throw new Error('No such price')
          return { unit_amount: 1900, currency: 'usd', recurring: { interval: 'month' } }
        },
      },
    })
    app = await testApp()
  })
  afterEach(() => {
    ;(config as any).billingEnabled = prev.enabled
    for (const [k, v] of [['STRIPE_PRICE_CREATOR', prev.creator], ['STRIPE_PRICE_PRO', prev.pro], ['STRIPE_PRICE_STUDIO', prev.studio]] as const) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v
    }
    setStripe(null)
    clearPlanPrices()
  })
  const as = async () => ({ authorization: `Bearer ${tokenFor(await createUser())}` })

  it('lists each plan with the limits the server enforces, its price, and whether it can be bought', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/billing/plans', headers: await as() })
    expect(res.statusCode).toBe(200)
    const plans = Object.fromEntries(res.json().plans.map((p: any) => [p.tier, p]))
    expect(Object.keys(plans)).toEqual(['free', 'creator', 'pro', 'studio', 'enterprise'])
    expect(plans.free.limits).toMatchObject({ storageBytes: 500 * 1024 * 1024, scenes: null, studioPromptsPerDay: 3 })
    expect(plans.creator).toMatchObject({ available: true, price: { amountCents: 1900, currency: 'usd', interval: 'month' } })
    // A price Stripe can't read: buyable, but no price shown
    expect(plans.pro).toMatchObject({ available: true, price: null })
    // No price set: can't be bought
    expect(plans.studio).toMatchObject({ available: false, price: null })
    expect(plans.studio.limits.deploymentsPerMonth).toBeNull()
    // Read once, then kept
    await app.inject({ method: 'GET', url: '/api/billing/plans', headers: await as() })
    expect(retrieved).toEqual(['price_real_creator', 'price_real_pro'])
  })

  it('checkout takes a plan name and uses the server\'s price, returning to Settings', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/billing/checkout', headers: await as(), payload: { tier: 'creator' } })
    expect(res.statusCode, res.body).toBe(200)
    expect(sessions[0].line_items).toEqual([{ price: 'price_real_creator', quantity: 1 }])
    expect(sessions[0].success_url).toMatch(/\/settings\?billing=success$/)
    expect(sessions[0].cancel_url).toMatch(/\/settings\?billing=canceled$/)
  })

  it('a plan with no price set is refused readably; a made-up plan or a price id is refused', async () => {
    const studio = await app.inject({ method: 'POST', url: '/api/billing/checkout', headers: await as(), payload: { tier: 'studio' } })
    expect(studio.statusCode).toBe(503)
    expect(studio.json().code).toBe('plan_unavailable')
    expect((await app.inject({ method: 'POST', url: '/api/billing/checkout', headers: await as(), payload: { tier: 'enterprise' } })).statusCode).toBe(400)
    expect((await app.inject({ method: 'POST', url: '/api/billing/checkout', headers: await as(), payload: { priceId: 'price_cheap' } })).statusCode).toBe(400)
    expect(sessions).toHaveLength(0)
  })

  it('without billing there are no plans', async () => {
    ;(config as any).billingEnabled = false
    const res = await app.inject({ method: 'GET', url: '/api/billing/plans', headers: await as() })
    expect(res.json()).toEqual({ billingEnabled: false, plans: [] })
  })
})
