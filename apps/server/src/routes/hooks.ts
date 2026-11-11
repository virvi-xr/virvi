/**
 * Platform Hook Routes — HTTP endpoints for non-WebSocket platform integration.
 *
 * POST /hook/register  — Register/re-register a callback URL
 * GET  /hook/config    — Poll config for a single element
 * GET  /hook/scene     — Poll full scene config (all elements)
 *
 * These routes do NOT require JWT auth. Platform scripts authenticate
 * implicitly via sceneId + platform. The data returned is read-only
 * scene config (no mutations possible through these endpoints).
 */

import { FastifyInstance } from 'fastify'
import { eq, and, or, isNull, inArray, count } from 'drizzle-orm'
import { db } from '../db/connection.js'
import {
  platformCallbacks,
  scenes,
  scenePresets,
  sceneElements,
  sceneCollaborators,
  sceneRoles,
} from '../db/schema.js'
import { authenticate } from '../middleware/auth.js'
import { actorFromClaims } from '../auth/actor.js'
import { getSceneAccess, isFullAccess } from '../auth/permissions.js'
import { assertPublicHttpUrl, UnsafeUrlError } from '../net/public-url.js'
import { config } from '../config.js'

export const MAX_CALLBACKS_PER_SCENE = 20

export default async function hookRoutes(app: FastifyInstance) {
  // ── GET /api/hooks — List all platform callbacks for user's scenes ──────
  app.get(
    '/api/hooks',
    { preHandler: [authenticate] },
    async (request, reply) => {
      const actor = actorFromClaims(request.user)
      if (!actor.userId || !actor.verified) return reply.send({ hooks: [] })

      // Candidate scenes: owned, plus collaborator and role grants; keep those with full access
      const owned = await db
        .select({ id: scenes.id })
        .from(scenes)
        .where(eq(scenes.ownerId, actor.userId))
      const collabs = await db
        .select({ sceneId: sceneCollaborators.sceneId })
        .from(sceneCollaborators)
        .where(eq(sceneCollaborators.userId, actor.userId))
      const roleRows = await db
        .select({ sceneId: sceneRoles.sceneId })
        .from(sceneRoles)
        .where(
          and(
            isNull(sceneRoles.revokedAt),
            actor.wallet
              ? or(eq(sceneRoles.userId, actor.userId), eq(sceneRoles.walletAddress, actor.wallet))
              : eq(sceneRoles.userId, actor.userId),
          ),
        )
      const candidateIds = [...new Set([...owned.map((s) => s.id), ...collabs.map((c) => c.sceneId), ...roleRows.map((r) => r.sceneId)])]
      if (candidateIds.length === 0) return reply.send({ hooks: [] })

      const candidates = await db
        .select({ id: scenes.id, name: scenes.name })
        .from(scenes)
        .where(inArray(scenes.id, candidateIds))
      const userScenes: { id: string; name: string }[] = []
      for (const scene of candidates) {
        if (isFullAccess(await getSceneAccess(actor, scene.id))) userScenes.push(scene)
      }

      if (userScenes.length === 0) {
        return reply.send({ hooks: [] })
      }

      const sceneIds = userScenes.map((s) => s.id)
      const sceneNameMap = Object.fromEntries(userScenes.map((s) => [s.id, s.name]))

      const callbacks = await db
        .select()
        .from(platformCallbacks)
        .where(inArray(platformCallbacks.sceneId, sceneIds))

      const hooks = callbacks.map((cb) => ({
        id: cb.id,
        sceneId: cb.sceneId,
        sceneName: sceneNameMap[cb.sceneId] || 'Unknown',
        platform: cb.platform,
        callbackUrl: cb.callbackUrl,
        elementId: cb.elementId,
        elementType: cb.elementType,
        mode: cb.mode,
        region: cb.region,
        metadata: cb.metadata,
        failureCount: cb.failureCount,
        lastRegistered: cb.lastRegistered,
      }))

      return reply.send({ hooks })
    },
  )

  // ── DELETE /api/hooks/:hookId — Delete a specific callback ──────────────
  app.delete<{ Params: { hookId: string } }>(
    '/api/hooks/:hookId',
    { preHandler: [authenticate] },
    async (request, reply) => {
      const { hookId } = request.params

      // Find the callback
      const [callback] = await db
        .select()
        .from(platformCallbacks)
        .where(eq(platformCallbacks.id, hookId))
        .limit(1)

      if (!callback) {
        return reply.status(404).send({ error: 'Hook not found' })
      }

      // Hooks are managed by anyone with full access to the scene
      const access = await getSceneAccess(actorFromClaims(request.user), callback.sceneId)
      if (access.level === 'none') {
        return reply.status(404).send({ error: 'Hook not found' })
      }
      if (!isFullAccess(access)) {
        return reply.status(403).send({ error: 'You do not have full access to the scene this hook belongs to' })
      }

      await db
        .delete(platformCallbacks)
        .where(eq(platformCallbacks.id, hookId))

      return reply.status(204).send()
    },
  )


  // ── POST /hook/register ─────────────────────────────────────────────────
  app.post('/hook/register', async (request, reply) => {
    const body = request.body as {
      sceneId: string
      elementId?: string
      elementType?: string
      callbackUrl: string
      platform: string
      mode?: string
      region?: string
      metadata?: Record<string, unknown>
    }

    if (!body.sceneId || !body.callbackUrl || !body.platform) {
      return reply.status(400).send({
        error: 'Missing required fields: sceneId, callbackUrl, platform',
      })
    }

    try {
      await assertPublicHttpUrl(body.callbackUrl, { allowPrivate: config.allowPrivateCallbackUrls })
    } catch (err) {
      if (err instanceof UnsafeUrlError) {
        return reply.status(400).send({ error: 'callback_url_not_allowed' })
      }
      throw err
    }

    const mode = body.mode || 'element'

    // Upsert: match on scene + element + type + platform
    // Check for existing callback
    const existing = await db
      .select()
      .from(platformCallbacks)
      .where(
        and(
          eq(platformCallbacks.sceneId, body.sceneId),
          eq(platformCallbacks.platform, body.platform),
          eq(platformCallbacks.callbackUrl, body.callbackUrl),
        ),
      )
      .limit(1)

    if (existing.length > 0) {
      // Re-register: update timestamp, reset failure count
      await db
        .update(platformCallbacks)
        .set({
          lastRegistered: new Date(),
          failureCount: 0,
          elementId: body.elementId || null,
          elementType: body.elementType || null,
          mode,
          region: body.region || null,
          metadata: body.metadata || null,
        })
        .where(eq(platformCallbacks.id, existing[0].id))
    } else {
      // New registration — cap distinct callbacks per scene
      const [{ total }] = await db
        .select({ total: count() })
        .from(platformCallbacks)
        .where(eq(platformCallbacks.sceneId, body.sceneId))
      if (total >= MAX_CALLBACKS_PER_SCENE) {
        return reply.status(429).send({ error: 'too_many_callbacks' })
      }
      await db.insert(platformCallbacks).values({
        sceneId: body.sceneId,
        elementId: body.elementId || null,
        elementType: body.elementType || null,
        platform: body.platform,
        mode,
        callbackUrl: body.callbackUrl,
        region: body.region || null,
        metadata: body.metadata || null,
      })
    }

    // Return current config so the script can initialize immediately
    if (mode === 'controller') {
      return getSceneConfig(body.sceneId, reply)
    }

    if (body.elementId && body.elementType) {
      return getElementConfig(body.sceneId, body.elementId, body.elementType, reply)
    }

    // If no specific element requested, return scene config
    return getSceneConfig(body.sceneId, reply)
  })

  // ── GET /hook/config ────────────────────────────────────────────────────
  app.get('/hook/config', async (request, reply) => {
    const query = request.query as {
      sceneId?: string
      elementId?: string
      elementType?: string
    }

    if (!query.sceneId || !query.elementId || !query.elementType) {
      return reply.status(400).send({
        error: 'Missing required query params: sceneId, elementId, elementType',
      })
    }

    return getElementConfig(query.sceneId, query.elementId, query.elementType, reply)
  })

  // ── GET /hook/scene ─────────────────────────────────────────────────────
  app.get('/hook/scene', async (request, reply) => {
    const query = request.query as { sceneId?: string }

    if (!query.sceneId) {
      return reply.status(400).send({ error: 'Missing required query param: sceneId' })
    }

    return getSceneConfig(query.sceneId, reply)
  })
}

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * Get compact config for a single element (video or image).
 * Responses are kept small for SL's 16 KB limit.
 */
