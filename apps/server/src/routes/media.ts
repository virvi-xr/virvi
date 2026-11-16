import type { FastifyInstance } from 'fastify'
import { and, eq, inArray, isNull, or } from 'drizzle-orm'
import { db } from '../db/connection.js'
import { beats, mediaAssets } from '../db/schema.js'
import { authenticate } from '../middleware/auth.js'
import { createStorage } from '../storage/index.js'
import { storeMedia, StoreMediaError, USE_ASSET_LIBRARY } from '../media/store.js'
import { isModelFile } from '../storage/upload-policy.js'

export { USE_ASSET_LIBRARY }

const storage = createStorage()

export default async function mediaRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate)

  // POST /api/media/upload — Upload a file
  // Accepts multipart/form-data with a 'file' field
  // For simplicity in MVP, accept base64-encoded file in JSON body
  app.post<{ Body: { filename: string; contentType: string; data: string } }>(
    '/api/media/upload',
    async (request, reply) => {
      const { filename, contentType, data } = request.body
      if (!filename || !contentType || !data) {
        return reply.status(400).send({ error: 'filename, contentType, and data (base64) are required' })
      }

      // Images & Video takes no models (storeMedia refuses them too; this answers before the bytes are decoded)
      if (isModelFile(filename, contentType)) return reply.status(415).send(USE_ASSET_LIBRARY)

      try {
        const asset = await storeMedia(request.user.id, { filename, contentType, data: Buffer.from(data, 'base64') })
        return reply.status(201).send({ asset })
      } catch (e) {
        if (e instanceof StoreMediaError) return reply.status(e.status).send(e.body)
        throw e
      }
    },
  )

  // GET /api/media — List user's media assets
  app.get('/api/media', async (request, reply) => {
    const assets = await db.query.mediaAssets.findMany({
      // Unfinished (in-flight or failed) companion uploads have no file to pick yet
      where: and(eq(mediaAssets.ownerId, request.user.id), eq(mediaAssets.status, 'ready')),
      orderBy: (mediaAssets, { desc }) => [desc(mediaAssets.createdAt)],
    })
    return reply.send({ assets })
  })

  // DELETE /api/media/:assetId — Delete a media asset
  app.delete<{ Params: { assetId: string } }>(
    '/api/media/:assetId',
    async (request, reply) => {
      const { assetId } = request.params
      const asset = await db.query.mediaAssets.findFirst({
        where: eq(mediaAssets.id, assetId),
      })
      if (!asset) return reply.status(404).send({ error: 'Asset not found' })
      if (asset.ownerId !== request.user.id && request.user.role !== 'admin') {
        return reply.status(403).send({ error: 'Forbidden' })
      }
      // A paid or live BEAT's art (standards I1), or an ended one's not yet frozen: deleting it would orphan the token art
      const [usedBy] = await db.select({ id: beats.id }).from(beats).where(and(
        eq(beats.imageMediaId, assetId),
        or(inArray(beats.status, ['paid', 'live']), and(eq(beats.status, 'ended'), isNull(beats.imageUrl))),
      )).limit(1)
      if (usedBy) {
        return reply.status(409).send({ error: 'in_use_by_beat', message: 'This image is the art of a paid or running BEAT, so it can\'t be deleted.', beatId: usedBy.id })
      }

      if (asset.storageKey) await storage.delete(asset.storageKey)
      await db.delete(mediaAssets).where(eq(mediaAssets.id, assetId))
      return reply.status(204).send()
    },
  )
}
