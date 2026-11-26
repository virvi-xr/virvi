import type { FastifyInstance } from 'fastify'
import { authenticate } from '../middleware/auth.js'
import { BadPrivacyDecisionError, StalePrivacyError, privacyStatus, recordPrivacyDecision } from '../auth/privacy.js'

/** The dashboard privacy notice (GDPR notice): the account's decision on the notice in force, and making one. */
export default async function privacyRoutes(app: FastifyInstance) {
  app.get('/api/auth/privacy', { preHandler: [authenticate] }, async (request) => privacyStatus(request.user.id))

  app.post<{ Body: { decision?: unknown; version?: unknown; via?: unknown } }>('/api/auth/privacy', { preHandler: [authenticate] }, async (request, reply) => {
    const via = request.body?.via === 'settings' ? 'settings' : 'prompt'
    try {
      await recordPrivacyDecision(request.user.id, request.body?.decision, request.body?.version, via)
    } catch (err) {
      if (err instanceof BadPrivacyDecisionError) return reply.status(400).send({ error: 'bad_decision', message: err.message })
      if (!(err instanceof StalePrivacyError)) throw err
      return reply.status(400).send({ error: 'stale_version', message: err.message, ...(await privacyStatus(request.user.id)) })
    }
    return reply.send(await privacyStatus(request.user.id))
  })
}
