import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { config } from '../config.js'
import { authenticate } from '../middleware/auth.js'
import { actorFromClaims } from '../auth/actor.js'
import { isAdminRequest } from '../auth/admin.js'
import { boundScene, fromParam } from '../auth/scene-from.js'
import {
  BeatError, beatAvailability, cancelBeat, checkoutBeat, createBeat, endBeatEarly, getBeat, listBeats, listClaimants, listSceneBeats, mayRunBeatsIn,
  quoteBeat, raiseBeatCap, releaseBeatMints, removeBeatClaim, sceneExists, updateBeat, type BeatCaller,
} from './service.js'
import { checkInBeat, claimBeat, currentBeat, stopTrackingBeat, trackBeat } from './visitor.js'
import beatMetadataRoutes, { BEAT_METADATA_ROUTE } from './metadata.js'

/**
 * BEAT host routes (LIV-11). Dark unless BEAT_ENABLED: every route but availability answers 404.
 * Who may do what is decided in the service (the creator, or `events.run` on the BEAT's scenes). Only the read routes take
 * a Decentraland scene pass (and only for a BEAT that includes the pass's scene); writes, list, create and availability
 * refuse every scene pass, and Hyperfy, AR and studio passes are refused everywhere (their `scenePass` flags stay unset).
 * Visitor routes (`/api/scenes/:sceneId/beat/...`) take a Decentraland scene pass bound to `:sceneId`, for a BEAT on that
 * scene (404 otherwise). The token metadata (metadata.ts) is public and skips `authenticate`.
 */
