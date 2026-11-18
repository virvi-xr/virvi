import type { FastifyInstance } from 'fastify'
import { TERMS_VERSION } from '@virvixr/shared'
import { authenticate } from '../middleware/auth.js'
import { StaleTermsError, acceptTerms, termsStatus } from '../auth/terms.js'

/** The Terms of Service agreement: has this account agreed to the version in force, and agree to it. */
export default async function termsRoutes(app: FastifyInstance) {
  app.get('/api/auth/terms', { preHandler: [authenticate] }, async (request) => termsStatus(request.user.id))

  app.post<{ Body: { version?: unknown } }>('/api/auth/terms', { preHandler: [authenticate] }, async (request, reply) => {
    try {
      await acceptTerms(request.user.id, request.body?.version, 'prompt')
    } catch (err) {
      if (!(err instanceof StaleTermsError)) throw err
      return reply.status(409).send({ error: 'stale_terms', message: err.message, version: TERMS_VERSION })
    }
    return reply.send(await termsStatus(request.user.id))
  })
}
