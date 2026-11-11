/**
 * A scene's thumbnail (LIV-88): checked by its bytes, kept as a 16:9 PNG or JPEG of 960 × 540 to 1920 × 1080, stored
 * under the scene by content hash. Decentraland deploys take it as `images/scene-thumbnail-<hash>.<ext>`.
 * An imported scene's own navmapThumbnail (LIV-89) is kept in its own shape (IMPORT_THUMBNAIL_RULES) and never deployed
 * by Virvi: the scene's files already carry it.
 */
import { createHash } from 'node:crypto'
import sharp from 'sharp'
import { eq } from 'drizzle-orm'
import {
  SCENE_THUMBNAIL_MAX, SCENE_THUMBNAIL_MAX_BYTES, SCENE_THUMBNAIL_MIN, isThumbnailShape,
} from '@virvixr/shared'
import { db } from '../db/connection.js'
import { scenes } from '../db/schema.js'
import { assertStorageQuota } from '../media/quota.js'
import { createStorage, type StorageProvider } from '../storage/index.js'

export type ThumbnailErrorCode = 'too_large' | 'too_many_pixels' | 'unsupported_type' | 'too_small' | 'wrong_shape'

/** Pixel cap before decoding, so a tiny file can't claim a huge canvas (as branding/images.ts). */
export const MAX_INPUT_PIXELS = 4096 * 4096

type Size = { width: number; height: number }

/** What a thumbnail must be, and the size it is kept at. */
export interface ThumbnailRules {
  /** 16:9 (an upload, cropped in the browser), or any shape (an import's own, kept as it is). */
  shape: '16:9' | 'any'
  min: Size
  /** Scaled down to fit inside this, shape kept; never enlarged. */
  max: Size
}

/** An upload in Virvi (LIV-88): 16:9, 960 × 540 to 1920 × 1080. */
export const UPLOAD_THUMBNAIL_RULES: ThumbnailRules = { shape: '16:9', min: SCENE_THUMBNAIL_MIN, max: SCENE_THUMBNAIL_MAX }
/**
 * An imported scene's own navmapThumbnail (LIV-89): never cropped, any shape, at least 64 × 64 (below that it is an
 * icon, not a picture of the scene), scaled down only to fit 1920 × 1920 (so a 16:9 one keeps the upload's 1920 × 1080).
 */
export const IMPORT_THUMBNAIL_RULES: ThumbnailRules = { shape: 'any', min: { width: 64, height: 64 }, max: { width: 1920, height: 1920 } }

const MESSAGES: Record<Exclude<ThumbnailErrorCode, 'too_small'>, string> = {
  too_large: `The image is over ${SCENE_THUMBNAIL_MAX_BYTES / (1024 * 1024)} MB. Use a smaller file.`,
  too_many_pixels: `The image is over ${Math.floor(MAX_INPUT_PIXELS / 1_000_000)} megapixels. Use one of at most ${SCENE_THUMBNAIL_MAX.width} × ${SCENE_THUMBNAIL_MAX.height} px.`,
  unsupported_type: 'Use a PNG, JPEG or WebP image.',
  wrong_shape: 'The thumbnail must be 16:9, the shape Decentraland shows. Crop it first.',
}
const tooSmall = (min: Size) => `The thumbnail must be at least ${min.width} × ${min.height} px. Use a bigger image.`

const STATUS: Partial<Record<ThumbnailErrorCode, 413 | 415>> = { too_large: 413, too_many_pixels: 413, unsupported_type: 415 }

export class ThumbnailError extends Error {
  constructor(public code: ThumbnailErrorCode, public status: 400 | 413 | 415 = STATUS[code] ?? 400, min: Size = SCENE_THUMBNAIL_MIN) {
    super(code === 'too_small' ? tooSmall(min) : MESSAGES[code])
  }
}

/** The scene is gone (deleted before or while its thumbnail was saved). */
export class SceneGone extends Error {
  constructor() {
    super('Scene not found')
  }
}

/** The request body limit for a thumbnail upload of at most `maxBytes`: its base64 plus room for the JSON around it. */
export const bodyLimitFor = (maxBytes: number) => Math.ceil((maxBytes * 4) / 3) + 4096

type Kind = 'png' | 'jpeg' | 'webp'