export default async function beatRoutes(app: FastifyInstance) {
  // Dark launch: before authenticate, so a signed-out caller can't tell the routes exist either
  app.addHook('onRequest', async (request, reply) => {
    if (!config.beats.enabled && request.routeOptions.url !== '/api/beats/availability') {
      return reply.status(404).send({ error: 'not_found', message: 'Not found.' })
    }
  })
  // The token metadata is public: the one route here that reads no bearer (still dark unless BEAT_ENABLED)
  await app.register(beatMetadataRoutes)
  app.addHook('preHandler', async (request, reply) => {
    if (request.routeOptions.url === BEAT_METADATA_ROUTE) return
    await authenticate(request, reply)
  })

  // Only the read routes take a scene pass. `boundScene` lets a Decentraland pass through; the service then holds it to
  // BEATs that include its scene (404 otherwise). Writes and the scene-less routes take none (403 scene_pass_not_allowed).
  const beatRead = { config: { scenePass: { sceneFrom: boundScene } } }
  const sceneScoped = { config: { scenePass: { sceneFrom: fromParam('sceneId') } } }

  const caller = async (request: FastifyRequest): Promise<BeatCaller> => ({
    userId: request.user.id, actor: actorFromClaims(request.user), admin: await isAdminRequest(request),
    passSceneId: request.user.kind === 'scene' ? request.user.sceneId ?? null : null,
  })
  const body = (request: FastifyRequest) => (request.body && typeof request.body === 'object' ? request.body : {}) as Record<string, unknown>
  const fail = (reply: FastifyReply, e: unknown) => {
    if (e instanceof BeatError) return reply.status(e.status).send({ ...e.details, error: e.code, message: e.message })
    throw e
  }

  app.get('/api/beats/availability', async (request, reply) => reply.send(beatAvailability(await isAdminRequest(request))))

  app.get('/api/beats', async (request, reply) => reply.send(await listBeats(await caller(request))))

  app.post('/api/beats', async (request, reply) => {
    try {
      return reply.status(201).send(await createBeat(await caller(request), body(request)))
    } catch (e) {
      return fail(reply, e)
    }
  })

  app.get<{ Params: { beatId: string } }>('/api/beats/:beatId', beatRead, async (request, reply) => {
    try {
      return reply.send(await getBeat(await caller(request), request.params.beatId))
    } catch (e) {
      return fail(reply, e)
    }
  })

  app.patch<{ Params: { beatId: string } }>('/api/beats/:beatId', async (request, reply) => {
    try {
      return reply.send(await updateBeat(await caller(request), request.params.beatId, body(request)))
    } catch (e) {
      return fail(reply, e)
    }
  })

  app.get<{ Params: { beatId: string } }>('/api/beats/:beatId/claimants', beatRead, async (request, reply) => {
    try {
      return reply.send(await listClaimants(await caller(request), request.params.beatId))
    } catch (e) {
      return fail(reply, e)
    }
  })

  app.post<{ Params: { beatId: string } }>('/api/beats/:beatId/cancel', async (request, reply) => {
    try {
      return reply.send(await cancelBeat(await caller(request), request.params.beatId))
    } catch (e) {
      return fail(reply, e)
    }
  })

  app.post<{ Params: { beatId: string } }>('/api/beats/:beatId/end-early', async (request, reply) => {
    try {
      return reply.send(await endBeatEarly(await caller(request), request.params.beatId))
    } catch (e) {
      return fail(reply, e)
    }
  })

  // Host review: send held claims, or remove one before they go
  app.post<{ Params: { beatId: string } }>('/api/beats/:beatId/release', async (request, reply) => {
    try {
      return reply.send(await releaseBeatMints(await caller(request), request.params.beatId))
    } catch (e) {
      return fail(reply, e)
    }
  })

  app.delete<{ Params: { beatId: string; claimId: string } }>('/api/beats/:beatId/claims/:claimId', async (request, reply) => {
    try {
      return reply.send(await removeBeatClaim(await caller(request), request.params.beatId, request.params.claimId))
    } catch (e) {
      return fail(reply, e)
    }
  })

  // Payments: host-only, so no scene pass (403 scene_pass_not_allowed)
  app.get<{ Params: { beatId: string }; Querystring: { cap?: string; method?: string } }>('/api/beats/:beatId/quote', async (request, reply) => {
    try {
      return reply.send(await quoteBeat(await caller(request), request.params.beatId, request.query.cap, request.query.method))
    } catch (e) {
      return fail(reply, e)
    }
  })

  app.post<{ Params: { beatId: string } }>('/api/beats/:beatId/checkout', async (request, reply) => {
    try {
      return reply.send(await checkoutBeat(await caller(request), request.params.beatId, body(request)))
    } catch (e) {
      return fail(reply, e)
    }
  })

  app.post<{ Params: { beatId: string } }>('/api/beats/:beatId/cap', async (request, reply) => {
    try {
      return reply.send(await raiseBeatCap(await caller(request), request.params.beatId, body(request)))
    } catch (e) {
      return fail(reply, e)
    }
  })

  app.get<{ Params: { sceneId: string } }>('/api/scenes/:sceneId/beats', sceneScoped, async (request, reply) => {
    const { sceneId } = request.params
    if (!(await sceneExists(sceneId))) return reply.status(404).send({ error: 'not_found', message: 'Scene not found.' })
    const c = await caller(request)
    if (!(await mayRunBeatsIn(c, sceneId))) return reply.status(403).send({ error: 'forbidden', message: "You can't run events in this scene." })
    return reply.send(await listSceneBeats(c, sceneId))
  })

  // ── Visitors ───────────────────────────────────────────────────────────────

  /** The caller's pass is a scene pass bound to this scene (the middleware already refused one for another scene). */
  const inScene = (request: FastifyRequest, sceneId: string) => request.user.kind === 'scene' && request.user.sceneId === sceneId
  const sceneOnly = (reply: FastifyReply) => reply.status(403).send({ error: 'scene_pass_required', message: 'Do this from inside the scene.' })
  type VisitorReq = FastifyRequest<{ Params: { sceneId: string; beatId: string } }>
  /** The pass's platform: a scene pass is Decentraland's unless it says it came another way (Hyperfy's `via`). */
  const platformOf = (request: FastifyRequest) => ((request.user as { via?: string }).via ?? 'decentraland')

  app.get<{ Params: { sceneId: string } }>('/api/scenes/:sceneId/beat/current', sceneScoped, async (request, reply) => {
    if (!(await sceneExists(request.params.sceneId))) return reply.status(404).send({ error: 'not_found', message: 'Scene not found.' })
    try {
      return reply.send(await currentBeat(request.params.sceneId, request.user.id))
    } catch (e) {
      return fail(reply, e)
    }
  })

  app.post<{ Params: { sceneId: string; beatId: string } }>('/api/scenes/:sceneId/beat/:beatId/track', sceneScoped, async (request: VisitorReq, reply) => {
    const { sceneId, beatId } = request.params
    if (!inScene(request, sceneId)) return sceneOnly(reply)
    const { wallet, verified, displayName } = request.user
    try {
      const caller = { userId: request.user.id, wallet: wallet && verified === true ? wallet : null, signInName: displayName ?? null, platform: platformOf(request), ip: request.ip }
      return reply.send(await trackBeat(sceneId, beatId, caller, body(request).consentVersion))
    } catch (e) {
      return fail(reply, e)
    }
  })

  app.post<{ Params: { sceneId: string; beatId: string } }>('/api/scenes/:sceneId/beat/:beatId/checkin', sceneScoped, async (request: VisitorReq, reply) => {
    const { sceneId, beatId } = request.params
    if (!inScene(request, sceneId)) return sceneOnly(reply)
    try {
      return reply.send(await checkInBeat(sceneId, beatId, request.user.id))
    } catch (e) {
      return fail(reply, e)
    }
  })

  app.post<{ Params: { sceneId: string; beatId: string } }>('/api/scenes/:sceneId/beat/:beatId/claim', sceneScoped, async (request: VisitorReq, reply) => {
    const { sceneId, beatId } = request.params
    if (!inScene(request, sceneId)) return sceneOnly(reply)
    try {
      return reply.send(await claimBeat(sceneId, beatId, { userId: request.user.id, platform: platformOf(request), ip: request.ip }))
    } catch (e) {
      return fail(reply, e)
    }
  })

  // Stopping acts only on the caller's own claim, so a signed-in account may do it too (as withdrawing a raffle entry)
  app.delete<{ Params: { sceneId: string; beatId: string } }>('/api/scenes/:sceneId/beat/:beatId/track', sceneScoped, async (request: VisitorReq, reply) => {
    try {
      await stopTrackingBeat(request.params.sceneId, request.params.beatId, request.user.id)
      return reply.status(204).send()
    } catch (e) {
      return fail(reply, e)
    }
  })
}
