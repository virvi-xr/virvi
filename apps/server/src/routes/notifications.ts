import type { FastifyInstance } from 'fastify'
import { authenticate } from '../middleware/auth.js'
import { isUuid } from '../auth/scene-from.js'
import { isTrialUser } from '../studio/quota.js'
import { listNotifications, markAllRead, markRead, unreadCount } from '../notifications/notifications.js'

/** The bell: a user's own notifications. A trial has none: its list is empty and its count 0. */
export default async function notificationRoutes(app: FastifyInstance) {
  const trial = { preHandler: [authenticate], config: { trial: true as const } }

  app.get('/api/notifications', trial, async (request, reply) => {
    const q = request.query as { before?: string; limit?: string }
    let before: Date | null = null
    if (q.before !== undefined) {
      before = new Date(q.before)
      if (Number.isNaN(before.getTime())) return reply.status(400).send({ error: 'before must be a date' })
    }
    const limit = q.limit === undefined ? 20 : Number(q.limit)
    if (!Number.isFinite(limit) || limit < 1) return reply.status(400).send({ error: 'limit must be a positive number' })
    if (await isTrialUser(request.user.id)) return { items: [], more: false }
    return listNotifications(request.user.id, before, limit, new Date())
  })

  app.get('/api/notifications/unread-count', trial, async (request) => {
    if (await isTrialUser(request.user.id)) return { count: 0 }
    return { count: await unreadCount(request.user.id) }
  })

  app.post('/api/notifications/read-all', { preHandler: [authenticate] }, async (request, reply) => {
    await markAllRead(request.user.id, new Date())
    return reply.status(204).send()
  })

  app.post('/api/notifications/:id/read', { preHandler: [authenticate] }, async (request, reply) => {
    const { id } = request.params as { id: string }
    if (!isUuid(id) || !await markRead(request.user.id, id, new Date())) return reply.status(404).send({ error: 'notification_not_found' })
    return reply.status(204).send()
  })
}
