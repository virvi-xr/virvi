/**
 * Scene backup route.
 *
 * GET /api/scenes/:sceneId/backup.zip — a ready-to-deploy Decentraland project of the scene, without Virvi
 */

import type { FastifyInstance } from 'fastify'
import { eq } from 'drizzle-orm'
import { db } from '../db/connection.js'
import { scenes } from '../db/schema.js'
import { authenticate } from '../middleware/auth.js'
import { actorFromClaims } from '../auth/actor.js'
import { getSceneAccess, hasScope } from '../auth/permissions.js'
import { BackupError } from '../services/backup/project.js'
import { runBackup } from '../services/backup/download.js'
import { filenameSafe, utcStamp, zipFiles } from '../services/dcl/deployed-files.js'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export default async function backupRoutes(app: FastifyInstance) {
  app.get<{ Params: { sceneId: string } }>(
    '/api/scenes/:sceneId/backup.zip',
    { preHandler: [authenticate] },
    async (request, reply) => {
      const { sceneId } = request.params
      const scene = UUID.test(sceneId) ? await db.query.scenes.findFirst({ where: eq(scenes.id, sceneId) }) : null
      if (!scene) return reply.status(404).send({ error: 'Scene not found' })
      if (!hasScope(await getSceneAccess(actorFromClaims(request.user), sceneId), 'scene.edit')) return reply.status(403).send({ error: 'Forbidden' })

      let files: Map<string, Uint8Array>
      try {
        ;({ files } = await runBackup(sceneId))
      } catch (err) {
        if (err instanceof BackupError) return reply.status(err.status).send({ error: err.code, message: err.message })
        throw err
      }
      return reply
        .type('application/zip')
        .header('Content-Disposition', `attachment; filename="${filenameSafe(scene.name)}-backup-${utcStamp(new Date())}.zip"`)
        .header('Cache-Control', 'private, no-store')
        .send(zipFiles(files))
    },
  )
}
