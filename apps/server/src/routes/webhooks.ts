import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { authenticate } from '../middleware/auth.js'
import { createWebhook, deleteWebhook, deliveriesOf, listWebhooks, SUBSCRIBABLE, testWebhook, WebhookError } from '../webhooks/webhooks.js'

/** An account's webhooks (LIV-39). Only the account's own: another's id answers 404. Not for trials or scene passes. */
export default async function webhookRoutes(app: FastifyInstance) {
  const guard = async (request: FastifyRequest, reply: FastifyReply) => {
    const u = request.user
    if (u.kind !== 'account' || u.trial || u.guest) return reply.status(403).send({ error: 'account_required' })
  }
  const pre = { preHandler: [authenticate, guard] }
  const fail = (reply: FastifyReply, e: unknown) => {
    if (e instanceof WebhookError) return reply.status(e.status).send({ error: e.code, message: e.message })
    throw e
  }

  app.get('/api/webhooks', pre, async (request, reply) => reply.send({ webhooks: await listWebhooks(request.user.id), events: SUBSCRIBABLE }))

  app.post('/api/webhooks', pre, async (request, reply) => {
    try {
      return reply.status(201).send(await createWebhook(request.user.id, (request.body ?? {}) as Record<string, unknown>))
    } catch (e) {
      return fail(reply, e)
    }
  })

  app.delete<{ Params: { webhookId: string } }>('/api/webhooks/:webhookId', pre, async (request, reply) =>
    (await deleteWebhook(request.user.id, request.params.webhookId)) ? reply.status(204).send() : reply.status(404).send({ error: 'webhook_not_found' }))

  app.post<{ Params: { webhookId: string } }>('/api/webhooks/:webhookId/test', pre, async (request, reply) => {
    const r = await testWebhook(request.user.id, request.params.webhookId)
    if (!r) return reply.status(404).send({ error: 'webhook_not_found' })
    const [d] = (await deliveriesOf(request.user.id, request.params.webhookId)) ?? []
    return reply.send({ delivery: d ?? null })
  })

  app.get<{ Params: { webhookId: string } }>('/api/webhooks/:webhookId/deliveries', pre, async (request, reply) => {
    const d = await deliveriesOf(request.user.id, request.params.webhookId)
    return d ? reply.send({ deliveries: d }) : reply.status(404).send({ error: 'webhook_not_found' })
  })
}
