import { and, eq, sql } from 'drizzle-orm'
import { db } from '../db/connection.js'
import { assetLibraryItems, mediaAssets, sceneLibrary } from '../db/schema.js'
import { publishLibraryChanged } from '../realtime/bus.js'
import { modelName } from './model-uploads.js'

/**
 * LIV-132: Images & Video (media_assets) holds images and video only. 3D models uploaded there before the split move to
 * 3D Models (asset_library_items) as private models of the same owner, keeping the stored file and its URL exactly
 * where they are, so every scene that places one keeps working (elements and instances reference files by URL).
 *
 * Each move is one transaction: the new asset item, the scene-library links switched over in place (same link id, so
 * the HUD's rows and live updates carry on), then the media row deleted. No file is ever deleted. Quota is unchanged:
 * the bytes leave the owner's media total and join their asset-library uploads (media/quota.ts counts both).
 * Safe to run twice and on several replicas at once: the media row is locked, and once moved it no longer exists.
 */

/** Media rows that are 3D models (by type or by name: old uploads may be stored as octet-stream). */
const IS_MODEL = sql`(${mediaAssets.contentType} ILIKE 'model/gltf%' OR ${mediaAssets.filename} ~* '\\.(glb|gltf)$')`

/** An upload with no file this long after it started was abandoned (as library/scene-library.ts STALE_UPLOAD_MS). */
const STALE_MS = 15 * 60_000

export type MoveResult = 'moved' | 'dropped' | 'skipped'

/**
 * Move one media row if it is a stored 3D model; drop it if it's a model upload that never stored a file (failed or
 * abandoned: there's no file to keep). Anything else, including an upload still in flight, is left alone.
 */
export async function moveMediaModel(mediaId: string, now: Date = new Date()): Promise<{ result: MoveResult; assetItemId?: string }> {
  const outcome = await db.transaction(async (tx) => {
    const [m] = await tx.select().from(mediaAssets).where(and(eq(mediaAssets.id, mediaId), IS_MODEL)).for('update')
    if (!m) return null
    if (m.status === 'ready' && m.storageKey && m.publicUrl) {
      const [item] = await tx.insert(assetLibraryItems).values({
        name: modelName(m.filename),
        storageKey: m.storageKey,
        cdnUrl: m.publicUrl,
        fileSizeBytes: m.sizeBytes,
        isPublic: false,
        uploadedBy: m.ownerId,
        createdAt: m.createdAt,
        status: 'ready',
      }).returning({ id: assetLibraryItems.id })
      const links = await tx.update(sceneLibrary)
        .set({ mediaAssetId: null, assetItemId: item.id })
        .where(eq(sceneLibrary.mediaAssetId, m.id))
        .returning({ id: sceneLibrary.id, sceneId: sceneLibrary.sceneId })
      await tx.delete(mediaAssets).where(eq(mediaAssets.id, m.id))
      return { result: 'moved' as const, links, removed: false, assetItemId: item.id }
    }
    const abandoned = m.status === 'failed' || m.createdAt.getTime() < now.getTime() - STALE_MS
    if (!m.storageKey && abandoned) {
      const links = await tx.select({ id: sceneLibrary.id, sceneId: sceneLibrary.sceneId }).from(sceneLibrary).where(eq(sceneLibrary.mediaAssetId, m.id))
      await tx.delete(mediaAssets).where(eq(mediaAssets.id, m.id)) // its links go with it (cascade)
      return { result: 'dropped' as const, links, removed: true, assetItemId: undefined }
    }
    return null
  })
  if (!outcome) return { result: 'skipped' }
  for (const l of outcome.links) await publishLibraryChanged(l.sceneId, l.id, outcome.removed)
  return { result: outcome.result, assetItemId: outcome.assetItemId }
}

/** Move every 3D model still in media; returns the counts. Runs at every boot (cheap once nothing is left). */
export async function moveMediaModels(now: Date = new Date()): Promise<{ moved: number; dropped: number }> {
  const rows = await db
    .select({ id: mediaAssets.id })
    .from(mediaAssets)
    .where(IS_MODEL)
  const counts = { moved: 0, dropped: 0 }
  for (const r of rows) {
    const { result } = await moveMediaModel(r.id, now)
    if (result !== 'skipped') counts[result]++
  }
  return counts
}
