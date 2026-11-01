/**
 * Feature Gate Middleware
 *
 * Controls access to premium features based on deployment mode and subscription tier.
 *
 * - single/scalable mode (no Stripe): all features unlocked — middleware is a no-op
 * - cloud mode (with Stripe): checks user subscription tier against required tier
 *
 * Self-hosters get everything for free. The hosted virvi.io service gates premium
 * features behind subscriptions.
 */

import type { FastifyRequest, FastifyReply } from 'fastify'
import { config } from '../config.js'
import { getSubscription } from '../integrations/stripe.js'

/** Known features that can be gated. */
export type GatedFeature =
  | 'streaming'
  | 'deployment'
  | 'cross_world_broadcast'
  | 'analytics_export'
  | 'custom_domain'
  | 'api_keys'
  | 'recording'
  | 'hud_editing'

/** Minimum tier required for each feature. */
const FEATURE_TIERS: Record<GatedFeature, string> = {
  streaming: 'creator',
  deployment: 'free', // the wizard (including Hyperfy worlds) is open to everyone
  cross_world_broadcast: 'studio',
  analytics_export: 'pro',
  custom_domain: 'pro',
  api_keys: 'creator',
  recording: 'pro',
  hud_editing: 'creator',
}

/** Tier hierarchy — higher index means higher tier. */
const TIER_RANK: Record<string, number> = {
  free: 0,
  creator: 1,
  pro: 2,
  studio: 3,
  enterprise: 4,
}

/**
 * Create a Fastify preHandler that gates a route behind a feature.
 * When billing is disabled (self-hosted), this is a no-op.
 */
export function requireFeature(feature: GatedFeature) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    // All features unlocked in single/scalable mode (unless Stripe is configured)
    if (config.allFeaturesUnlocked) return

    // Admins always bypass feature gates
    if (request.user.role === 'admin') return

    // Query the user's actual subscription tier from the database
    const sub = await getSubscription(request.user.id)
    const userTier = sub.tier || 'free'
    const requiredTier = FEATURE_TIERS[feature] || 'pro'

    const userRank = TIER_RANK[userTier] ?? 0
    const requiredRank = TIER_RANK[requiredTier] ?? 0

    if (userRank < requiredRank) {
      return reply.status(403).send({
        error: 'upgrade_required',
        feature,
        currentTier: userTier,
        requiredTier,
      })
    }
  }
}

/**
 * Get the tier rank for comparison.
 */
export function getTierRank(tier: string): number {
  return TIER_RANK[tier] ?? 0
}
