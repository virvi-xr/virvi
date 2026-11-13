import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { eq } from 'drizzle-orm'
import { db } from '../db/connection.js'
import { scenes } from '../db/schema.js'
import { authenticate } from '../middleware/auth.js'
import { actorFromClaims } from '../auth/actor.js'
import { getSceneAccess, hasScope } from '../auth/permissions.js'
import { fromParam, fromRaffle, isUuid } from '../auth/scene-from.js'
import {
  RaffleError, createRaffle, drawRaffle, drawRecord, endRaffle, getDraw, getRaffle, listRaffles, openRaffle, raffleDetail,
  snapshotOut, takeSnapshot, updateRaffle, type RaffleRow,
} from './service.js'

/**
 * Raffles (LIV-55), the host's routes: for everyone with `raffle.run` (hosts, co-hosts, editors). Viewers, booking
 * crew and other accounts get 403. The host HUD's scene pass may call them for its own scene; Hyperfy, AR and studio
 * passes are refused (their `scenePass` flags stay unset).
 */
export default async function raffleRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate)

  const sceneScoped = { config: { scenePass: { sceneFrom: fromParam('sceneId') } } }
  const raffleScoped = { config: { scenePass: { sceneFrom: fromRaffle } } }

  const mayRun = async (request: FastifyRequest, sceneId: string) => hasScope(await getSceneAccess(actorFromClaims(request.user), sceneId), 'raffle.run')
  const forbidden = (reply: FastifyReply) => reply.status(403).send({ error: 'forbidden', message: "You can't run raffles in this scene." })

  const fail = (reply: FastifyReply, e: unknown) => {
    if (e instanceof RaffleError) return reply.status(e.status).send({ error: e.code, message: e.message })
    throw e
  }

  /** The scene, when it exists and the caller may run raffles in it; otherwise the reply is sent. */
  async function ownScene(request: FastifyRequest<{ Params: { sceneId: string } }>, reply: FastifyReply) {
    const { sceneId } = request.params
    if (!isUuid(sceneId) || !(await db.query.scenes.findFirst({ where: eq(scenes.id, sceneId), columns: { id: true } }))) {
      reply.status(404).send({ error: 'Scene not found' })
      return null
    }
    if (!(await mayRun(request, sceneId))) { forbidden(reply); return null }
    return sceneId
  }

  /** The raffle, when it exists and the caller may run raffles in its scene; otherwise the reply is sent. */
  async function ownRaffle(request: FastifyRequest<{ Params: { raffleId: string } }>, reply: FastifyReply): Promise<RaffleRow | null> {
    const row = await getRaffle(request.params.raffleId)
    if (!row) { reply.status(404).send({ error: 'raffle_not_found', message: 'Raffle not found.' }); return null }
    if (!(await mayRun(request, row.sceneId))) { forbidden(reply); return null }
    return row
  }

  const body = (request: FastifyRequest) => (request.body && typeof request.body === 'object' ? request.body : {}) as Record<string, unknown>

  app.get<{ Params: { sceneId: string } }>('/api/scenes/:sceneId/raffles', sceneScoped, async (request, reply) => {
    const sceneId = await ownScene(request, reply)
    if (!sceneId) return reply
    return reply.send({ raffles: await listRaffles(sceneId) })
  })

  app.post<{ Params: { sceneId: string } }>('/api/scenes/:sceneId/raffles', sceneScoped, async (request, reply) => {
    const sceneId = await ownScene(request, reply)
    if (!sceneId) return reply
    try {
      return reply.status(201).send({ raffle: await createRaffle(sceneId, request.user.id, body(request)) })
    } catch (e) {
      return fail(reply, e)
    }
  })

  app.get<{ Params: { raffleId: string } }>('/api/raffles/:raffleId', raffleScoped, async (request, reply) => {
    const row = await ownRaffle(request, reply)
    if (!row) return reply
    return reply.send(await raffleDetail(row))
  })

  app.patch<{ Params: { raffleId: string } }>('/api/raffles/:raffleId', raffleScoped, async (request, reply) => {
    const row = await ownRaffle(request, reply)
    if (!row) return reply
    try {
      return reply.send({ raffle: await updateRaffle(row, body(request)) })
    } catch (e) {
      return fail(reply, e)
    }
  })

  app.post<{ Params: { raffleId: string } }>('/api/raffles/:raffleId/open', raffleScoped, async (request, reply) => {
    const row = await ownRaffle(request, reply)
    if (!row) return reply
    try {
      return reply.send({ raffle: await openRaffle(row) })
    } catch (e) {
      return fail(reply, e)
    }
  })

  app.post<{ Params: { raffleId: string } }>('/api/raffles/:raffleId/snapshot', raffleScoped, async (request, reply) => {
    const row = await ownRaffle(request, reply)
    if (!row) return reply
    try {
      const snap = await takeSnapshot(row.id, 'manual')
      return reply.send({ snapshot: snapshotOut(snap!) })
    } catch (e) {
      return fail(reply, e)
    }
  })

  app.post<{ Params: { raffleId: string } }>('/api/raffles/:raffleId/draw', raffleScoped, async (request, reply) => {
    const row = await ownRaffle(request, reply)
    if (!row) return reply
    try {
      const { draw, winners } = await drawRaffle(row.id, request.user.id, body(request).snapshotIds as string[] | undefined)
      return reply.send({ draw: drawRecord(draw), winners })
    } catch (e) {
      return fail(reply, e)
    }
  })

  app.post<{ Params: { raffleId: string } }>('/api/raffles/:raffleId/close', raffleScoped, async (request, reply) => {
    const row = await ownRaffle(request, reply)
    if (!row) return reply
    try {
      return reply.send({ raffle: await endRaffle(row, 'closed') })
    } catch (e) {
      return fail(reply, e)
    }
  })

  app.post<{ Params: { raffleId: string } }>('/api/raffles/:raffleId/cancel', raffleScoped, async (request, reply) => {
    const row = await ownRaffle(request, reply)
    if (!row) return reply
    try {
      return reply.send({ raffle: await endRaffle(row, 'cancelled') })
    } catch (e) {
      return fail(reply, e)
    }
  })

  app.get<{ Params: { raffleId: string; drawId: string } }>('/api/raffles/:raffleId/draws/:drawId', raffleScoped, async (request, reply) => {
    const row = await ownRaffle(request, reply)
    if (!row) return reply
    const draw = await getDraw(row.id, request.params.drawId)
    if (!draw) return reply.status(404).send({ error: 'draw_not_found', message: 'Draw not found.' })
    return reply.send(drawRecord(draw))
  })
}
