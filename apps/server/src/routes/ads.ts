import type { FastifyInstance, FastifyRequest } from 'fastify'
import { checkAdEventBatch } from '@virvixr/shared'
import type { AdServeResponse } from '@virvixr/shared'
import { config } from '../config.js'
import { verifyDclSceneRequest, type SceneRequestContext } from '../middleware/dcl-auth.js'
import { bindSceneRequest } from '../auth/scene-binding.js'
import { selectAdsForElements } from '../ads/select.js'
import { elementsInScene, recordAdEvents } from '../ads/events.js'

const MAX_SERVE_IDS = 50

/**
 * The verified DCL scene request behind this call, or null when it is not one (unsigned, forged, or the body differs
 * from a signed hash). The web explorer signs the request but not its body; the wallet and scene are still signed, and
 * events count once per wallet per ad per level per day, so a body it chose cannot count a viewer more than once.
 */
async function signedScene(request: FastifyRequest): Promise<{ wallet: string; scene: SceneRequestContext } | null> {
  try {
    const raw = ((request as any).rawBody as string | undefined) ?? null
    return await verifyDclSceneRequest(request.method, request.url.split('?')[0], request.headers as Record<string, string | string[] | undefined>, raw, { allowUnsignedBody: true })
  } catch (err) {
    request.log.warn({ err: (err as Error).message }, 'ads: DCL scene signed fetch refused')
    return null
  }
}

async function boundSceneId(signed: { wallet: string; scene: SceneRequestContext }): Promise<string | null> {
  const preview = config.mode !== 'cloud' && /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(signed.scene.realm.hostname)
  return (await bindSceneRequest(signed.scene, signed.wallet, { preview })).sceneId
}

/** Signed-fetch routes (no JWT): a scene asks which ads to show on its spaces, and reports what players saw. Registered with raw JSON bodies. */
export default async function adRoutes(app: FastifyInstance) {
  app.post<{ Body: { elementIds?: unknown } }>('/api/ads/serve', async (request, reply) => {
    const signed = await signedScene(request)
    if (!signed) return reply.status(401).send({ error: 'signed_request_required' })
    const ids = request.body?.elementIds
    if (!Array.isArray(ids) || ids.length > MAX_SERVE_IDS || !ids.every((id) => typeof id === 'string')) {
      return reply.status(400).send({ error: `elementIds must be an array of at most ${MAX_SERVE_IDS} ids` })
    }
    const sceneId = await boundSceneId(signed)
    if (!sceneId) return reply.status(404).send({ error: 'scene_not_found' })
    const inScene = await elementsInScene(sceneId, ids)
    if (!ids.every((id) => inScene.has(id))) return reply.status(400).send({ error: 'element_not_in_scene' })
    const res: AdServeResponse = { spaces: await selectAdsForElements(sceneId, [...inScene], new Date()) }
    return reply.send(res)
  })

  app.post('/api/ads/events', async (request, reply) => {
    const signed = await signedScene(request)
    if (!signed) return reply.status(401).send({ error: 'signed_request_required' })
    const check = checkAdEventBatch(request.body)
    if (!check.ok) return reply.status(400).send({ error: check.error })
    const sceneId = await boundSceneId(signed)
    if (!sceneId) return reply.status(404).send({ error: 'scene_not_found' })
    const viewer = { wallet: signed.wallet, isGuest: signed.scene.isGuest, sessionId: check.batch.sessionId }
    const accepted = await recordAdEvents(sceneId, viewer, check.batch.events, new Date())
    return reply.send({ accepted })
  })
}
