/**
 * Asset Library Routes — Browse, search, and manage 3D assets.
 *
 * GET    /api/assets            — Browse/search asset catalog (?mine=all|studio|uploads, ?scope=public)
 * GET    /api/assets/:id        — Get single asset details
 * POST   /api/assets            — Upload a new asset (authenticated)
 * PUT    /api/assets/:id        — Update asset metadata (authenticated)
 * DELETE /api/assets/:id        — Delete an asset (authenticated)
 * GET    /api/assets/categories — List all categories
 */

import { FastifyInstance } from 'fastify'
import { randomUUID } from 'node:crypto'
import { eq, ilike, and, or, sql, arrayContains, inArray, isNull, like, notLike, desc } from 'drizzle-orm'

/** The `mine` filter's values: the caller's assets, only the Design Studio's, or only the rest. */
const MINE = ['all', 'studio', 'uploads']
import { db } from '../db/connection.js'
import { assetLibraryItems, catalogPacks, roomSets } from '../db/schema.js'
import { browsableAsset } from '../catalog/visibility.js'
import { authenticate } from '../middleware/auth.js'
import { createStorage } from '../storage/index.js'
import { classifyUpload, extensionFor } from '../storage/upload-policy.js'
import { assertStorageQuota } from '../media/quota.js'
import { StoreMediaError } from '../media/store.js'
import { verifySessionToken } from '../auth/tokens.js'
import { isVirviAdmin } from '../auth/admin.js'
import { generateThumbnail } from '../services/thumbnails.js'
import { releaseRoomSetObject } from '../room-scan/sets.js'
import { withoutUploadCode } from '../library/model-uploads.js'

const CATALOG_MODEL = { error: 'catalog_model', message: "Catalog models can't be changed or deleted; switch the pack off in Admin → Catalog packs instead" }

/** Optional bearer: scene-pass, API-key and bad tokens count as anonymous (null). */
function optionalAccount(authorization: string | undefined) {
  const bearer = authorization?.startsWith('Bearer ') ? authorization.slice(7) : null
  const claims = bearer && !bearer.startsWith('virvi_') ? verifySessionToken(bearer) : null
  return claims?.kind === 'account' ? claims : null
}

/** Made from a room scan: category `room`, or backed by a room set. */
async function isRoomAsset(asset: { id: string; category: string | null }): Promise<boolean> {
  if (asset.category === 'room') return true
  const [set] = await db.select({ id: roomSets.id }).from(roomSets).where(eq(roomSets.assetItemId, asset.id)).limit(1)
  return !!set
}

