import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { config } from '../config.js'
import { authenticate } from '../middleware/auth.js'
import { actorFromClaims } from '../auth/actor.js'
import { getSceneAccess } from '../auth/permissions.js'
import { mayBuild } from '../ar/access.js'
import { issueChallenge, registerKey, requireAssertion } from '../app-attest/verify.js'
import { BeatError } from './errors.js'
import { appCheckIn, appClaim, appMyBeats, appSpaceBeat, appStopTracking, appTrack, type AppLocation, type AppVia, type MayBuild } from './app.js'

/**
 * The Virvi app's routes (`/api/app/...`): App Attest registration, and BEATs in AR spaces. Every route needs a signed-in
 * account session (`authenticate`; no route here takes a scene pass, an AR headset pass or a trial), and every BEAT
 * write needs the install's proof over the raw body (`requireAssertion`), so this scope keeps `request.rawBody`. The
 * BEAT routes are dark (404) unless BEAT_ENABLED.
 */
export default async function appBeatRoutes(app: FastifyInstance) {
  app.addHook('onRequest', async (request, reply) => {
    const url = request.routeOptions.url ?? ''
    if (!config.beats.enabled && (url.startsWith('/api/app/beats') || url.startsWith('/api/app/spaces/'))) {
      return reply.status(404).send({ error: 'not_found', message: 'Not found.' })
    }
  })
  app.addHook('preHandler', authenticate)

  const body = (request: FastifyRequest) => (request.body && typeof request.body === 'object' ? request.body : {}) as Record<string, unknown>
  const rawBody = (request: FastifyRequest) => (request as { rawBody?: string }).rawBody
  const fail = (reply: FastifyReply, e: unknown) => {
    if (e instanceof BeatError) return reply.status(e.status).send({ ...e.details, error: e.code, message: e.message })
    throw e
  }
  const builderOf = (request: FastifyRequest): MayBuild => async (sceneId) => mayBuild(await getSceneAccess(actorFromClaims(request.user), sceneId))
  const location = (v: unknown): AppLocation | undefined => {
    const l = v as Partial<AppLocation> | null | undefined
    return l && [l.lat, l.lng, l.accuracyM].every((n) => typeof n === 'number' && Number.isFinite(n)) ? { lat: l.lat!, lng: l.lng!, accuracyM: l.accuracyM! } : undefined
  }
  const via = (b: Record<string, unknown>): AppVia | null =>
    typeof b.spaceId === 'string' ? { spaceId: b.spaceId } : typeof b.arcCode === 'string' ? { arcCode: b.arcCode, location: location(b.location) } : null
  type BeatReq = FastifyRequest<{ Params: { beatId: string } }>

  // ── App Attest ─────────────────────────────────────────────────────────────

  app.get('/api/app/attest/challenge', async (request, reply) => reply.send({ challenge: await issueChallenge(request.user.id) }))

  app.post('/api/app/attest/register', async (request, reply) => {
    try {
      return reply.status(201).send(await registerKey(request.user.id, body(request)))
    } catch (e) {
      return fail(reply, e)
    }
  })

  // ── BEATs in AR spaces ─────────────────────────────────────────────────────

  app.get<{ Params: { spaceId: string } }>('/api/app/spaces/:spaceId/beat', async (request, reply) => {
    try {
      return reply.send({ beat: await appSpaceBeat(request.params.spaceId, request.user.id, builderOf(request)) })
    } catch (e) {
      return fail(reply, e)
    }
  })

  app.post<{ Params: { beatId: string } }>('/api/app/beats/:beatId/track', async (request: BeatReq, reply) => {
    try {
      const installKeyId = await requireAssertion(request, rawBody(request))
      const b = body(request)
      const where = via(b)
      if (!where) return reply.status(400).send({ error: 'bad_request', message: 'Say where you are tracking from.' })
      return reply.send({ beat: await appTrack(request.params.beatId, { userId: request.user.id, installKeyId, consentVersion: b.consentVersion, via: where, mayBuild: builderOf(request) }) })
    } catch (e) {
      return fail(reply, e)
    }
  })

  app.post<{ Params: { beatId: string } }>('/api/app/beats/:beatId/checkin', async (request: BeatReq, reply) => {
    try {
      await requireAssertion(request, rawBody(request))
      const { spaceId } = body(request)
      if (typeof spaceId !== 'string') return reply.status(400).send({ error: 'bad_request', message: 'Say which AR space you are in.' })
      return reply.send({ beat: await appCheckIn(request.params.beatId, { userId: request.user.id, spaceId, mayBuild: builderOf(request) }) })
    } catch (e) {
      return fail(reply, e)
    }
  })

  app.post<{ Params: { beatId: string } }>('/api/app/beats/:beatId/claim', async (request: BeatReq, reply) => {
    try {
      const installKeyId = await requireAssertion(request, rawBody(request))
      const b = body(request)
      return reply.send({ beat: await appClaim(request.params.beatId, { userId: request.user.id, installKeyId, wallet: b.wallet, location: location(b.location), ip: request.ip }) })
    } catch (e) {
      return fail(reply, e)
    }
  })

  app.delete<{ Params: { beatId: string } }>('/api/app/beats/:beatId/track', async (request: BeatReq, reply) => {
    try {
      await requireAssertion(request, rawBody(request))
      await appStopTracking(request.params.beatId, request.user.id)
      return reply.status(204).send()
    } catch (e) {
      return fail(reply, e)
    }
  })

  app.get('/api/app/beats/mine', async (request, reply) => reply.send({ beats: await appMyBeats(request.user.id) }))
}
