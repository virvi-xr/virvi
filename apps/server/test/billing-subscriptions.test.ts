// Plan subscriptions from Stripe webhooks, in the shapes of the API version the server pins (2026-10-28.endive):
// since 2025-03-31.basil a subscription's billing period is on its items, and an invoice names its subscription under
// parent.subscription_details.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '../src/db/connection.js'
import { subscriptions } from '../src/db/schema.js'
import { handleWebhookEvent, setStripe, STRIPE_API_VERSION } from '../src/integrations/stripe.js'
import { resetDb } from './helpers/db.js'
import { createUser, type TestUser } from './helpers/factories.js'

const START = 1_794_000_000
const END = START + 30 * 86_400
/** A subscription as Stripe sends it now: no top-level current_period_*; each item carries its own period. */
const sub = (over: Record<string, unknown> = {}) => ({
  id: 'sub_1', object: 'subscription', status: 'active', cancel_at_period_end: false,
  items: { data: [{ price: { id: 'price_creator' }, current_period_start: START, current_period_end: END }] }, ...over,
})
const invoice = (subscription: string | null) => ({
  id: 'in_1', object: 'invoice',
  parent: subscription ? { type: 'subscription_details', subscription_details: { subscription } } : null,
})
const event = (type: string, object: unknown) => ({ id: `evt_${type}`, type, data: { object } })
const row = async (userId: string) => (await db.select().from(subscriptions).where(eq(subscriptions.userId, userId)))[0]

describe('plan subscriptions from Stripe webhooks', () => {
  let user: TestUser
  const price = process.env.STRIPE_PRICE_CREATOR

  beforeEach(async () => {
    await resetDb()
    process.env.STRIPE_PRICE_CREATOR = 'price_creator'
    user = await createUser()
    await db.insert(subscriptions).values({ userId: user.id, stripeCustomerId: 'cus_1', tier: 'free', status: 'active' })
    setStripe({ subscriptions: { retrieve: async (id: string) => sub({ id }) } })
  })
  afterEach(() => {
    setStripe(null)
    if (price === undefined) delete process.env.STRIPE_PRICE_CREATOR
    else process.env.STRIPE_PRICE_CREATOR = price
  })

  it('pins the API version the webhook destination must use', () => {
    expect(STRIPE_API_VERSION).toBe('2026-10-28.endive')
  })

  it('a completed subscription checkout activates the plan with the period from its item', async () => {
    await handleWebhookEvent(event('checkout.session.completed', {
      object: 'checkout.session', mode: 'subscription', subscription: 'sub_1', customer: 'cus_1', metadata: { vlm_user_id: user.id },
    }))
    const r = await row(user.id)
    expect(r).toMatchObject({ stripeSubscriptionId: 'sub_1', tier: 'creator', status: 'active', cancelAtPeriodEnd: false })
    expect(r.currentPeriodStart?.getTime()).toBe(START * 1000)
    expect(r.currentPeriodEnd?.getTime()).toBe(END * 1000)
  })

  it('an updated subscription takes the period from its item', async () => {
    await db.update(subscriptions).set({ stripeSubscriptionId: 'sub_1', tier: 'creator' }).where(eq(subscriptions.userId, user.id))
    await handleWebhookEvent(event('customer.subscription.updated', sub({ status: 'past_due', cancel_at_period_end: true })))
    const r = await row(user.id)
    expect(r).toMatchObject({ status: 'past_due', cancelAtPeriodEnd: true })
    expect(r.currentPeriodEnd?.getTime()).toBe(END * 1000)
  })

  it('invoice.payment_failed and invoice.paid find the subscription under parent.subscription_details', async () => {
    await db.update(subscriptions).set({ stripeSubscriptionId: 'sub_1', tier: 'creator' }).where(eq(subscriptions.userId, user.id))
    await handleWebhookEvent(event('invoice.payment_failed', invoice('sub_1')))
    expect((await row(user.id)).status).toBe('past_due')
    await handleWebhookEvent(event('invoice.paid', invoice('sub_1')))
    expect((await row(user.id)).status).toBe('active')
  })

  it('an invoice that is not for a subscription changes nothing', async () => {
    await db.update(subscriptions).set({ stripeSubscriptionId: 'sub_1', status: 'active' }).where(eq(subscriptions.userId, user.id))
    await handleWebhookEvent(event('invoice.payment_failed', invoice(null)))
    expect((await row(user.id)).status).toBe('active')
  })
})
