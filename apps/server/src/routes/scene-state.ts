import type { FastifyInstance } from 'fastify'
import { eq } from 'drizzle-orm'
import { db } from '../db/connection.js'
import { scenes } from '../db/schema.js'
import { authenticate } from '../middleware/auth.js'
import { actorFromClaims } from '../auth/actor.js'
import { getSceneAccess, hasScope } from '../auth/permissions.js'
import { deleteSceneState, getSceneState, setSceneState, checkState, STATE_ERROR_MESSAGES, STATE_WRITES, STATE_MAX_KEYS, STATE_MAX_BYTES, type StateWrites } from '../scenes/state.js'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Scene state (LIV-158) over REST: read with any scene access, write as an editor. The room sends it in-world. */
export default async function sceneStateRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate)

  async function gate(sceneId: string, request: any, write: boolean) {
    if (!UUID.test(sceneId)) return { status: 404, error: 'Scene not found' }
    const scene = await db.query.scenes.findFirst({ where: eq(scenes.id, sceneId), columns: { id: true, stateWrites: true, deletedAt: true } })
    if (!scene || scene.deletedAt) return { status: 404, error: 'Scene not found' }
    const access = await getSceneAccess(actorFromClaims(request.user), sceneId)
    if (access.level === 'none') return { status: 403, error: 'Forbidden' }
    if (write && !hasScope(access, 'scene.edit')) return { status: 403, error: 'Forbidden' }
    return { scene }
  }

  app.get<{ Params: { sceneId: string } }>('/api/scenes/:sceneId/state', async (request, reply) => {
    const g = await gate(request.params.sceneId, request, false)
    if ('status' in g) return reply.status(g.status!).send({ error: g.error })
    return {
      state: await getSceneState(request.params.sceneId),
      writes: g.scene.stateWrites === 'everyone' ? 'everyone' : 'staff',
      limits: { keys: STATE_MAX_KEYS, valueBytes: STATE_MAX_BYTES },
    }
  })

  app.put<{ Params: { sceneId: string; key: string }; Body: { value?: unknown } }>('/api/scenes/:sceneId/state/:key', async (request, reply) => {
    const g = await gate(request.params.sceneId, request, true)
    if ('status' in g) return reply.status(g.status!).send({ error: g.error })
    const body = request.body && typeof request.body === 'object' ? request.body : {}
    if (!('value' in body)) return reply.status(400).send({ error: 'bad_value', message: 'Send { "value": … }' })
    const r = await setSceneState(request.params.sceneId, request.params.key, body.value)
    if (!r.ok) return reply.status(r.error === 'too_many_keys' ? 409 : 400).send({ error: r.error, message: STATE_ERROR_MESSAGES[r.error] })
    return { key: request.params.key, value: JSON.parse(JSON.stringify(body.value)) }
  })

  app.delete<{ Params: { sceneId: string; key: string } }>('/api/scenes/:sceneId/state/:key', async (request, reply) => {
    const g = await gate(request.params.sceneId, request, true)
    if ('status' in g) return reply.status(g.status!).send({ error: g.error })
    if (checkState(request.params.key, undefined, false)) return reply.status(400).send({ error: 'bad_key', message: STATE_ERROR_MESSAGES.bad_key })
    if (!(await deleteSceneState(request.params.sceneId, request.params.key))) return reply.status(404).send({ error: 'Key not found' })
    return reply.status(204).send()
  })

  /** Who may write: 'staff' (editors) or 'everyone' (any visitor's scene code). */
  app.put<{ Params: { sceneId: string }; Body: { writes?: unknown } }>('/api/scenes/:sceneId/state-settings', async (request, reply) => {
    const g = await gate(request.params.sceneId, request, true)
    if ('status' in g) return reply.status(g.status!).send({ error: g.error })
    const writes = request.body?.writes
    if (!STATE_WRITES.includes(writes as StateWrites)) return reply.status(400).send({ error: 'bad_writes', message: "writes is 'staff' or 'everyone'" })
    await db.update(scenes).set({ stateWrites: writes as StateWrites }).where(eq(scenes.id, request.params.sceneId))
    return { writes }
  })
}
