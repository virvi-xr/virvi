import type { FastifyInstance, FastifyReply } from 'fastify'
import { authenticate } from '../middleware/auth.js'
import { CREDENTIAL_RATE_LIMIT } from '../auth/credential-rate-limit.js'
import { EmailVerifyError, emailStatus, resendVerification, verifyEmailToken } from '../auth/email-verification.js'

/** Email verification (LIV-161): open a link, see the status, send another link. */
export default async function emailVerificationRoutes(app: FastifyInstance) {
  const fail = (reply: FastifyReply, err: unknown) => {
    if (!(err instanceof EmailVerifyError)) throw err
    if (err.retryAfterSec) reply.header('retry-after', String(err.retryAfterSec))
    return reply.status(err.status).send({ error: err.code, message: err.message, ...(err.retryAfterSec ? { retryAfterSec: err.retryAfterSec } : {}) })
  }

  // The token is the auth: the link was mailed to the address
  app.post<{ Body: { token?: unknown } }>('/api/auth/verify-email', { config: { rateLimit: CREDENTIAL_RATE_LIMIT } }, async (request, reply) => {
    try {
      return reply.send({ verified: true, ...(await verifyEmailToken(request.body?.token)) })
    } catch (err) {
      return fail(reply, err)
    }
  })

  app.get('/api/auth/email', { preHandler: [authenticate] }, async (request) => emailStatus(request.user.id))

  app.post('/api/auth/email/resend', { preHandler: [authenticate], config: { rateLimit: CREDENTIAL_RATE_LIMIT } }, async (request, reply) => {
    try {
      return reply.send(await resendVerification(request.user.id))
    } catch (err) {
      return fail(reply, err)
    }
  })
}
