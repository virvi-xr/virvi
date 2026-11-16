import sharp from 'sharp'

/**
 * A BEAT's image size, read from the stored file itself: the media row's `metadata` is whatever the client declared
 * when it reserved the upload, so it is never trusted. Tests replace the reader (setImageSizeReader).
 */
export type ImageSizeReader = (url: string) => Promise<{ width: number; height: number } | null>

const MAX_BYTES = 10 * 1024 * 1024

/** The file at a URL, at most 10 MB; null when it can't be read. */
async function fetchBytes(url: string): Promise<Buffer | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000), redirect: 'error' })
    if (!res.ok) return null
    if (Number(res.headers.get('content-length') ?? 0) > MAX_BYTES) return null
    const buf = Buffer.from(await res.arrayBuffer())
    return buf.length > MAX_BYTES ? null : buf
  } catch {
    return null
  }
}

async function readFromUrl(url: string): Promise<{ width: number; height: number } | null> {
  try {
    const buf = await fetchBytes(url)
    if (!buf) return null
    const meta = await sharp(buf, { failOn: 'error' }).metadata()
    return meta.width && meta.height ? { width: meta.width, height: meta.height } : null
  } catch {
    return null
  }
}

let reader: ImageSizeReader = readFromUrl
export const readImageSize: ImageSizeReader = (url) => reader(url)
export function setImageSizeReader(r: ImageSizeReader | null): void {
  reader = r ?? readFromUrl
}

/** The image file's bytes, for the frozen copy made at payment (tests replace it: setImageBytesReader). */
export type ImageBytesReader = (url: string) => Promise<Buffer | null>
let bytesReader: ImageBytesReader = fetchBytes
export const readImageBytes: ImageBytesReader = (url) => bytesReader(url)
export function setImageBytesReader(r: ImageBytesReader | null): void {
  bytesReader = r ?? fetchBytes
}

/** The frozen copy's limits (standards I3): at most 1024 × 1024, WebP at quality 85, at most 2 MB. */
export const BEAT_FROZEN_MAX_PX = 1024
export const BEAT_FROZEN_QUALITY = 85
export const BEAT_FROZEN_MAX_BYTES = 2 * 1024 * 1024

/**
 * The host's image as the token's permanent art: scaled down to fit BEAT_FROZEN_MAX_PX (never up), as WebP. When the
 * result is over BEAT_FROZEN_MAX_BYTES it tries lower qualities; null when it still doesn't fit or isn't an image.
 */
export async function frozenImage(data: Buffer): Promise<Buffer | null> {
  for (const quality of [BEAT_FROZEN_QUALITY, 70, 55]) {
    try {
      const out = await sharp(data, { failOn: 'error' }).rotate()
        .resize(BEAT_FROZEN_MAX_PX, BEAT_FROZEN_MAX_PX, { fit: 'inside', withoutEnlargement: true })
        .webp({ quality }).toBuffer()
      if (out.length <= BEAT_FROZEN_MAX_BYTES) return out
    } catch {
      return null
    }
  }
  return null
}
