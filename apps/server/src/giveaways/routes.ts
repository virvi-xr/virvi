import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { config } from '../config.js'
import { authenticate } from '../middleware/auth.js'
import { actorFromClaims } from '../auth/actor.js'
import { isAdminRequest } from '../auth/admin.js'
import { GiveawayError } from './errors.js'
import {
  createGiveaway, deleteGiveaway, giveawayAvailability, hostView, listClaims, listCreatorItems, listGiveaways, sendBack, setItems, setScenes,
  updateGiveaway, type GiveawayCaller,
} from './host.js'

const AVAILABILITY = '/api/giveaways/availability'

/**
 * Automatic giveaway host routes (LIV-194). Every route is for a signed-in account: no route declares a scene pass, so
 * Decentraland, Hyperfy, AR and studio passes are refused by authenticate, and trials too (403 account_required).
 * Without GIVEAWAY_WALLET_SECRET every route but availability answers 503 giveaways_off.
 */
export default async function giveawayRoutes(app: FastifyInstance) {
  app.addHook('onRequest', async (request, reply) => {
    if (!config.giveaways.enabled && request.routeOptions.url !== AVAILABILITY) {
      return reply.status(503).send({ error: 'giveaways_off', message: "Automatic giveaways aren't switched on for this server yet." })
    }
  })
  app.addHook('preHandler', authenticate)

  const caller = async (request: FastifyRequest): Promise<GiveawayCaller> => ({
    userId: request.user.id, actor: actorFromClaims(request.user), admin: await isAdminRequest(request),
  })
  const body = (request: FastifyRequest) => (request.body && typeof request.body === 'object' ? request.body : {}) as Record<string, unknown>
  const run = async (reply: FastifyReply, fn: () => Promise<unknown>, status = 200) => {
    try {
      return reply.status(status).send(await fn())
    } catch (e) {
      if (e instanceof GiveawayError) return reply.status(e.status).send({ ...e.details, error: e.code, message: e.message })
      throw e
    }
  }
  type Id = { Params: { id: string } }

  app.get(AVAILABILITY, async (request, reply) => reply.send(await giveawayAvailability(request.user.id)))

  app.get('/api/giveaways', async (request, reply) => run(reply, async () => ({ giveaways: await listGiveaways(await caller(request)) })))
  app.post('/api/giveaways', async (request, reply) =>
    run(reply, async () => ({ giveaway: await createGiveaway(await caller(request), body(request)) }), 201))

  app.get<{ Querystring: { chain?: string } }>('/api/giveaways/creator-items', async (request, reply) =>
    run(reply, async () => listCreatorItems(await caller(request), request.query.chain)))

  app.get<Id>('/api/giveaways/:id', async (request, reply) => run(reply, async () => hostView(await caller(request), request.params.id)))
  app.patch<Id>('/api/giveaways/:id', async (request, reply) =>
    run(reply, async () => updateGiveaway(await caller(request), request.params.id, body(request))))
  app.delete<Id>('/api/giveaways/:id', async (request, reply) =>
    run(reply, async () => deleteGiveaway(await caller(request), request.params.id), 202))

  app.put<Id>('/api/giveaways/:id/items', async (request, reply) =>
    run(reply, async () => setItems(await caller(request), request.params.id, body(request))))
  app.put<Id>('/api/giveaways/:id/scenes', async (request, reply) =>
    run(reply, async () => setScenes(await caller(request), request.params.id, body(request))))

  app.get<Id & { Querystring: { cursor?: string } }>('/api/giveaways/:id/claims', async (request, reply) =>
    run(reply, async () => listClaims(await caller(request), request.params.id, request.query.cursor)))

  app.post<Id>('/api/giveaways/:id/send-back', async (request, reply) =>
    run(reply, async () => sendBack(await caller(request), request.params.id, body(request)), 202))
}
