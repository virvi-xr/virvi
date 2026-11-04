/**
 * Scene backup route.
 *
 * GET /api/scenes/:sceneId/backup.zip[?destination=<id>] — a ready-to-deploy Decentraland project of the scene, without
 *   Virvi; a scene Virvi built is placed at `destination` (one of the scene's) when given
 */

import type { FastifyInstance } from 'fastify'
import { and, eq } from 'drizzle-orm'
import { db } from '../db/connection.js'
import { dclWorldDestinations, scenes } from '../db/schema.js'
import { authenticate } from '../middleware/auth.js'
import { actorFromClaims } from '../auth/actor.js'
import { getSceneAccess, hasScope, isFullAccess } from '../auth/permissions.js'
import { BackupError } from '../services/backup/project.js'
import { runBackup } from '../services/backup/download.js'
import { filenameSafe, utcStamp, zipFiles } from '../services/dcl/deployed-files.js'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export default async function backupRoutes(app: FastifyInstance) {
  app.get<{ Params: { sceneId: string }; Querystring: { destination?: string } }>(
    '/api/scenes/:sceneId/backup.zip',
    { preHandler: [authenticate] },
    async (request, reply) => {
      const { sceneId } = request.params
      const scene = UUID.test(sceneId) ? await db.query.scenes.findFirst({ where: eq(scenes.id, sceneId) }) : null
      if (!scene) return reply.status(404).send({ error: 'Scene not found' })
      const access = await getSceneAccess(actorFromClaims(request.user), sceneId)
      if (!hasScope(access, 'scene.edit')) return reply.status(403).send({ error: 'Forbidden' })
      const { destination } = request.query
      if (destination !== undefined) {
        const ours = UUID.test(destination) && await db.query.dclWorldDestinations.findFirst({
          where: and(eq(dclWorldDestinations.id, destination), eq(dclWorldDestinations.sceneId, sceneId)), columns: { id: true },
        })
        if (!ours) return reply.status(404).send({ error: 'destination_not_found', message: 'That destination is not one of this scene\'s.' })
      }

      // A client can leave during the build; the response's `close` has fired by then and won't again
      let closed = false
      const onClose = () => { closed = true }
      reply.raw.once('close', onClose)
      let run: Awaited<ReturnType<typeof runBackup>>
      try {
        run = await runBackup(sceneId, { caller: { userId: request.user.id, fullAccess: isFullAccess(access) }, destinationId: destination })
      } catch (err) {
        reply.raw.off('close', onClose)
        if (err instanceof BackupError) return reply.status(err.status).send({ error: err.code, message: err.message })
        throw err
      }
      reply.raw.off('close', onClose)
      if (closed || reply.raw.destroyed || request.raw.destroyed) {
        run.release()
        return reply.hijack() // nobody to send it to
      }
      // The files stay in memory while the zip streams to the client: the slot is held until the response closes
      reply.raw.once('close', run.release)
      try {
        return reply
          .type('application/zip')
          .header('Content-Disposition', `attachment; filename="${filenameSafe(scene.name)}-backup-${utcStamp(new Date())}.zip"`)
          .header('Cache-Control', 'private, no-store')
          .send(zipFiles(run.files))
      } catch (err) {
        run.release()
        throw err
      }
    },
  )
}