/** The format by its first bytes, as the catalog importer checks thumbnails. */
function magic(b: Buffer): Kind | null {
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png'
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg'
  if (b.length >= 12 && b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP') return 'webp'
  return null
}

export interface ProcessedThumbnail {
  data: Buffer
  contentType: 'image/png' | 'image/jpeg'
  ext: 'png' | 'jpg'
  width: number
  height: number
}

/**
 * Checks a thumbnail (at most 2 MB; PNG, JPEG or WebP by its bytes; at most 4096 × 4096 pixels in all; then `rules`:
 * an upload's 16:9 of at least 960 × 540 by default) and re-encodes it, so what is stored and deployed is only the
 * picture: turned upright by its EXIF orientation, with no metadata (EXIF, GPS, text chunks) and nothing after the
 * image, PNG when it has transparency and JPEG otherwise, scaled down to fit `rules.max` (an upload's 1920 × 1080),
 * never cropped. Throws ThumbnailError.
 */
export async function processSceneThumbnail(input: Buffer, rules: ThumbnailRules = UPLOAD_THUMBNAIL_RULES): Promise<ProcessedThumbnail> {
  if (input.length > SCENE_THUMBNAIL_MAX_BYTES) throw new ThumbnailError('too_large')
  const kind = magic(input)
  if (!kind) throw new ThumbnailError('unsupported_type')
  let meta: sharp.Metadata
  try {
    // The header only (nothing is decoded); the pixel cap is checked just below, so it can say why
    meta = await sharp(input, { failOn: 'error', limitInputPixels: false }).metadata()
  } catch {
    throw new ThumbnailError('unsupported_type')
  }
  if (meta.format !== kind || (meta.pages ?? 1) > 1) throw new ThumbnailError('unsupported_type')
  // From the header alone, before anything is decoded
  if ((meta.width ?? 0) * (meta.height ?? 0) > MAX_INPUT_PIXELS) throw new ThumbnailError('too_many_pixels')
  // EXIF orientation 5–8 swaps width and height on screen
  const turned = (meta.orientation ?? 1) >= 5
  const width = (turned ? meta.height : meta.width) ?? 0
  const height = (turned ? meta.width : meta.height) ?? 0
  if (rules.shape === '16:9' && !isThumbnailShape(width, height)) throw new ThumbnailError('wrong_shape')
  if (width < rules.min.width || height < rules.min.height) throw new ThumbnailError('too_small', 400, rules.min)

  const out: 'png' | 'jpeg' = meta.hasAlpha ? 'png' : 'jpeg'
  let data: Buffer
  let size: { width: number; height: number }
  try {
    // sharp writes no metadata unless asked (withMetadata), so EXIF and text chunks are dropped here
    const pipeline = sharp(input, { failOn: 'error', limitInputPixels: MAX_INPUT_PIXELS })
      .rotate()
      .resize({ ...rules.max, fit: 'inside', withoutEnlargement: true })
    const { data: buf, info } = await (out === 'png' ? pipeline.png() : pipeline.jpeg({ quality: 90 })).toBuffer({ resolveWithObject: true })
    data = buf
    size = { width: info.width, height: info.height }
  } catch {
    throw new ThumbnailError('unsupported_type')
  }
  if (data.length > SCENE_THUMBNAIL_MAX_BYTES) throw new ThumbnailError('too_large')
  return {
    data,
    contentType: out === 'png' ? 'image/png' : 'image/jpeg',
    ext: out === 'png' ? 'png' : 'jpg',
    ...size,
  }
}

const KEY_RE = /^scenes\/[^/]+\/thumbnail-([0-9a-f]{16})\.(png|jpg)$/

/** Where a thumbnail is stored: `scenes/<sceneId>/thumbnail-<sha256, 16 hex>.<ext>`. */
export function thumbnailStorageKey(sceneId: string, t: { data: Buffer; ext: string }): string {
  const hash = createHash('sha256').update(t.data).digest('hex').slice(0, 16)
  return `scenes/${sceneId}/thumbnail-${hash}.${t.ext}`
}

/** The deployed path of a stored thumbnail, `images/scene-thumbnail-<hash>.<ext>`; null for none or another key. */
export function deployedThumbnailFile(storageKey: string | null | undefined): string | null {
  const m = storageKey ? KEY_RE.exec(storageKey) : null
  return m ? `images/scene-thumbnail-${m[1]}.${m[2]}` : null
}

type SceneRow = typeof scenes.$inferSelect

let storage: StorageProvider | null = null
const store = () => (storage ??= createStorage())

/** Swaps the storage thumbnails are written to (tests); null goes back to the configured one. */
export function setThumbnailStorage(s: StorageProvider | null): void {
  storage = s
}

async function deleteQuietly(key: string) {
  try {
    await store().delete(key)
  } catch (err) {
    console.error('[scene-thumbnail] could not delete', key, err instanceof Error ? err.message : err)
  }
}

type Current = Pick<SceneRow, 'thumbnailKey' | 'thumbnailSource'>

/** The row was taken by a thumbnail the caller may not replace while this one was stored. */
class Kept extends Error {}

/**
 * Stores `t` as the scene's thumbnail from `source` when `mayReplace` allows it over the current one (checked first,
 * then again under the row lock): charged to the owner's storage quota (less the one it replaces), stored, the old file
 * deleted. Null when the current thumbnail stays (nothing is left stored). Throws StoreMediaError or SceneGone.
 */
async function storeThumbnail(sceneId: string, t: ProcessedThumbnail, source: 'upload' | 'import', mayReplace: (c: Current) => boolean): Promise<SceneRow | null> {
  const key = thumbnailStorageKey(sceneId, t)
  const current = await db.query.scenes.findFirst({
    where: eq(scenes.id, sceneId), columns: { ownerId: true, thumbnailBytes: true, thumbnailKey: true, thumbnailSource: true },
  })
  if (!current) throw new SceneGone()
  if (!mayReplace(current)) return null
  await assertStorageQuota(current.ownerId, t.data.length - (current.thumbnailBytes ?? 0))
  const url = await store().upload(key, t.data, t.contentType)
  let old: string | null = null
  let row: SceneRow
  try {
    row = await db.transaction(async (tx) => {
      // Serialises replacements of one scene's thumbnail, so each old file is deleted exactly once
      const [locked] = await tx.select({ thumbnailKey: scenes.thumbnailKey, thumbnailSource: scenes.thumbnailSource })
        .from(scenes).where(eq(scenes.id, sceneId)).for('update')
      if (!locked) throw new SceneGone() // deleted while the file uploaded
      if (!mayReplace(locked)) throw new Kept()
      old = locked.thumbnailKey
      const [updated] = await tx.update(scenes)
        .set({ thumbnailUrl: url, thumbnailKey: key, thumbnailBytes: t.data.length, thumbnailSource: source, updatedAt: new Date() })
        .where(eq(scenes.id, sceneId))
        .returning()
      return updated
    })
  } catch (err) {
    // A scene that's gone keeps nothing; otherwise the file stays only if it is the scene's thumbnail
    if (err instanceof Kept) {
      const now = await db.query.scenes.findFirst({ where: eq(scenes.id, sceneId), columns: { thumbnailKey: true } })
      if (now?.thumbnailKey !== key) await deleteQuietly(key)
      return null
    }
    if (err instanceof SceneGone || current.thumbnailKey !== key) await deleteQuietly(key)
    throw err
  }
  if (old && old !== key) await deleteQuietly(old)
  return row
}

/**
 * Sets the scene's thumbnail from an upload in Virvi: checked (processSceneThumbnail), charged to the scene owner's
 * storage quota (less the one it replaces), stored, and the old file deleted. Throws ThumbnailError, StoreMediaError or
 * SceneGone (then nothing is left stored).
 */
export async function setSceneThumbnail(sceneId: string, upload: Buffer): Promise<SceneRow> {
  return (await storeThumbnail(sceneId, await processSceneThumbnail(upload), 'upload', () => true))!
}

/**
 * Whether an import may set the scene's thumbnail (LIV-89): it has none, or the one it has came from an import. One
 * uploaded in Virvi, including LIV-88's from before the source was recorded (null), is the owner's and stays.
 */
export const importMayReplace = (c: Current) => !c.thumbnailKey || c.thumbnailSource === 'import'

/**
 * Sets the scene's thumbnail from its imported scene.json (LIV-89), kept in its own shape (IMPORT_THUMBNAIL_RULES), and
 * only where importMayReplace allows; the one it replaces is deleted. Null when the owner's own stays. Throws
 * ThumbnailError, StoreMediaError or SceneGone.
 */
export async function setImportedSceneThumbnail(sceneId: string, image: Buffer): Promise<SceneRow | null> {
  return storeThumbnail(sceneId, await processSceneThumbnail(image, IMPORT_THUMBNAIL_RULES), 'import', importMayReplace)
}

/** Takes the scene's thumbnail off and deletes its file. Nothing to remove is fine. */
export async function removeSceneThumbnail(sceneId: string): Promise<SceneRow | undefined> {
  const result = await db.transaction(async (tx) => {
    const [locked] = await tx.select({ thumbnailKey: scenes.thumbnailKey }).from(scenes).where(eq(scenes.id, sceneId)).for('update')
    if (!locked) return undefined
    const [updated] = await tx.update(scenes)
      .set({ thumbnailUrl: null, thumbnailKey: null, thumbnailBytes: null, thumbnailSource: null, updatedAt: new Date() })
      .where(eq(scenes.id, sceneId))
      .returning()
    return { updated, old: locked.thumbnailKey }
  })
  if (result?.old) await deleteQuietly(result.old)
  return result?.updated
}

/**
 * Takes off a thumbnail that came from an import (LIV-89: the re-imported scene.json names none) and deletes its file;
 * one uploaded in Virvi is never touched (checked under the row lock). True when one was removed.
 */
export async function removeImportedSceneThumbnail(sceneId: string): Promise<boolean> {
  const old = await db.transaction(async (tx) => {
    const [locked] = await tx.select({ thumbnailKey: scenes.thumbnailKey, thumbnailSource: scenes.thumbnailSource })
      .from(scenes).where(eq(scenes.id, sceneId)).for('update')
    if (!locked?.thumbnailKey || locked.thumbnailSource !== 'import') return null
    await tx.update(scenes)
      .set({ thumbnailUrl: null, thumbnailKey: null, thumbnailBytes: null, thumbnailSource: null, updatedAt: new Date() })
      .where(eq(scenes.id, sceneId))
    return locked.thumbnailKey
  })
  if (old) await deleteQuietly(old)
  return !!old
}

/** Deletes a stored thumbnail file (the scene is being deleted). */
export const deleteThumbnailFile = (key: string | null | undefined) => (key ? deleteQuietly(key) : Promise.resolve())
