import type { FastifyInstance } from 'fastify'
import { and, eq, isNotNull, or } from 'drizzle-orm'
import { db } from '../db/connection.js'
import { assetLibraryItems, mediaAssets, sceneLibrary } from '../db/schema.js'
import { authenticate } from '../middleware/auth.js'
import { actorFromClaims } from '../auth/actor.js'
import { getSceneAccess, hasScope, isFullAccess } from '../auth/permissions.js'
import { fromParam, isScenePass, isUuid } from '../auth/scene-from.js'
import { getSceneLibraryItem, linkToScene, listSceneLibrary, uploadDestination } from '../library/scene-library.js'
import { storeMedia, StoreMediaError } from '../media/store.js'
import { publishLibraryChanged } from '../realtime/bus.js'
import { PackDisabledError } from '../catalog/visibility.js'

export default async function sceneLibraryRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate)
  // Malformed ids would reach Postgres as invalid uuids (500); they name nothing, so 404.
  app.addHook('preHandler', async (request, reply) => {
    const p = (request.params ?? {}) as Record<string, unknown>
    for (const k of ['sceneId', 'id']) if (k in p && !isUuid(p[k])) return reply.status(404).send({ error: 'Not found' })
  })
  const access = (request: any, sceneId: string) => getSceneAccess(actorFromClaims(request.user), sceneId)

  app.get<{ Params: { sceneId: string } }>('/api/scenes/:sceneId/library', { config: { scenePass: { sceneFrom: fromParam('sceneId'), hyperfy: true, ar: true } } }, async (request, reply) => {
    if ((await access(request, request.params.sceneId)).level === 'none') return reply.status(403).send({ error: 'forbidden' })
    return reply.send({ items: await listSceneLibrary(request.params.sceneId) })
  })

  // A scene pass (the Hyperfy HUD) may add public catalog models only: it can't pull the account's own files into a scene.
  app.post<{ Params: { sceneId: string }; Body: { mediaAssetId?: string; assetItemId?: string } }>('/api/scenes/:sceneId/library', { config: { scenePass: { sceneFrom: fromParam('sceneId'), hyperfy: true, ar: true } } }, async (request, reply) => {
    const { sceneId } = request.params
    const { mediaAssetId, assetItemId } = request.body ?? {}
    if (isScenePass(request.user) && !assetItemId) return reply.status(403).send({ error: 'forbidden' })
    if (!!mediaAssetId === !!assetItemId) return reply.status(400).send({ error: 'Give exactly one of mediaAssetId or assetItemId' })
    if (!isUuid(mediaAssetId ?? assetItemId)) return reply.status(400).send({ error: 'Invalid id' })
    if (!hasScope(await access(request, sceneId), 'scene.edit')) return reply.status(403).send({ error: 'forbidden' })
    const owns = mediaAssetId
      ? await db.query.mediaAssets.findFirst({ where: and(eq(mediaAssets.id, mediaAssetId), eq(mediaAssets.ownerId, request.user.id)) })
      : await db.query.assetLibraryItems.findFirst({
          // Your own upload, or a public catalog model (linkToScene refuses one in a switched-off pack)
          where: and(
            eq(assetLibraryItems.id, assetItemId!),
            or(...(isScenePass(request.user) ? [] : [eq(assetLibraryItems.uploadedBy, request.user.id)]), and(eq(assetLibraryItems.isPublic, true), isNotNull(assetLibraryItems.packId))),
          ),
        })
    if (!owns) return reply.status(403).send({ error: 'forbidden' })
    try {
      return reply.status(201).send({ id: await linkToScene(sceneId, { mediaAssetId, assetItemId }, request.user.id) })
    } catch (err) {
      if (err instanceof PackDisabledError) return reply.status(409).send({ error: err.code, message: err.message })
      throw err
    }
  })

  app.delete<{ Params: { sceneId: string; id: string } }>('/api/scenes/:sceneId/library/:id', { config: { scenePass: { sceneFrom: fromParam('sceneId'), ar: 'personal' } } }, async (request, reply) => {
    const { sceneId, id } = request.params
    const row = await db.query.sceneLibrary.findFirst({ where: and(eq(sceneLibrary.id, id), eq(sceneLibrary.sceneId, sceneId)) })
    if (!row) return reply.status(404).send({ error: 'Not found' })
    const media = row.mediaAssetId
      ? await db.query.mediaAssets.findFirst({ where: eq(mediaAssets.id, row.mediaAssetId), columns: { status: true } })
      : null
    const a = await access(request, sceneId)
    // Any editor may dismiss a failed upload (the HUD shows Dismiss on every failed row)
    const allowed = isFullAccess(a) || (hasScope(a, 'scene.edit') && (row.addedBy === request.user.id || media?.status === 'failed'))
    if (!allowed) return reply.status(403).send({ error: 'forbidden' })
    // Dismissing a failed or abandoned upload removes the file record too (the cascade drops the link)
    if (media && (media.status === 'failed' || media.status === 'uploading')) {
      await db.delete(mediaAssets).where(eq(mediaAssets.id, row.mediaAssetId!))
    } else {
      await db.delete(sceneLibrary).where(eq(sceneLibrary.id, id))
    }
    await publishLibraryChanged(sceneId, id, true)
    return reply.status(204).send()
  })

  // Rename a file in the library (its stored filename). Editors may rename the scene's own files; a renter's
  // booking files only by full access. The extension is kept: GLB detection and the stored type key off it.
  app.patch<{ Params: { sceneId: string; id: string }; Body: { name?: unknown } }>('/api/scenes/:sceneId/library/:id', { config: { scenePass: { sceneFrom: fromParam('sceneId'), ar: 'personal' } } }, async (request, reply) => {
    const { sceneId, id } = request.params
    const raw = request.body?.name
    const trimmed = typeof raw === 'string' ? raw.trim() : ''
    if (!trimmed || trimmed.length > 120 || /[\\/]/.test(trimmed)) return reply.status(400).send({ error: 'Name must be 1-120 characters, without slashes' })
    const row = await db.query.sceneLibrary.findFirst({ where: and(eq(sceneLibrary.id, id), eq(sceneLibrary.sceneId, sceneId)) })
    if (!row) return reply.status(404).send({ error: 'Not found' })
    const a = await access(request, sceneId)
    const allowed = isFullAccess(a) || (hasScope(a, 'scene.edit') && row.bookingId === null)
    if (!allowed) return reply.status(403).send({ error: 'forbidden' })
    if (!row.mediaAssetId) return reply.status(400).send({ error: 'Catalog models can only be renamed on the dashboard' })
    const media = await db.query.mediaAssets.findFirst({ where: eq(mediaAssets.id, row.mediaAssetId) })
    if (!media) return reply.status(404).send({ error: 'Not found' })
    if (media.status !== 'ready') return reply.status(409).send({ error: "That file isn't ready yet" })
    const ext = /\.[A-Za-z0-9]{1,5}$/.exec(media.filename)?.[0] ?? ''
    const filename = ext && !trimmed.toLowerCase().endsWith(ext.toLowerCase()) ? `${trimmed}${ext}` : trimmed
    await db.update(mediaAssets).set({ filename }).where(eq(mediaAssets.id, media.id))
    await publishLibraryChanged(sceneId, id)
    return reply.send({ item: await getSceneLibraryItem(sceneId, id) })
  })

  app.post<{ Params: { sceneId: string }; Body: { filename?: string; contentType?: string; data?: string } }>(
    '/api/scenes/:sceneId/library/upload',
    { config: { scenePass: { sceneFrom: fromParam('sceneId') } } },
    async (request, reply) => {
      const { sceneId } = request.params
      const { filename, contentType, data } = request.body ?? {}
      if (!filename || !contentType || !data) return reply.status(400).send({ error: 'filename, contentType and data are required' })
      const dest = await uploadDestination(actorFromClaims(request.user), sceneId)
      if (!dest) return reply.status(403).send({ error: 'forbidden' })
      try {
        const m = await storeMedia(dest.ownerId, { filename, contentType, data: Buffer.from(data, 'base64') }, { quotaStatus: 413, quotaMessage: dest.bookingId ? undefined : "The scene owner's storage is full" })
        await linkToScene(sceneId, { mediaAssetId: m.id }, request.user.id, dest.bookingId)
        const item = (await listSceneLibrary(sceneId)).find((i) => i.url === m.publicUrl)
        return reply.status(201).send({ item })
      } catch (e) {
        if (e instanceof StoreMediaError) return reply.status(e.status).send(e.body)
        throw e
      }
    },
  )
}
