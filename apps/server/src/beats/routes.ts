import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { config } from '../config.js'
import { authenticate } from '../middleware/auth.js'
import { actorFromClaims } from '../auth/actor.js'
import { isAdminRequest } from '../auth/admin.js'
import { fromBeat, fromParam } from '../auth/scene-from.js'
import {
  BeatError, beatAvailability, cancelBeat, createBeat, endBeatEarly, getBeat, listBeats, listClaimants, listSceneBeats, mayRunBeatsIn,
  sceneExists, updateBeat, type BeatCaller,
} from './service.js'

/**
 * BEAT host routes (LIV-11). Dark unless BEAT_ENABLED: every route but availability answers 404.
 * Who may do what is decided in the service (the creator, or `events.run` on the BEAT's scenes). A Decentraland scene
 * pass may call the BEAT-scoped routes for the BEAT's first scene; Hyperfy, AR and studio passes are refused everywhere
 * (their `scenePass` flags stay unset), and the routes without a scene take no scene pass.
 */
export default async function beatRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate)
  // After authenticate, so every route's guards still answer first
  app.addHook('preHandler', async (request, reply) => {
    if (!config.beats.enabled && request.routeOptions.url !== '/api/beats/availability') {
      return reply.status(404).send({ error: 'not_found', message: 'Not found.' })
    }
  })

  const beatScoped = { config: { scenePass: { sceneFrom: fromBeat } } }
  const sceneScoped = { config: { scenePass: { sceneFrom: fromParam('sceneId') } } }

  const caller = async (request: FastifyRequest): Promise<BeatCaller> => ({
    userId: request.user.id, actor: actorFromClaims(request.user), admin: await isAdminRequest(request),
  })
  const body = (request: FastifyRequest) => (request.body && typeof request.body === 'object' ? request.body : {}) as Record<string, unknown>
  const fail = (reply: FastifyReply, e: unknown) => {
    if (e instanceof BeatError) return reply.status(e.status).send({ error: e.code, message: e.message })
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

  app.get<{ Params: { beatId: string } }>('/api/beats/:beatId', beatScoped, async (request, reply) => {
    try {
      return reply.send(await getBeat(await caller(request), request.params.beatId))
    } catch (e) {
      return fail(reply, e)
    }
  })

  app.patch<{ Params: { beatId: string } }>('/api/beats/:beatId', beatScoped, async (request, reply) => {
    try {
      return reply.send(await updateBeat(await caller(request), request.params.beatId, body(request)))
    } catch (e) {
      return fail(reply, e)
    }
  })

  app.get<{ Params: { beatId: string } }>('/api/beats/:beatId/claimants', beatScoped, async (request, reply) => {
    try {
      return reply.send(await listClaimants(await caller(request), request.params.beatId))
    } catch (e) {
      return fail(reply, e)
    }
  })

  app.post<{ Params: { beatId: string } }>('/api/beats/:beatId/cancel', beatScoped, async (request, reply) => {
    try {
      return reply.send(await cancelBeat(await caller(request), request.params.beatId))
    } catch (e) {
      return fail(reply, e)
    }
  })

  app.post<{ Params: { beatId: string } }>('/api/beats/:beatId/end-early', beatScoped, async (request, reply) => {
    try {
      return reply.send(await endBeatEarly(await caller(request), request.params.beatId))
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
}
