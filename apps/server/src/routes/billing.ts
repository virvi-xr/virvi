/**
 * Billing Routes — Stripe subscription management.
 *
 * POST /api/billing/checkout     — Create Stripe Checkout session for upgrade
 * POST /api/billing/portal       — Create Stripe Customer Portal session
 * GET  /api/billing/subscription — Get current subscription + tier limits
 * GET  /api/billing/usage        — Get current usage vs limits
 * POST /api/billing/webhook      — Stripe webhook (not JWT-authenticated)
 */

import { FastifyInstance } from 'fastify'
import { and, eq, sql } from 'drizzle-orm'
import { db } from '../db/connection.js'
import { scenes, streamingSessions } from '../db/schema.js'
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
} from '../integrations/stripe.js'

export default async function billingRoutes(app: FastifyInstance) {
  // ── Create Checkout Session ───────────────────────────────────────────
  app.post(
    '/api/billing/checkout',
    { preHandler: [authenticate] },
    async (request, reply) => {
      if (!config.billingEnabled) {
        return reply.status(403).send({ error: 'Billing is not enabled on this instance' })
      }

      const body = request.body as {
        priceId: string
        successUrl?: string
        cancelUrl?: string
      }

      if (!body.priceId) {
        return reply.status(400).send({ error: 'Missing required field: priceId' })
      }

      const baseUrl = config.publicUrl
      const result = await createCheckoutSession({
        userId: request.user.id,
        email: request.user.email || '',
        priceId: body.priceId,
        successUrl: body.successUrl || `${baseUrl}/billing?success=true`,
        cancelUrl: body.cancelUrl || `${baseUrl}/billing?canceled=true`,
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

      const body = request.body as { returnUrl?: string }

      const result = await createPortalSession({
        userId: request.user.id,
        returnUrl: body.returnUrl || `${config.publicUrl}/billing`,
      })

      return reply.send(result)
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

      // Sum streaming minutes this billing period
      let streamMinutes = 0
      if (sub.tier !== 'free') {
        const periodStart = (sub as any).currentPeriodStart || new Date(0)
        const [streamSum] = await db
          .select({
            total: sql<number>`coalesce(sum(${streamingSessions.durationSeconds}), 0)`,
          })
          .from(streamingSessions)
          // Sessions are linked via servers owned by the user — simplified here
          .where(sql`${streamingSessions.startedAt} >= ${periodStart}`)

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
