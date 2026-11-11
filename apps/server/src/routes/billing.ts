/**
 * Billing Routes — Stripe subscription management.
 *
 * POST /api/billing/checkout     — Create Stripe Checkout session for upgrade
 * POST /api/billing/portal       — Create Stripe Customer Portal session
 * GET  /api/billing/plans        — Each plan's limits, price and whether it can be bought
 * GET  /api/billing/subscription — Get current subscription + tier limits
 * GET  /api/billing/usage        — Get current usage vs limits
 * POST /api/billing/webhook      — Stripe webhook (not JWT-authenticated)
 */

import { FastifyInstance } from 'fastify'
import { and, eq, gte, sql } from 'drizzle-orm'
import { db } from '../db/connection.js'
import { scenes, streamingServers, streamingSessions } from '../db/schema.js'
import { liveScene } from '../scenes/live.js'
import { authenticate } from '../middleware/auth.js'
import { config } from '../config.js'
import { storageUsedBytes } from '../media/quota.js'
import { verifyWebhookEvent } from '../billing/webhook-verify.js'
import { recordJobFailure } from '../errors/record.js'
import {
  createCheckoutSession,
  createPortalSession,
  handleWebhookEvent,
  getSubscription,
  limitsForJson,
  PAID_TIERS,
  planPrices,
  priceIdFor,
  TIER_LIMITS,
  type PaidTier,
} from '../integrations/stripe.js'

/** Where Stripe sends people back to: Settings, where Billing & Usage is. */
const settingsUrl = () => `${config.webAppUrl.replace(/\/$/, '')}/settings`

export default async function billingRoutes(app: FastifyInstance) {
  // ── Create Checkout Session ───────────────────────────────────────────
  // By plan name: the price is the server's (STRIPE_PRICE_<PLAN>), never the page's. Stripe sends people back to
  // Settings, the page they started from.
  app.post(
    '/api/billing/checkout',
    { preHandler: [authenticate] },
    async (request, reply) => {
      if (!config.billingEnabled) {
        return reply.status(403).send({ error: 'Billing is not enabled on this instance' })
      }
      const tier = (request.body as { tier?: unknown } | null)?.tier
      if (typeof tier !== 'string' || !(PAID_TIERS as readonly string[]).includes(tier)) {
        return reply.status(400).send({ error: `tier must be ${PAID_TIERS.join(', ')}` })
      }
      const priceId = priceIdFor(tier as PaidTier)
      if (!priceId) {
        return reply.status(503).send({ error: 'This plan can’t be bought yet. Please try again later.', code: 'plan_unavailable' })
      }
      const result = await createCheckoutSession({
        userId: request.user.id,
        email: request.user.email || '',
        priceId,
        successUrl: `${settingsUrl()}?billing=success`,
        cancelUrl: `${settingsUrl()}?billing=canceled`,
      })
      return reply.send(result)
    },
  )

  // ── Create Portal Session ─────────────────────────────────────────────
  app.post(
    '/api/billing/portal',
    { preHandler: [authenticate] },
    async (request, reply) => {
      if (!config.billingEnabled) {
        return reply.status(403).send({ error: 'Billing is not enabled on this instance' })
      }
      const result = await createPortalSession({ userId: request.user.id, returnUrl: settingsUrl() })
      return reply.send(result)
    },
  )

  // ── Plans ─────────────────────────────────────────────────────────────
  // What each plan gives (the limits the server enforces) and costs (from Stripe), so the page can't drift from them.
  // `available`: it can be bought here (its price is set). Unlimited limits are null.
  app.get(
    '/api/billing/plans',
    { preHandler: [authenticate] },
    async () => {
      if (!config.billingEnabled) return { billingEnabled: false, plans: [] }
      const prices = await planPrices()
      return {
        billingEnabled: true,
        plans: (['free', ...PAID_TIERS, 'enterprise'] as const).map((tier) => ({
          tier,
          limits: limitsForJson(TIER_LIMITS[tier]),
          price: tier === 'free' || tier === 'enterprise' ? null : prices[tier],
          available: tier === 'free' || tier === 'enterprise' || !!priceIdFor(tier),
        })),
      }
    },
  )

  // ── Get Subscription ──────────────────────────────────────────────────
  app.get(
    '/api/billing/subscription',
    { preHandler: [authenticate] },
    async (request, reply) => {
      if (!config.billingEnabled) {
        return reply.send({
          tier: 'studio', // self-hosted gets everything
          status: 'active',
          billingEnabled: false,
          limits: null,
        })
      }

      const sub = await getSubscription(request.user.id)
      return reply.send(sub)
    },
  )

  // ── Get Usage ─────────────────────────────────────────────────────────
  app.get(
    '/api/billing/usage',
    { preHandler: [authenticate] },
    async (request, reply) => {
      const sub = await getSubscription(request.user.id)

      // Count scenes
      const [sceneCount] = await db
        .select({ count: sql<number>`count(*)` })
        .from(scenes)
        .where(and(eq(scenes.ownerId, request.user.id), liveScene()))

      // Storage used: the same total the upload quota checks (Images & Video, 3D Models uploads, thumbnails)
      const storageBytes = await storageUsedBytes(request.user.id)

      // Streaming minutes this billing period, on the caller's own streaming servers. A Date goes in through gte(), not
      // a raw sql fragment: the driver refuses a Date there (that threw a 500 for every paid plan)
      let streamMinutes = 0
      if (sub.tier !== 'free') {
        const periodStart = (sub as { currentPeriodStart?: Date | null }).currentPeriodStart ?? new Date(0)
        const [streamSum] = await db
          .select({ total: sql<number>`coalesce(sum(${streamingSessions.durationSeconds}), 0)` })
          .from(streamingSessions)
          .innerJoin(streamingServers, eq(streamingServers.id, streamingSessions.serverId))
          .where(and(eq(streamingServers.ownerId, request.user.id), gte(streamingSessions.startedAt, periodStart)))

        streamMinutes = Math.ceil(Number(streamSum.total) / 60)
      }

      return reply.send({
        tier: sub.tier,
        usage: {
          scenes: Number(sceneCount.count),
          storageBytes,
          streamMinutes,
        },
        limits: sub.limits,
      })
    },
  )

  // ── Stripe Webhook ────────────────────────────────────────────────────
  // NOT authenticated via JWT — uses Stripe signature verification
  app.post('/api/billing/webhook', {
    handler: async (request, reply) => {
      if (!config.billingEnabled || !config.stripeSecretKey) {
        return reply.status(404).send({ error: 'Billing not enabled' })
      }

      const verified = await verifyWebhookEvent(
        (request as any).rawBody,
        request.headers['stripe-signature'] as string | undefined,
        {
          secret: config.stripeWebhookSecret,
          stripeKey: config.stripeSecretKey,
          mode: config.mode,
          nodeEnv: process.env.NODE_ENV,
        },
      )
      if (!verified.ok) {
        request.log.warn({ status: verified.status }, verified.error)
        return reply.status(verified.status).send({ error: verified.error })
      }
      const event = verified.event as any

      try {
        await handleWebhookEvent(event)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        recordJobFailure(`payment_webhook ${String(event?.type ?? 'unknown').slice(0, 60)}`, err)
        return reply.status(500).send({ error: `Webhook processing failed: ${message}` })
      }

      return reply.send({ received: true })
    },
  })
}
