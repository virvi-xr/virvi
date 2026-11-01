/**
 * Stripe Integration — Subscription lifecycle, checkout, portal, webhooks.
 *
 * When STRIPE_SECRET_KEY is not set, all exports are safe no-ops.
 * Self-hosters get everything free — billing only activates in cloud mode.
 */

import { eq } from 'drizzle-orm'
import { db } from '../db/connection.js'
import { subscriptions, users } from '../db/schema.js'
import { config } from '../config.js'

// ---------------------------------------------------------------------------
// Stripe client (lazy-loaded to avoid crash when key is missing)
// ---------------------------------------------------------------------------

let _stripe: any = null
let _override: any = null

/** Tests replace the Stripe client with a fake; null puts the real one back. */
export function setStripe(client: any): void {
  _override = client
}

export async function getStripe(): Promise<any> {
  if (_override) return _override
  if (!config.stripeSecretKey) {
    throw new Error('Stripe is not configured (STRIPE_SECRET_KEY missing)')
  }
  if (!_stripe) {
    const { default: Stripe } = await import('stripe')
    _stripe = new Stripe(config.stripeSecretKey, { apiVersion: '2024-12-18.acacia' as any })
  }
  return _stripe
}

// ---------------------------------------------------------------------------
// Tier Definitions
// ---------------------------------------------------------------------------

export type SubscriptionTier = 'free' | 'creator' | 'pro' | 'studio' | 'enterprise'

export interface TierLimits {
  scenes: number
  storageBytes: number
  deploymentsPerMonth: number
  customAssetUploads: number
  hyperfyInstances: number
  streamMinutes: number
  apiKeys: number
  analyticsRetentionDays: number
  giveawayCredits: number
  recording: boolean
  crossWorldBroadcast: boolean
  customDomain: boolean
  // Design Studio: prompts a day, the hidden daily spend that stops prompts, and designs open (not archived) at once
  studioPromptsPerDay: number
  studioDailyCostCeilingUsd: number
  studioOpenDesigns: number
}

export const TIER_LIMITS: Record<SubscriptionTier, TierLimits> = {
  free: {
    scenes: Infinity, // no plan limits scenes: the wizard and imports are open to everyone
    storageBytes: 500 * 1024 * 1024, // 500 MB
    deploymentsPerMonth: 0,
    customAssetUploads: 0,
    hyperfyInstances: 1, // one hosted world, so the wizard's Hyperfy option works for everyone
    streamMinutes: 0,
    apiKeys: 0,
    analyticsRetentionDays: 7,
    giveawayCredits: 100,
    recording: false,
    crossWorldBroadcast: false,
    customDomain: false,
    studioPromptsPerDay: 3,
    studioDailyCostCeilingUsd: 6,
    studioOpenDesigns: 1,
  },
  creator: {
    scenes: Infinity,
    storageBytes: 10 * 1024 * 1024 * 1024, // 10 GB
    deploymentsPerMonth: 10,
    customAssetUploads: 50,
    hyperfyInstances: 1,
    streamMinutes: 1000,
    apiKeys: 1,
    analyticsRetentionDays: 30,
    giveawayCredits: 1000,
    recording: false,
    crossWorldBroadcast: false,
    customDomain: false,
    studioPromptsPerDay: 15,
    studioDailyCostCeilingUsd: 30,
    studioOpenDesigns: Infinity,
  },
  pro: {
    scenes: Infinity,
    storageBytes: 50 * 1024 * 1024 * 1024, // 50 GB
    deploymentsPerMonth: 50,
    customAssetUploads: 500,
    hyperfyInstances: 3,
    streamMinutes: 5000,
    apiKeys: 5,
    analyticsRetentionDays: 90,
    giveawayCredits: 5000,
    recording: true,
    crossWorldBroadcast: false,
    customDomain: true,
    studioPromptsPerDay: 40,
    studioDailyCostCeilingUsd: 75,
    studioOpenDesigns: Infinity,
  },
  studio: {
    scenes: Infinity,
    storageBytes: 500 * 1024 * 1024 * 1024, // 500 GB
    deploymentsPerMonth: Infinity,
    customAssetUploads: Infinity,
    hyperfyInstances: 10,
    streamMinutes: Infinity,
    apiKeys: Infinity,
    analyticsRetentionDays: 365,
    giveawayCredits: 25000,
    recording: true,
    crossWorldBroadcast: true,
    customDomain: true,
    studioPromptsPerDay: 100,
    studioDailyCostCeilingUsd: 200,
    studioOpenDesigns: Infinity,
  },
  enterprise: {
    scenes: Infinity,
    storageBytes: Infinity,
    deploymentsPerMonth: Infinity,
    customAssetUploads: Infinity,
    hyperfyInstances: Infinity,
    streamMinutes: Infinity,
    apiKeys: Infinity,
    analyticsRetentionDays: Infinity,
    giveawayCredits: Infinity,
    recording: true,
    crossWorldBroadcast: true,
    customDomain: true,
    studioPromptsPerDay: 300,
    studioDailyCostCeilingUsd: 600,
    studioOpenDesigns: Infinity,
  },
}

