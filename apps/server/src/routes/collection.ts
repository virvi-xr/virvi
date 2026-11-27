import type { FastifyInstance } from 'fastify'
import { authenticate } from '../middleware/auth.js'
import { collectionFor } from '../collection/collection.js'

/** GET /api/collection: the signed-in account's own Decentraland collection (LIV-160). Never anyone else's. */
export default async function collectionRoutes(app: FastifyInstance) {
  app.get('/api/collection', { preHandler: [authenticate] }, async (request, reply) => {
    if (request.user.guest || request.user.kind === 'scene' || request.user.kind === 'trial' || request.user.trial) return reply.status(403).send({ error: 'account_required' })
    return reply.send(await collectionFor(request.user.id))
  })
}
