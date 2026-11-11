import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { db } from '../db/connection.js'
import { assetLibraryItems } from '../db/schema.js'
import { assertStorageQuota } from '../media/quota.js'
import { StoreMediaError } from '../media/store.js'
import { createStorage } from '../storage/index.js'
import { classifyUpload, extensionFor } from '../storage/upload-policy.js'

const storage = createStorage()

/**
 * Uploads of 3D models made in-world (phone uploads and the SDK's scene-library upload) go in the 3D Models library
 * (asset_library_items) as private models, LIV-132. Same two steps as media uploads: reserve (status 'uploading',
 * no file yet), then fill; a one-shot upload does both.
 */
type ModelRow = typeof assetLibraryItems.$inferSelect

/** An asset row as the API shows it: never its upload code (it uploads into a scene while its link is live). */
export function withoutUploadCode<T extends { uploadCode?: string | null }>(row: T): Omit<T, 'uploadCode'> {
  const { uploadCode: _code, ...rest } = row
  return rest
}

/** A model's library name from its file name: the dashboard's uploads drop the .glb too. */
export const modelName = (filename: string): string => filename.replace(/\.glb$/i, '') || filename

/**
 * Step 1: classify the declared file (models only), quota-check it against ownerId and record it as 'uploading',
 * private to ownerId. Throws StoreMediaError for refusals, leaving no row.
 */
export async function reserveModel(
  ownerId: string,
  file: { filename: string; contentType: string; sizeBytes: number; uploadCode?: string },
  opts: { quotaMessage?: string; quotaStatus?: number } = {},
): Promise<ModelRow> {
  const verdict = classifyUpload(file.filename, file.contentType, file.sizeBytes)
  if (!verdict.ok) throw new StoreMediaError(verdict.status, { error: verdict.error })
  if (verdict.contentType !== 'model/gltf-binary') throw new StoreMediaError(415, { error: 'unsupported_type' })
  await assertStorageQuota(ownerId, file.sizeBytes, opts)
  const [item] = await db.insert(assetLibraryItems).values({
    name: modelName(file.filename),
    // Where the file will go; it has no URL until it's stored
    storageKey: `assets/${ownerId}/${randomUUID()}.${extensionFor(verdict.contentType)}`,
    cdnUrl: null,
    fileSizeBytes: file.sizeBytes,
    isPublic: false,
    uploadedBy: ownerId,
    status: 'uploading',
    uploadCode: file.uploadCode ?? null,
  }).returning()
  return item
}

/**
 * Step 2: store the bytes for a reserved model. 'processing' while it runs, then 'ready'; any failure marks it
 * 'failed' with the reason and rethrows. The real size is re-classified (the declared one can lie).
 */
export async function fillModel(id: string, buffer: Buffer): Promise<ModelRow> {
  const [item] = await db.update(assetLibraryItems).set({ status: 'processing' }).where(eq(assetLibraryItems.id, id)).returning()
  if (!item) throw new StoreMediaError(404, { error: 'not_found' })
  try {
    const verdict = classifyUpload(`${item.name}.glb`, 'model/gltf-binary', buffer.length)
    if (!verdict.ok) throw new StoreMediaError(verdict.status, { error: verdict.error })
    // Quota was checked against the declared size: never store more than that
    if (buffer.length > item.fileSizeBytes) throw new StoreMediaError(413, { error: 'too_large' })
    const cdnUrl = await storage.upload(item.storageKey, buffer, verdict.contentType)
    // Done with the upload code: the item is no longer waiting for bytes
    const [stored] = await db.update(assetLibraryItems)
      .set({ status: 'ready', error: null, cdnUrl, fileSizeBytes: buffer.length, uploadCode: null })
      .where(eq(assetLibraryItems.id, id))
      .returning()
    if (!stored) {
      // Deleted while its bytes were stored (a dismissed upload): don't leave the file behind
      await storage.delete(item.storageKey).catch(() => {})
      throw new StoreMediaError(404, { error: 'not_found' })
    }
    return stored
  } catch (err) {
    const reason = err instanceof StoreMediaError ? err.message : 'Upload failed'
    await db.update(assetLibraryItems).set({ status: 'failed', error: reason, uploadCode: null }).where(eq(assetLibraryItems.id, id))
    throw err
  }
}

/** Classify, quota-check (against ownerId), upload and record a private model. Throws StoreMediaError for refusals. */
export async function storeModel(
  ownerId: string,
  file: { filename: string; contentType: string; data: Buffer },
  opts: { quotaMessage?: string; quotaStatus?: number } = {},
): Promise<ModelRow> {
  const reserved = await reserveModel(ownerId, { filename: file.filename, contentType: file.contentType, sizeBytes: file.data.length }, opts)
  try {
    return await fillModel(reserved.id, file.data)
  } catch (err) {
    // A one-shot upload that fails leaves nothing behind (only two-step uploads keep a failed row to show)
    await db.delete(assetLibraryItems).where(eq(assetLibraryItems.id, reserved.id))
    throw err
  }
}