async function getElementConfig(
  sceneId: string,
  elementId: string,
  elementType: string,
  reply: any,
) {
  const scene = await db.query.scenes.findFirst({
    where: eq(scenes.id, sceneId),
  })

  // A deleted scene (LIV-83) answers like a missing one
  if (!scene?.activePresetId || scene.deletedAt) {
    return reply.status(404).send({ error: 'Scene not found or no active preset' })
  }

  // Find the element by customId or ID within the active preset
  const elements = await db
    .select()
    .from(sceneElements)
    .where(
      and(
        eq(sceneElements.presetId, scene.activePresetId),
        eq(sceneElements.type, elementType as any),
      ),
    )

  const element = elements.find(
    (e) => e.customId === elementId || e.id === elementId,
  )

  if (!element) {
    return reply.status(404).send({ error: 'Element not found' })
  }

  return reply.send(compactElementConfig(element))
}

/**
 * Get compact scene config (all video and image elements).
 * Strips instances (SL scripts manage their own prim positioning).
 */
async function getSceneConfig(sceneId: string, reply: any) {
  const scene = await db.query.scenes.findFirst({
    where: eq(scenes.id, sceneId),
  })

  // A deleted scene (LIV-83) answers like a missing one
  if (!scene?.activePresetId || scene.deletedAt) {
    return reply.status(404).send({ error: 'Scene not found or no active preset' })
  }

  const elements = await db
    .select()
    .from(sceneElements)
    .where(eq(sceneElements.presetId, scene.activePresetId))

  const videos = elements
    .filter((e) => e.type === 'video')
    .map(compactElementConfig)

  const images = elements
    .filter((e) => e.type === 'image')
    .map(compactElementConfig)

  return reply.send({ videos, images })
}

/**
 * Flatten an element into a compact config for hook responses.
 * Merges properties to top-level, uses `id` field, keeps only rendering-relevant data.
 */
function compactElementConfig(element: {
  id: string
  type: string
  name: string
  enabled: boolean
  customId: string | null
  properties: unknown
}): Record<string, unknown> {
  const props = (element.properties || {}) as Record<string, unknown>
  return {
    id: element.id,
    customId: element.customId || undefined,
    enabled: element.enabled,
    ...props,
  }
}
