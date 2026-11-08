import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { and, eq, inArray } from 'drizzle-orm'
import { localModelFile, validateSceneRef, type AnalyticsSceneRef } from '@virvixr/shared'
import { db } from '../db/connection.js'
import { analyticsScenes, assetLibraryItems, mediaAssets, sceneElements, scenes } from '../db/schema.js'
import { hasDclAuthHeaders, verifyDclSignedFetch } from '../middleware/dcl-auth.js'
import { resolveAnalyticsScene } from '../analytics/registry.js'
import { DirectoryUnavailableError } from '../analytics/dcl-directory.js'
import { controls, verifiedWalletsOf } from '../analytics/claims.js'
import { TokenBucketLimiter, checkRequesterLimits } from '../analytics/limiter.js'
import { getActiveSetup, releaseIfRedeployed, setUpLocation, SetupError } from '../setup/setups.js'
import { sceneRoleFor } from '../auth/scene-roles.js'
import { config } from '../config.js'

let limiter = new TokenBucketLimiter()
/** Test hook. */
export function setSetupLimiter(l: TokenBucketLimiter): void {
  limiter = l
}

/** Preview realms can be set up only on a non-cloud (local/self-hosted) server — spec §5.1. */
const previewBlocked = (ref: AnalyticsSceneRef) => ref.isPreview && config.mode === 'cloud'

const short = (w: string) => `${w.slice(0, 6)}…${w.slice(-4)}`

async function signer(request: FastifyRequest): Promise<string | null> {
  const headers = request.headers as Record<string, string | string[] | undefined>
  if (!hasDclAuthHeaders(headers)) return null
  try {
    return (await verifyDclSignedFetch(request.method, request.url.split('?')[0], headers)).walletAddress.toLowerCase()
  } catch {
    return null
  }
}

/** Location + (possibly released) active setup for a signed request. Throws DirectoryUnavailableError upstream. */
async function locate(ref: AnalyticsSceneRef, wallet: string) {
  const resolved = await resolveAnalyticsScene(ref, wallet)
  if (!resolved.ok) return { resolved, scene: null, setup: null }
  const scene = resolved.scene
  let setup = await getActiveSetup(scene.id)
  // The registry just verified the live entity; only when it moved can there be a redeploy to check.
  if (setup && scene.activeEntityId !== setup.deploymentEntityId) setup = await releaseIfRedeployed(setup, scene)
  return { resolved, scene, setup }
}

async function roleOf(sceneId: string, wallet: string): Promise<'host' | 'cohost' | 'editor' | 'viewer' | null> {
  const scene = await db.query.scenes.findFirst({ where: eq(scenes.id, sceneId) })
  if (scene && (await verifiedWalletsOf(scene.ownerId)).includes(wallet)) return 'host'
  // Signed-fetch caller: no user, so match scene roles by wallet only.
  return sceneRoleFor(sceneId, { userId: null, role: 'viewer', wallet, verified: true }, { walletOnly: true })
}

async function hostShort(sceneId: string): Promise<string> {
  const scene = await db.query.scenes.findFirst({ where: eq(scenes.id, sceneId) })
  const w = scene ? (await verifiedWalletsOf(scene.ownerId))[0] : undefined
  return w ? short(w) : 'someone else'
}

