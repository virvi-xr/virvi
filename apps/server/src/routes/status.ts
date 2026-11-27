import type { FastifyInstance } from 'fastify'
import { authenticate } from '../middleware/auth.js'
import { requireAdmin } from '../auth/admin.js'
import { isUuid } from '../auth/scene-from.js'
import { addIncidentUpdate, createIncident, deleteIncident, statusPage, StatusInputError, type StatusPage } from '../status/checks.js'

const CACHE_MS = 30_000

/** The public status page (LIV-40), and the admin routes that post incidents to it. */
export default async function statusRoutes(app: FastifyInstance) {
  let cached: { at: number; page: StatusPage } | null = null
  const fresh = async () => {
    if (!cached || Date.now() - cached.at > CACHE_MS) cached = { at: Date.now(), page: await statusPage() }
    return cached.page
  }

  // Public: no sign-in, no personal data. Cached for 30 s, so a busy outage page doesn't add load.
  app.get('/api/status', async (_request, reply) => {
    reply.header('cache-control', 'public, max-age=30')
    return reply.send(await fresh())
  })

  await app.register(async (admin) => {
    admin.addHook('preHandler', authenticate)
    admin.addHook('preHandler', requireAdmin)
    const fail = (err: unknown) => {
      if (err instanceof StatusInputError) return { code: 400, body: { error: 'bad_input', message: err.message } }
      throw err
    }

    admin.post<{ Body: Record<string, unknown> }>('/api/admin/status/incidents', async (request, reply) => {
      try {
        const incident = await createIncident(request.body ?? {}, request.user.id)
        cached = null
        return reply.status(201).send({ incident })
      } catch (err) {
        const f = fail(err)
        return reply.status(f.code).send(f.body)
      }
    })

    admin.post<{ Params: { id: string }; Body: Record<string, unknown> }>('/api/admin/status/incidents/:id/updates', async (request, reply) => {
      if (!isUuid(request.params.id)) return reply.status(404).send({ error: 'not_found' })
      try {
        const incident = await addIncidentUpdate(request.params.id, request.body ?? {}, request.user.id)
        if (!incident) return reply.status(404).send({ error: 'not_found' })
        cached = null
        return reply.status(201).send({ incident })
      } catch (err) {
        const f = fail(err)
        return reply.status(f.code).send(f.body)
      }
    })

    admin.delete<{ Params: { id: string } }>('/api/admin/status/incidents/:id', async (request, reply) => {
      if (!isUuid(request.params.id) || !(await deleteIncident(request.params.id))) return reply.status(404).send({ error: 'not_found' })
      cached = null
      return reply.status(204).send()
    })
  })
}
