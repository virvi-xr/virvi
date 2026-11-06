/**
 * A scene's thumbnail (LIV-88): checked by its bytes, kept as a 16:9 PNG or JPEG of 960 × 540 to 1920 × 1080, stored
 * under the scene by content hash. Decentraland deploys take it as `images/scene-thumbnail-<hash>.<ext>`.
 */
import { createHash } from 'node:crypto'
import sharp from 'sharp'
import {
  SCENE_THUMBNAIL_MAX, SCENE_THUMBNAIL_MAX_BYTES, SCENE_THUMBNAIL_MIN, isThumbnailShape,
} from '@virvixr/shared'

export type ThumbnailErrorCode = 'too_large' | 'unsupported_type' | 'too_small' | 'wrong_shape'

const MESSAGES: Record<ThumbnailErrorCode, string> = {
  too_large: `The image is over ${SCENE_THUMBNAIL_MAX_BYTES / (1024 * 1024)} MB. Use a smaller file.`,
  unsupported_type: 'Use a PNG, JPEG or WebP image.',
  too_small: `The thumbnail must be at least ${SCENE_THUMBNAIL_MIN.width} × ${SCENE_THUMBNAIL_MIN.height} px. Use a bigger image.`,
  wrong_shape: 'The thumbnail must be 16:9, the shape Decentraland shows. Crop it first.',
}

export class ThumbnailError extends Error {
  constructor(public code: ThumbnailErrorCode, public status: 400 | 413 | 415 = code === 'too_large' ? 413 : code === 'unsupported_type' ? 415 : 400) {
    super(MESSAGES[code])
  }
}

/** Pixel cap before decoding, so a tiny file can't claim a huge canvas. */
const MAX_INPUT_PIXELS = 8192 * 8192

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
 * Checks an uploaded thumbnail (at most 2 MB; PNG, JPEG or WebP by its bytes; 16:9; at least 960 × 540) and returns
 * what to store: a PNG or JPEG as sent, a WebP re-encoded as JPEG (PNG when it has transparency), anything over
 * 1920 × 1080 scaled down to it. Throws ThumbnailError.
 */
export async function processSceneThumbnail(input: Buffer): Promise<ProcessedThumbnail> {
  if (input.length > SCENE_THUMBNAIL_MAX_BYTES) throw new ThumbnailError('too_large')
  const kind = magic(input)
  if (!kind) throw new ThumbnailError('unsupported_type')
  let meta: sharp.Metadata
  try {
    meta = await sharp(input, { failOn: 'error', limitInputPixels: MAX_INPUT_PIXELS }).metadata()
  } catch {
    throw new ThumbnailError('unsupported_type')
  }
  if (meta.format !== kind || (meta.pages ?? 1) > 1) throw new ThumbnailError('unsupported_type')
  // EXIF orientation 5–8 swaps width and height on screen
  const turned = (meta.orientation ?? 1) >= 5
  const width = (turned ? meta.height : meta.width) ?? 0
  const height = (turned ? meta.width : meta.height) ?? 0
  if (!isThumbnailShape(width, height)) throw new ThumbnailError('wrong_shape')
  if (width < SCENE_THUMBNAIL_MIN.width || height < SCENE_THUMBNAIL_MIN.height) throw new ThumbnailError('too_small')

  const out: 'png' | 'jpeg' = kind === 'webp' ? (meta.hasAlpha ? 'png' : 'jpeg') : kind
  const big = width > SCENE_THUMBNAIL_MAX.width || height > SCENE_THUMBNAIL_MAX.height
  const reencode = kind === 'webp' || big || turned
  let data = input
  let size = { width, height }
  if (reencode) {
    try {
      const pipeline = sharp(input, { failOn: 'error', limitInputPixels: MAX_INPUT_PIXELS })
        .rotate()
        .resize({ ...SCENE_THUMBNAIL_MAX, fit: 'inside', withoutEnlargement: true })
      const { data: buf, info } = await (out === 'png' ? pipeline.png() : pipeline.jpeg({ quality: 90 })).toBuffer({ resolveWithObject: true })
      data = buf
      size = { width: info.width, height: info.height }
    } catch {
      throw new ThumbnailError('unsupported_type')
    }
    if (data.length > SCENE_THUMBNAIL_MAX_BYTES) throw new ThumbnailError('too_large')
  } else {
    // Only the header was read so far: make sure the image decodes
    try {
      await sharp(input, { failOn: 'error', limitInputPixels: MAX_INPUT_PIXELS }).stats()
    } catch {
      throw new ThumbnailError('unsupported_type')
    }
  }
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