/** Signed-fetch routes (no JWT): the in-world HUD asks what to show, and sets the location up. */
export default async function setupRoutes(app: FastifyInstance) {
  app.post<{ Body: { scene?: unknown } }>('/api/setup/status', async (request, reply) => {
    const ref = validateSceneRef(request.body?.scene)
    const wallet = await signer(request)
    if (!ref || !wallet || previewBlocked(ref)) return reply.send({ state: 'none' })
    if (!checkRequesterLimits(limiter, { requesterKey: `w:${wallet}`, verified: true, eventCount: 1 }).ok) {
      return reply.status(429).send({ error: 'rate_limited' })
    }
    try {
      const { resolved, scene, setup } = await locate(ref, wallet)
      if (!scene) return reply.send({ state: !resolved.ok && resolved.status === 503 ? 'unavailable' : 'none' })
      if (setup) {
        const role = await roleOf(setup.virviSceneId, wallet)
        if (role) return reply.send({ state: 'member', sceneId: setup.virviSceneId, role })
        // Non-members still get the sceneId so the client can connect content-only (no HUD).
        return reply.send(
          (await controls(scene, wallet))
            ? { state: 'taken', host: await hostShort(setup.virviSceneId), sceneId: setup.virviSceneId }
            : { state: 'none', sceneId: setup.virviSceneId },
        )
      }
      return reply.send({ state: (await controls(scene, wallet)) ? 'eligible' : 'none' })
    } catch (err) {
      if (err instanceof DirectoryUnavailableError) return reply.send({ state: 'unavailable' })
      throw err
    }
  })

  app.post<{ Body: { scene?: unknown } }>('/api/setup', async (request, reply) => {
    const wallet = await signer(request)
    if (!wallet) return reply.status(401).send({ error: 'signed_request_required' })
    const ref = validateSceneRef(request.body?.scene)
    if (!ref) return reply.status(400).send({ error: 'scene is required' })
    if (previewBlocked(ref)) return reply.status(403).send({ error: 'not_eligible' })
    if (!checkRequesterLimits(limiter, { requesterKey: `w:${wallet}`, verified: true, eventCount: 1 }).ok) {
      return reply.status(429).send({ error: 'rate_limited' })
    }
    let scene: Awaited<ReturnType<typeof locate>>['scene'] = null
    try {
      const located = await locate(ref, wallet)
      const { resolved, setup } = located
      scene = located.scene
      if (!scene) {
        if (resolved.ok) throw new Error('unreachable')
        return reply.status(resolved.status).send(resolved.status === 503 ? { error: 'upstream_unavailable', retryAfter: 30 } : { error: resolved.error })
      }
      if (setup) return reply.status(409).send({ error: 'already_set_up', host: await hostShort(setup.virviSceneId) })
      if (!(await controls(scene, wallet))) return reply.status(403).send({ error: 'not_eligible' })
      const created = await setUpLocation(scene, wallet)
      return reply.send({ sceneId: created.virviSceneId })
    } catch (err) {
      if (err instanceof DirectoryUnavailableError) return reply.status(503).send({ error: 'upstream_unavailable', retryAfter: 30 })
      if (err instanceof SetupError) {
        const active = scene ? await getActiveSetup(scene.id) : null
        return reply.status(err.status).send({ error: err.code, host: active ? await hostShort(active.virviSceneId) : undefined })
      }
      throw err
    }
  })

  /**
   * Public location lookup shared by /api/setup/scene and /api/setup/models: gc/world keys only (no previews),
   * rate-limited per IP. Sends the error reply itself and returns null, or returns the active setup.
   */
  async function publicSetupFor(request: FastifyRequest<{ Querystring: { location?: string } }>, reply: FastifyReply) {
    const raw = typeof request.query?.location === 'string' ? request.query.location : ''
    let key: string | null = null
    if (/^gc:-?\d{1,3},-?\d{1,3}$/.test(raw)) key = raw
    else if (/^world:[a-z0-9-]+(\.[a-z0-9-]+)*\.eth$/i.test(raw)) key = raw.toLowerCase()
    // Local previews can be set up on non-cloud servers (see previewBlocked), so let sync find them there too
    else if (config.mode !== 'cloud' && /^preview:0x[0-9a-f]{40}:-?\d{1,3},-?\d{1,3}$/i.test(raw)) key = raw.toLowerCase()
    if (!key) {
      reply.status(400).send({ error: 'invalid_location' })
      return null
    }
    if (!checkRequesterLimits(limiter, { requesterKey: `ip:${request.ip}`, verified: false, eventCount: 1 }).ok) {
      reply.status(429).send({ error: 'rate_limited' })
      return null
    }
    const analytics = await db.query.analyticsScenes.findFirst({ where: eq(analyticsScenes.locationKey, key) })
    const setup = analytics ? await getActiveSetup(analytics.id) : null
    if (!setup) {
      reply.status(404).send({ error: 'not_set_up' })
      return null
    }
    return setup
  }

  /** Public: the Virvi scene for a set-up location, so guests (no signed fetch) can connect content-only. */
  app.get<{ Querystring: { location?: string } }>('/api/setup/scene', async (request, reply) => {
    const setup = await publicSetupFor(request, reply)
    if (!setup) return reply
    return reply.send({ sceneId: setup.virviSceneId })
  })

  /** Public: the hosted (.glb) models a set-up location's active preset uses, for `npx @virvixr/dcl sync`. */
  app.get<{ Querystring: { location?: string } }>('/api/setup/models', async (request, reply) => {
    const setup = await publicSetupFor(request, reply)
    if (!setup) return reply
    const scene = await db.query.scenes.findFirst({ where: eq(scenes.id, setup.virviSceneId) })
    const elements = scene?.activePresetId
      ? await db.select().from(sceneElements).where(and(eq(sceneElements.presetId, scene.activePresetId), eq(sceneElements.type, 'model')))
      : []
    const hosted = elements.flatMap((e) => {
      const url = (e.properties as { modelSrc?: unknown } | null)?.modelSrc
      const file = typeof url === 'string' ? localModelFile(url) : null
      return typeof url === 'string' && file ? [{ elementId: e.id, name: e.name, url, file }] : []
    })
    const sizes = new Map<string, number>()
    if (hosted.length) {
      const urls = [...new Set(hosted.map((m) => m.url))]
      // Models are in 3D Models (asset_library_items); older ones may still be named in media until they're moved
      const rows = await db
        .select({ url: mediaAssets.publicUrl, size: mediaAssets.sizeBytes })
        .from(mediaAssets)
        .where(inArray(mediaAssets.publicUrl, urls))
      const models = await db
        .select({ url: assetLibraryItems.cdnUrl, size: assetLibraryItems.fileSizeBytes })
        .from(assetLibraryItems)
        .where(inArray(assetLibraryItems.cdnUrl, urls))
      for (const r of [...rows, ...models]) if (r.url) sizes.set(r.url, r.size)
    }
    return reply.send({ sceneId: setup.virviSceneId, models: hosted.map((m) => ({ ...m, sizeBytes: sizes.get(m.url) ?? null })) })
  })
}
