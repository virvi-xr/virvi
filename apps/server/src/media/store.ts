import { randomUUID } from 'crypto'
import { eq } from 'drizzle-orm'
import { db } from '../db/connection.js'
import { mediaAssets } from '../db/schema.js'
import { assertStorageQuota } from './quota.js'
import { createStorage } from '../storage/index.js'
import { classifyUpload, extensionFor } from '../storage/upload-policy.js'
import { isVideo, probeDuration } from './probe.js'

const storage = createStorage()

export class StoreMediaError extends Error {
  constructor(public status: number, public body: Record<string, unknown>) {
    super(typeof body.error === 'string' ? body.error : 'store_media_failed')
  }
}

type MediaRow = typeof mediaAssets.$inferSelect

/**
 * Step 1 of an upload: classify the declared file, quota-check it against ownerId, and record it as 'uploading'
 * (no bytes stored yet). Throws StoreMediaError for refusals, leaving no row.
 */
export async function reserveMedia(
  ownerId: string,
  file: { filename: string; contentType: string; sizeBytes: number; metadata?: Record<string, unknown> },
  opts: { quotaMessage?: string; quotaStatus?: number } = {},
): Promise<MediaRow> {
  const verdict = classifyUpload(file.filename, file.contentType, file.sizeBytes)
  if (!verdict.ok) throw new StoreMediaError(verdict.status, { error: verdict.error })
  await assertStorageQuota(ownerId, file.sizeBytes, opts)
  const [asset] = await db.insert(mediaAssets).values({
    ownerId,
    filename: file.filename,
    contentType: verdict.contentType,
    sizeBytes: file.sizeBytes,
    storageKey: null,
    publicUrl: null,
    status: 'uploading',
    metadata: file.metadata ?? null,
  }).returning()
  return asset
}

/**
 * Step 2: store the bytes for a reserved asset. 'processing' while it runs, then 'ready'; any failure marks the
 * asset 'failed' with the reason and rethrows. The real size is re-classified (the declared one can lie).
 */
export async function fillMedia(assetId: string, buffer: Buffer): Promise<MediaRow> {
  const [asset] = await db.update(mediaAssets).set({ status: 'processing' }).where(eq(mediaAssets.id, assetId)).returning()
  if (!asset) throw new StoreMediaError(404, { error: 'not_found' })
  try {
    const verdict = classifyUpload(asset.filename, asset.contentType, buffer.length)
    if (!verdict.ok) throw new StoreMediaError(verdict.status, { error: verdict.error })
    // Quota was checked against the declared size: never store more than that
    if (buffer.length > asset.sizeBytes) throw new StoreMediaError(413, { error: 'too_large' })
    const key = `${asset.ownerId}/${randomUUID()}.${extensionFor(verdict.contentType)}`
    const metadata = isVideo(verdict.contentType) ? await withDuration(asset.metadata, buffer) : asset.metadata
    const publicUrl = await storage.upload(key, buffer, verdict.contentType)
    const [stored] = await db.update(mediaAssets)
      .set({ status: 'ready', error: null, storageKey: key, publicUrl, sizeBytes: buffer.length, metadata })
      .where(eq(mediaAssets.id, assetId))
      .returning()
    return stored
  } catch (err) {
    const reason = err instanceof StoreMediaError ? err.message : 'Upload failed'
    await db.update(mediaAssets).set({ status: 'failed', error: reason }).where(eq(mediaAssets.id, assetId))
    throw err
  }
}

/**
 * A video's metadata with its length in seconds (`duration`), which scheduled screens need (LIV-87). A file ffprobe
 * can't read still uploads, marked `durationProbe: 'failed'`; if ffprobe is unavailable or times out it's left
 * for the backfill. Never fails the upload.
 */
async function withDuration(metadata: unknown, buffer: Buffer): Promise<Record<string, unknown> | null> {
  // Only ffprobe sets these: drop any the client sent when reserving the upload
  const { duration: _d, durationProbe: _p, ...rest } = metadata && typeof metadata === 'object' && !Array.isArray(metadata)
    ? (metadata as Record<string, unknown>)
    : {}
  const base = Object.keys(rest).length ? rest : null
  const result = await probeDuration(buffer)
  if (result.ok) return { ...base, duration: result.seconds }
  if (result.reason === 'unreadable') return { ...base, durationProbe: 'failed' }
  // Unavailable or timed out: the boot backfill tries again
  return base
}

/** Classify, quota-check (against ownerId), upload and record a media file. Throws StoreMediaError for refusals. */
export async function storeMedia(
  ownerId: string,
  file: { filename: string; contentType: string; data: Buffer },
  opts: { quotaMessage?: string; quotaStatus?: number } = {},
): Promise<MediaRow> {
  const reserved = await reserveMedia(ownerId, { filename: file.filename, contentType: file.contentType, sizeBytes: file.data.length }, opts)
  try {
    return await fillMedia(reserved.id, file.data)
  } catch (err) {
    // A one-shot upload that fails leaves nothing behind (only two-step uploads keep a failed row to show)
    await db.delete(mediaAssets).where(eq(mediaAssets.id, reserved.id))
    throw err
  }
}
