import sharp from 'sharp'

/**
 * A BEAT's image size, read from the stored file itself: the media row's `metadata` is whatever the client declared
 * when it reserved the upload, so it is never trusted. Tests replace the reader (setImageSizeReader).
 */
export type ImageSizeReader = (url: string) => Promise<{ width: number; height: number } | null>

const MAX_BYTES = 10 * 1024 * 1024

async function readFromUrl(url: string): Promise<{ width: number; height: number } | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) })
    if (!res.ok) return null
    const buf = Buffer.from(await res.arrayBuffer())
    if (buf.length > MAX_BYTES) return null
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
