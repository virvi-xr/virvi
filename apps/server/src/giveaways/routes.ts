import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { config } from '../config.js'
import { authenticate } from '../middleware/auth.js'
import { actorFromClaims } from '../auth/actor.js'
import { isAdminRequest } from '../auth/admin.js'
import { fromParam } from '../auth/scene-from.js'
import { sceneExists } from '../beats/service.js'
import { GiveawayError } from './errors.js'
import { checkInGiveaway, claimGiveaway, currentGiveaway, stopGiveaway, trackGiveaway } from './visitor.js'
import {
  createGiveaway, deleteGiveaway, giveawayAvailability, hostView, listClaims, listCreatorItems, listGiveaways, sendBack, setItems, setScenes,
  updateGiveaway, type GiveawayCaller,
} from './host.js'

const AVAILABILITY = '/api/giveaways/availability'

/**
 * Automatic giveaway routes (LIV-194). Every host route is for a signed-in account: no host route declares a scene pass, so
 * Decentraland, Hyperfy, AR and studio passes are refused by authenticate, and trials too (403 account_required).
 * Without GIVEAWAY_WALLET_SECRET every route but availability answers 503 giveaways_off.
 * Visitor routes (`/api/scenes/:sceneId/giveaway/...`) take a scene pass bound to `:sceneId`, as the BEAT visitor routes
 * do, for a giveaway on that scene (404 otherwise).
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

  // ── Visitors ───────────────────────────────────────────────────────────────

  const sceneScoped = { config: { scenePass: { sceneFrom: fromParam('sceneId') } } }
  /** The caller's pass is a scene pass bound to this scene (the middleware already refused one for another scene). */
  const inScene = (request: FastifyRequest, sceneId: string) => request.user.kind === 'scene' && request.user.sceneId === sceneId
  const sceneOnly = (reply: FastifyReply) => reply.status(403).send({ error: 'scene_pass_required', message: 'Do this from inside the scene.' })
  /** The pass's platform: a scene pass is Decentraland's unless it says it came another way (Hyperfy's `via`). */
  const platformOf = (request: FastifyRequest) => ((request.user as { via?: string }).via ?? 'decentraland')
  type Visit = { Params: { sceneId: string; id: string } }

  app.get<{ Params: { sceneId: string } }>('/api/scenes/:sceneId/giveaway/current', sceneScoped, async (request, reply) => {
    if (!(await sceneExists(request.params.sceneId))) return reply.status(404).send({ error: 'not_found', message: 'Scene not found.' })
    return run(reply, async () => ({ giveaway: await currentGiveaway(request.params.sceneId, request.user.id) }))
  })

  app.post<Visit>('/api/scenes/:sceneId/giveaway/:id/track', sceneScoped, async (request, reply) => {
    const { sceneId, id } = request.params
    if (!inScene(request, sceneId)) return sceneOnly(reply)
    const { wallet, verified, displayName } = request.user
    const c = { userId: request.user.id, wallet: wallet && verified === true ? wallet : null, signInName: displayName ?? null, platform: platformOf(request), ip: request.ip }
    return run(reply, () => trackGiveaway(sceneId, id, c, body(request).consentVersion))
  })

  app.post<Visit>('/api/scenes/:sceneId/giveaway/:id/checkin', sceneScoped, async (request, reply) => {
    const { sceneId, id } = request.params
    if (!inScene(request, sceneId)) return sceneOnly(reply)
    return run(reply, () => checkInGiveaway(sceneId, id, request.user.id))
  })

  app.post<Visit>('/api/scenes/:sceneId/giveaway/:id/claim', sceneScoped, async (request, reply) => {
    const { sceneId, id } = request.params
    if (!inScene(request, sceneId)) return sceneOnly(reply)
    return run(reply, () => claimGiveaway(sceneId, id, { userId: request.user.id, platform: platformOf(request), ip: request.ip }))
  })

  // Stopping acts only on the caller's own claim, so a signed-in account may do it too (as for BEATs)
  app.delete<Visit>('/api/scenes/:sceneId/giveaway/:id/track', sceneScoped, async (request, reply) =>
    run(reply, async () => {
      await stopGiveaway(request.params.sceneId, request.params.id, request.user.id)
      return null
    }, 204))
}
