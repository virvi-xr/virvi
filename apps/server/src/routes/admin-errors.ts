import type { FastifyInstance } from 'fastify'
import { eq } from 'drizzle-orm'
import { db } from '../db/connection.js'
import { errorSignatures } from '../db/schema.js'
import { config } from '../config.js'
import { authenticate } from '../middleware/auth.js'
import { requireAdmin } from '../auth/admin.js'
import { isUuid } from '../auth/scene-from.js'
import { errorsOverview, signatureDetail } from '../errors/queries.js'
import { checkThresholds, getThresholds, saveThresholds } from '../errors/settings.js'
import { linearConfigured } from '../errors/linear.js'

/** The admin Errors page (LIV-66 §2): site admins only, by the database-checked guard. */
export default async function adminErrorRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate)
  app.addHook('preHandler', requireAdmin)

  app.get('/api/admin/errors', async (_request, reply) => {
    return reply.send(await errorsOverview(new Date(), await getThresholds()))
  })

  app.get<{ Params: { id: string }; Querystring: { days?: string } }>('/api/admin/errors/:id', async (request, reply) => {
    if (!isUuid(request.params.id)) return reply.status(404).send({ error: 'not_found' })
    const days = Math.min(400, Math.max(1, parseInt(request.query.days ?? '7', 10) || 7))
    const detail = await signatureDetail(request.params.id, new Date(), days)
    if (!detail) return reply.status(404).send({ error: 'not_found' })
    return reply.send(detail)
  })

  // Marked fixed: the phase-1 stand-in for its Linear issue being Done. An event after it is a regression.
  app.patch<{ Params: { id: string }; Body: { resolved?: unknown } }>('/api/admin/errors/:id', async (request, reply) => {
    const resolved = request.body?.resolved
    if (typeof resolved !== 'boolean') return reply.status(400).send({ error: 'resolved must be true or false' })
    if (!isUuid(request.params.id)) return reply.status(404).send({ error: 'not_found' })
    const [row] = await db.update(errorSignatures)
      .set(resolved ? { resolvedAt: new Date(), resolvedBy: request.user.id, regressedAt: null } : { resolvedAt: null, resolvedBy: null })
      .where(eq(errorSignatures.id, request.params.id))
      .returning({ id: errorSignatures.id, resolvedAt: errorSignatures.resolvedAt, regressedAt: errorSignatures.regressedAt })
    if (!row) return reply.status(404).send({ error: 'not_found' })
    return reply.send(row)
  })

  app.get('/api/admin/error-settings', async (_request, reply) => {
    return reply.send({ thresholds: await getThresholds(), defaults: config.errorThresholds, linear: { configured: linearConfigured() }, release: config.release })
  })

  app.put<{ Body: unknown }>('/api/admin/error-settings', async (request, reply) => {
    const checked = checkThresholds(request.body)
    if (!checked.ok) return reply.status(400).send({ error: checked.error })
    return reply.send({ thresholds: await saveThresholds(checked.value, request.user.id) })
  })
}