// ---------------------------------------------------------------------------
// Price ID → Tier mapping (configured via env or hardcoded for your Stripe products)
// ---------------------------------------------------------------------------

function tierFromPriceId(priceId: string): SubscriptionTier {
  const map: Record<string, SubscriptionTier> = {
    [process.env.STRIPE_PRICE_CREATOR || 'price_creator']: 'creator',
    [process.env.STRIPE_PRICE_PRO || 'price_pro']: 'pro',
    [process.env.STRIPE_PRICE_STUDIO || 'price_studio']: 'studio',
  }
  return map[priceId] || 'free'
}

// ---------------------------------------------------------------------------
// Subscription Queries
// ---------------------------------------------------------------------------

/**
 * Get the active subscription for a user. Returns a free-tier stub if none exists.
 */
export async function getSubscription(userId: string) {
  const sub = await db.query.subscriptions.findFirst({
    where: eq(subscriptions.userId, userId),
  })

  if (!sub) {
    return {
      tier: 'free' as SubscriptionTier,
      status: 'active' as const,
      limits: TIER_LIMITS.free,
    }
  }

  return {
    ...sub,
    tier: sub.tier as SubscriptionTier,
    limits: TIER_LIMITS[sub.tier as SubscriptionTier] || TIER_LIMITS.free,
  }
}

/**
 * Get tier limits for a given tier name.
 */
export function getTierLimits(tier: string): TierLimits {
  return TIER_LIMITS[tier as SubscriptionTier] || TIER_LIMITS.free
}

// ---------------------------------------------------------------------------
// Stripe Checkout
// ---------------------------------------------------------------------------

/** The user's Stripe customer, created (with their subscription record) the first time they pay for anything. */
export async function ensureCustomer(userId: string, email: string | null | undefined): Promise<string> {
  const stripe = await getStripe()
  const sub = await db.query.subscriptions.findFirst({
    where: eq(subscriptions.userId, userId),
  })
  if (sub?.stripeCustomerId) return sub.stripeCustomerId

  const customer = await stripe.customers.create({
    email: email || undefined,
    metadata: { vlm_user_id: userId },
  })
  if (!sub) {
    await db.insert(subscriptions).values({
      userId,
      stripeCustomerId: customer.id,
      tier: 'free',
      status: 'active',
    })
  } else {
    await db
      .update(subscriptions)
      .set({ stripeCustomerId: customer.id })
      .where(eq(subscriptions.id, sub.id))
  }
  return customer.id
}

/**
 * Create a Stripe Checkout session for upgrading to a paid tier.
 */
export async function createCheckoutSession(options: {
  userId: string
  email: string
  priceId: string
  successUrl: string
  cancelUrl: string
}): Promise<{ url: string }> {
  const stripe = await getStripe()
  const customerId = await ensureCustomer(options.userId, options.email)

  const session = await stripe.checkout.sessions.create({
    customer: customerId,
    mode: 'subscription',
    line_items: [{ price: options.priceId, quantity: 1 }],
    success_url: options.successUrl,
    cancel_url: options.cancelUrl,
    metadata: { vlm_user_id: options.userId },
  })

  return { url: session.url }
}

/**
 * Create a Stripe Customer Portal session for managing subscriptions.
 */