export default async function assetRoutes(app: FastifyInstance) {
  const storage = createStorage()

  // ── Browse / Search ───────────────────────────────────────────────────
  // Browsing is public; a trial bearer reads as signed out (public assets only). `config.trial` marks it as open to trials.
  app.get('/api/assets', { config: { trial: true } }, async (request, reply) => {
    const query = request.query as {
      q?: string
      category?: string
      tag?: string
      style?: string
      venue?: string
      pack?: string
      mine?: string
      scope?: string
      maxTriangles?: string
      maxFileSize?: string
      limit?: string
      offset?: string
    }

    const conditions: any[] = []

    // Public assets, plus the caller's own private ones when authenticated. `scope=public` (the Asset Library's All Assets
    // view) keeps to public assets only, so it stays clearly different from My Assets.
    if (query.scope !== undefined && query.scope !== 'public') return reply.status(400).send({ error: 'scope must be public' })
    const caller = optionalAccount(request.headers.authorization)
    conditions.push(
      caller && query.scope !== 'public'
        ? or(eq(assetLibraryItems.isPublic, true), eq(assetLibraryItems.uploadedBy, caller.id))
        : eq(assetLibraryItems.isPublic, true),
    )

    // Only the caller's own assets: `all`, `studio` (finalized Design Studio pieces) or `uploads` (everything else they
    // added). Signed out, there is nothing of theirs to show.
    if (query.mine) {
      if (!MINE.includes(query.mine)) return reply.status(400).send({ error: 'mine must be all, studio or uploads' })
      if (!caller) return reply.send({ assets: [], total: 0, limit: 0, offset: 0 })
      conditions.push(eq(assetLibraryItems.uploadedBy, caller.id))
      if (query.mine === 'studio') conditions.push(like(assetLibraryItems.sourceRef, 'studio:%'))
      if (query.mine === 'uploads') conditions.push(or(isNull(assetLibraryItems.sourceRef), notLike(assetLibraryItems.sourceRef, 'studio:%')))
    }

    if (query.q) {
      conditions.push(
        or(
          ilike(assetLibraryItems.name, `%${query.q}%`),
          ilike(assetLibraryItems.description, `%${query.q}%`),
        ),
      )
    }

    if (query.category) {
      // Comma-separated: matches any of the listed categories
      const cats = query.category.split(',').map((c) => c.trim()).filter(Boolean)
      if (cats.length) conditions.push(cats.length === 1 ? eq(assetLibraryItems.category, cats[0]) : inArray(assetLibraryItems.category, cats))
    }

    if (query.tag) {
      conditions.push(arrayContains(assetLibraryItems.tags, [query.tag]))
    }

    // Catalog: switched-off packs are hidden from browsing. In-world uploads still in flight (or failed) have no file
    // to place yet: the scene's library shows those
    conditions.push(browsableAsset())
    conditions.push(eq(assetLibraryItems.status, 'ready'))
    if (query.style) conditions.push(eq(assetLibraryItems.style, query.style))
    if (query.venue) conditions.push(arrayContains(assetLibraryItems.venueTags, [query.venue]))
    if (query.pack) conditions.push(eq(assetLibraryItems.packId, query.pack))

    if (query.maxTriangles) {
      conditions.push(
        sql`${assetLibraryItems.triangleCount} <= ${parseInt(query.maxTriangles)}`,
      )
    }

    if (query.maxFileSize) {
      conditions.push(
        sql`${assetLibraryItems.fileSizeBytes} <= ${parseInt(query.maxFileSize)}`,
      )
    }

    const limit = Math.min(parseInt(query.limit || '50'), 100)
    const offset = parseInt(query.offset || '0')

    const rows = await db
      .select({
        a: assetLibraryItems,
        pack: { id: catalogPacks.id, name: catalogPacks.name, license: catalogPacks.license, attribution: catalogPacks.attribution },
      })
      .from(assetLibraryItems)
      .leftJoin(catalogPacks, eq(catalogPacks.id, assetLibraryItems.packId))
      .where(and(...conditions))
      .limit(limit)
      .offset(offset)
      // Your own models newest first (a just-uploaded one is on the first page); browsing keeps the catalog's order
      .orderBy(...(query.mine ? [desc(assetLibraryItems.createdAt), desc(assetLibraryItems.id)] : [assetLibraryItems.createdAt]))
    const items = rows.map((r) => ({ ...withoutUploadCode(r.a), pack: r.pack?.id ? r.pack : null }))

    const [countResult] = await db
      .select({ count: sql<number>`count(*)` })
      .from(assetLibraryItems)
      .where(and(...conditions))

    return reply.send({
      assets: items,
      total: Number(countResult.count),
      limit,
      offset,
    })
  })

  // ── Get Single Asset ──────────────────────────────────────────────────
  app.get('/api/assets/:id', { config: { trial: true } }, async (request, reply) => {
    const { id } = request.params as { id: string }

    const asset = await db.query.assetLibraryItems.findFirst({
      where: eq(assetLibraryItems.id, id),
    })

    // Private assets are visible to their uploader and admins only
    const caller = optionalAccount(request.headers.authorization)
    // An admin claim is checked against the database, so a demoted admin's old token sees only what anyone sees
    const visible = asset && (asset.isPublic || (caller && (asset.uploadedBy === caller.id
      || (caller.role === 'admin' && await isVirviAdmin(caller.id)))))
    if (!asset || !visible) {
      return reply.status(404).send({ error: 'Asset not found' })
    }

    // Catalog models carry their pack's credit (shown even when the pack is switched off: the model may be in use)
    const pack = asset.packId
      ? (await db
          .select({ id: catalogPacks.id, name: catalogPacks.name, license: catalogPacks.license, attribution: catalogPacks.attribution })
          .from(catalogPacks)
          .where(eq(catalogPacks.id, asset.packId)))[0] ?? null
      : null
    return reply.send({ asset: { ...withoutUploadCode(asset), pack } })
  })

  // ── Upload New Asset ──────────────────────────────────────────────────
  app.post(
    '/api/assets',
    { preHandler: [authenticate] },
    async (request, reply) => {
      const body = request.body as {
        name: string
        description?: string
        category?: string
        tags?: string[]
        fileData: string // base64 encoded
        contentType: string
        filename: string
        triangleCount?: number
        textureCount?: number
        materialCount?: number
        dimensions?: { width: number; height: number; depth: number }
        license?: string
        author?: string
        isPublic?: boolean
      }

      if (!body.name || !body.fileData || !body.contentType) {
        return reply.status(400).send({
          error: 'Missing required fields: name, fileData, contentType',
        })
      }

      const buffer = Buffer.from(body.fileData, 'base64')
      const verdict = classifyUpload(body.filename || 'asset.glb', body.contentType, buffer.length)
      if (!verdict.ok) return reply.status(verdict.status).send({ error: verdict.error })
      // The asset library holds 3D models only
      if (verdict.contentType !== 'model/gltf-binary') return reply.status(415).send({ error: 'unsupported_type' })

      try {
        await assertStorageQuota(request.user.id, buffer.length)
      } catch (err) {
        if (err instanceof StoreMediaError) return reply.status(err.status).send(err.body)
        throw err
      }

      const key = `assets/${request.user.id}/${randomUUID()}.${extensionFor(verdict.contentType)}`
      const publicUrl = await storage.upload(key, buffer, verdict.contentType)

      const [asset] = await db
        .insert(assetLibraryItems)
        .values({
          name: body.name,
          description: body.description || null,
          category: body.category || null,
          tags: body.tags || null,
          storageKey: key,
          cdnUrl: publicUrl,
          thumbnailUrl: null,
          fileSizeBytes: buffer.length,
          triangleCount: body.triangleCount || null,
          textureCount: body.textureCount || null,
          materialCount: body.materialCount || null,
          dimensions: body.dimensions || null,
          license: body.license || null,
          author: body.author || null,
          isPublic: body.isPublic ?? false,
          uploadedBy: request.user.id,
        })
        .returning()

      // Generate thumbnail after insert so we can use the real asset ID
      try {
        const thumbnailUrl = await generateThumbnail(buffer, verdict.contentType, asset.id)
        if (thumbnailUrl) {
          await db
            .update(assetLibraryItems)
            .set({ thumbnailUrl })
            .where(eq(assetLibraryItems.id, asset.id))
          asset.thumbnailUrl = thumbnailUrl
        }
      } catch (err) {
        // Thumbnail generation is non-critical; log and continue
        request.log.warn({ err }, 'Failed to generate thumbnail')
      }

      return reply.status(201).send({ asset: withoutUploadCode(asset) })
    },
  )

  // ── Update Asset Metadata ─────────────────────────────────────────────
  app.put(
    '/api/assets/:id',
    { preHandler: [authenticate] },
    async (request, reply) => {
      const { id } = request.params as { id: string }
      const body = request.body as Record<string, unknown>

      const existing = await db.query.assetLibraryItems.findFirst({
        where: eq(assetLibraryItems.id, id),
      })

      if (!existing) {
        return reply.status(404).send({ error: 'Asset not found' })
      }

      // Only owner or admin can update
      if (existing.uploadedBy !== request.user.id && request.user.role !== 'admin') {
        return reply.status(403).send({ error: 'Forbidden' })
      }
      // Catalog models are shared by every scene that uses them: they change only through the importer
      if (existing.packId) return reply.status(409).send(CATALOG_MODEL)
      // A room set is the layout of someone's home: it never becomes public
      if (body.isPublic === true && (await isRoomAsset(existing))) return reply.status(400).send({ error: 'room_assets_private' })

      const updates: Record<string, unknown> = {}
      if (body.name !== undefined) updates.name = body.name
      if (body.description !== undefined) updates.description = body.description
      if (body.category !== undefined) updates.category = body.category
      if (body.tags !== undefined) updates.tags = body.tags
      if (body.license !== undefined) updates.license = body.license
      if (body.author !== undefined) updates.author = body.author
      if (body.isPublic !== undefined) updates.isPublic = body.isPublic

      const [updated] = await db
        .update(assetLibraryItems)
        .set(updates)
        .where(eq(assetLibraryItems.id, id))
        .returning()

      return reply.send({ asset: withoutUploadCode(updated) })
    },
  )

  // ── Delete Asset ──────────────────────────────────────────────────────
  app.delete(
    '/api/assets/:id',
    { preHandler: [authenticate] },
    async (request, reply) => {
      const { id } = request.params as { id: string }

      const existing = await db.query.assetLibraryItems.findFirst({
        where: eq(assetLibraryItems.id, id),
      })

      if (!existing) {
        return reply.status(404).send({ error: 'Asset not found' })
      }

      if (existing.uploadedBy !== request.user.id && request.user.role !== 'admin') {
        return reply.status(403).send({ error: 'Forbidden' })
      }
      // Deleting would break every scene that placed it; switch its pack off instead
      if (existing.packId) return reply.status(409).send(CATALOG_MODEL)
      // An in-world upload still arriving: its file is being stored right now (dismiss it in-world once it's done or failed)
      if (existing.status === 'uploading' || existing.status === 'processing') return reply.status(409).send({ error: 'upload_in_progress', message: "This model is still uploading. Try again once it's finished." })

      // A room set's GLB may still be placed by URL somewhere (a scene that placed it after its scan was deleted)
      if (await isRoomAsset(existing)) {
        await releaseRoomSetObject({ storageKey: existing.storageKey, glbUrl: existing.cdnUrl ?? '' }, { assetItemId: id })
      } else {
        await storage.delete(existing.storageKey)
      }
      await db.delete(assetLibraryItems).where(eq(assetLibraryItems.id, id))

      return reply.send({ deleted: true })
    },
  )

  // ── List Categories ───────────────────────────────────────────────────
  app.get('/api/assets/categories', { config: { trial: true } }, async (_request, reply) => {
    const result = await db
      .select({ category: assetLibraryItems.category })
      .from(assetLibraryItems)
      .where(and(eq(assetLibraryItems.isPublic, true), browsableAsset()))
      .groupBy(assetLibraryItems.category)

    const categories = result
      .map((r) => r.category)
      .filter(Boolean)

    return reply.send({ categories })
  })
}
