/**
 * Scene Deployment Routes — Build and deploy scenes to platforms.
 *
 * GET    /api/deploy/:id              — Get deployment status
 * GET    /api/deploy/:id/files.zip    — The files a World deployment put live, as a zip
 * GET    /api/deploy/scene/:sceneId   — List deployments for a scene
 * POST   /api/deploy/:id/cancel       — Cancel a pending/building deployment
 * GET    /api/deploy/platforms        — Platforms this server can deploy to
 */

import type { FastifyInstance, FastifyRequest } from 'fastify'
import { eq, desc } from 'drizzle-orm'
import { db } from '../db/connection.js'
import { sceneDeployments } from '../db/schema.js'
import { authenticate } from '../middleware/auth.js'
import { hyperfyHosting } from '../services/hyperfy/infrastructure.js'
import { actorFromClaims } from '../auth/actor.js'
import { getSceneAccess, hasScope, isFullAccess } from '../auth/permissions.js'
import { DownloadError, planDownload, zipEntries } from '../services/dcl/deployed-files.js'

type Deployment = typeof sceneDeployments.$inferSelect

/** Copy of a deployment safe to send to clients: the Hyperfy admin code never leaves the server. */
export function publicDeployment(d: Deployment): Deployment {
  const { adminCode: _, ...target } = (d.target ?? {}) as Record<string, unknown>
  return { ...d, target }
}

/** Load a deployment the caller may see (`read`: scene.edit) or change (`manage`: full access); null otherwise. */
export async function deploymentForCaller(
  request: FastifyRequest,
  id: string,
  need: 'read' | 'manage',
): Promise<Deployment | null> {
  if (!UUID.test(id)) return null
  const deployment = await db.query.sceneDeployments.findFirst({ where: eq(sceneDeployments.id, id) })
  if (!deployment) return null
  const access = await getSceneAccess(actorFromClaims(request.user), deployment.sceneId)
  const ok = need === 'manage' ? isFullAccess(access) : hasScope(access, 'scene.edit')
  return ok ? deployment : null
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export default async function deployRoutes(app: FastifyInstance) {
  // ── Get Deployment Status ─────────────────────────────────────────────
  app.get(
    '/api/deploy/:id',
    { preHandler: [authenticate] },
    async (request, reply) => {
      const { id } = request.params as { id: string }

      const deployment = await deploymentForCaller(request, id, 'read')

      if (!deployment) {
        return reply.status(404).send({ error: 'Deployment not found' })
      }

      return reply.send({ deployment: publicDeployment(deployment) })
    },
  )

  // ── Download What Went Live ───────────────────────────────────────────
  app.get(
    '/api/deploy/:id/files.zip',
    { preHandler: [authenticate] },
    async (request, reply) => {
      const { id } = request.params as { id: string }
      const deployment = await deploymentForCaller(request, id, 'read')
      if (!deployment) return reply.status(404).send({ error: 'Deployment not found' })

      let plan: Awaited<ReturnType<typeof planDownload>>
      try {
        plan = await planDownload(deployment)
      } catch (err) {
        if (err instanceof DownloadError) return reply.status(err.status).send({ error: err.code, message: err.message })
        throw err
      }
      return reply
        .type('application/zip')
        .header('Content-Disposition', `attachment; filename="${plan.filename}"`)
        .header('Cache-Control', 'private, no-store')
        .send(zipEntries(plan.entries))
    },
  )

  // ── List Deployments for Scene ────────────────────────────────────────
  app.get(
    '/api/deploy/scene/:sceneId',
    { preHandler: [authenticate] },
    async (request, reply) => {
      const { sceneId } = request.params as { sceneId: string }

      if (!UUID.test(sceneId) || !hasScope(await getSceneAccess(actorFromClaims(request.user), sceneId), 'scene.edit')) {
        return reply.status(404).send({ error: 'Scene not found' })
      }

      const deployments = await db
        .select()
        .from(sceneDeployments)
        .where(eq(sceneDeployments.sceneId, sceneId))
        .orderBy(desc(sceneDeployments.createdAt))
        .limit(20)

      return reply.send({ deployments: deployments.map(publicDeployment) })
    },
  )

  // ── Cancel Deployment ─────────────────────────────────────────────────
  app.post(
    '/api/deploy/:id/cancel',
    { preHandler: [authenticate] },
    async (request, reply) => {
      const { id } = request.params as { id: string }

      const deployment = await deploymentForCaller(request, id, 'manage')

      if (!deployment) {
        return reply.status(404).send({ error: 'Deployment not found' })
      }

      if (deployment.status !== 'pending' && deployment.status !== 'building') {
        return reply.status(400).send({
          error: 'Can only cancel pending or building deployments',
        })
      }

      const [updated] = await db
        .update(sceneDeployments)
        .set({ status: 'failed', errorMessage: 'Cancelled by user' })
        .where(eq(sceneDeployments.id, id))
        .returning()

      return reply.send({ deployment: publicDeployment(updated) })
    },
  )

  /** Which platforms this server can deploy to right now. */
  app.get('/api/deploy/platforms', { preHandler: [authenticate] }, async () => ({
    platforms: { decentraland: true, hyperfy: hyperfyHosting().available },
  }))
}