export async function createPortalSession(options: {
  userId: string
  returnUrl: string
}): Promise<{ url: string }> {
  const stripe = await getStripe()

  const sub = await db.query.subscriptions.findFirst({
    where: eq(subscriptions.userId, options.userId),
  })

  if (!sub?.stripeCustomerId) {
    throw new Error('No Stripe customer found — user has no billing history')
  }

  const session = await stripe.billingPortal.sessions.create({
    customer: sub.stripeCustomerId,
    return_url: options.returnUrl,
  })

  return { url: session.url }
}

// ---------------------------------------------------------------------------
// Webhook Event Handlers
// ---------------------------------------------------------------------------

/**
 * Process a Stripe webhook event. Called from the billing webhook route.
 */
export async function handleWebhookEvent(event: any): Promise<void> {
  // Design Studio one-time payments (src/studio/payments.ts); imported here to keep the two modules acyclic at load
  const { handleStudioSession } = await import('../studio/payments.js')
  if (await handleStudioSession(event)) return

  switch (event.type) {
    case 'checkout.session.completed': {
      const session = event.data.object
      if (session.mode === 'subscription') {
        await activateSubscription(
          session.metadata.vlm_user_id,
          session.subscription,
          session.customer,
        )
      }
      break
    }

    case 'customer.subscription.updated': {
      const sub = event.data.object
      await updateSubscription(sub)
      break
    }

    case 'customer.subscription.deleted': {
      const sub = event.data.object
      await cancelSubscription(sub.id)
      break
    }

    case 'invoice.payment_failed': {
      const invoice = event.data.object
      await markPaymentFailed(invoice.subscription)
      break
    }

    case 'invoice.paid': {
      const invoice = event.data.object
      if (invoice.subscription) {
        await markPaymentSucceeded(invoice.subscription)
      }
      break
    }
  }
}

// ---------------------------------------------------------------------------
// Internal subscription lifecycle
// ---------------------------------------------------------------------------

async function activateSubscription(
  userId: string,
  stripeSubscriptionId: string,
  stripeCustomerId: string,
): Promise<void> {
  const stripe = await getStripe()
  const stripeSub = await stripe.subscriptions.retrieve(stripeSubscriptionId)
  const priceId = stripeSub.items.data[0]?.price?.id || ''
  const tier = tierFromPriceId(priceId)

  await db
    .update(subscriptions)
    .set({
      stripeSubscriptionId,
      stripeCustomerId,
      stripePriceId: priceId,
      tier,
      status: 'active',
      currentPeriodStart: new Date(stripeSub.current_period_start * 1000),
      currentPeriodEnd: new Date(stripeSub.current_period_end * 1000),
      cancelAtPeriodEnd: stripeSub.cancel_at_period_end,
      updatedAt: new Date(),
    })
    .where(eq(subscriptions.userId, userId))
}

async function updateSubscription(stripeSub: any): Promise<void> {
  const priceId = stripeSub.items.data[0]?.price?.id || ''
  const tier = tierFromPriceId(priceId)

  await db
    .update(subscriptions)
    .set({
      stripePriceId: priceId,
      tier,
      status: stripeSub.status,
      currentPeriodStart: new Date(stripeSub.current_period_start * 1000),
      currentPeriodEnd: new Date(stripeSub.current_period_end * 1000),
      cancelAtPeriodEnd: stripeSub.cancel_at_period_end,
      updatedAt: new Date(),
    })
    .where(eq(subscriptions.stripeSubscriptionId, stripeSub.id))
}

async function cancelSubscription(stripeSubscriptionId: string): Promise<void> {
  await db
    .update(subscriptions)
    .set({
      tier: 'free',
      status: 'canceled',
      cancelAtPeriodEnd: false,
      updatedAt: new Date(),
    })
    .where(eq(subscriptions.stripeSubscriptionId, stripeSubscriptionId))
}

async function markPaymentFailed(stripeSubscriptionId: string): Promise<void> {
  await db
    .update(subscriptions)
    .set({ status: 'past_due', updatedAt: new Date() })
    .where(eq(subscriptions.stripeSubscriptionId, stripeSubscriptionId))
}

async function markPaymentSucceeded(stripeSubscriptionId: string): Promise<void> {
  await db
    .update(subscriptions)
    .set({ status: 'active', updatedAt: new Date() })
    .where(eq(subscriptions.stripeSubscriptionId, stripeSubscriptionId))
}
