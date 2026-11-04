import sharp from 'sharp'

/** Logo uploads: PNG, WebP or SVG up to 512 KB, shown at up to 160 × 40 (stored at 2× for sharp screens). */
export const LOGO_MAX_BYTES = 512 * 1024
const LOGO_BOX = { width: 320, height: 80 }
/** Favicons: a square PNG of at least 64 px, stored at up to 256 px. */
export const FAVICON_MIN_PX = 64
const FAVICON_MAX_PX = 256
export const NAME_MAX_CHARS = 32
/** Pixel cap before decoding, so a tiny file can't claim a huge canvas. */
const MAX_INPUT_PIXELS = 4096 * 4096

export type BrandingErrorCode =
  | 'too_large' | 'unsupported_type' | 'svg_external' | 'too_small' | 'not_square' | 'invalid_name'

const MESSAGES: Record<BrandingErrorCode, string> = {
  too_large: 'The file is over 512 KB.',
  unsupported_type: 'Use a PNG, WebP or SVG image.',
  svg_external: 'The SVG loads files from outside itself. Embed everything in the file, or upload a PNG.',
  too_small: `The favicon must be at least ${FAVICON_MIN_PX} × ${FAVICON_MIN_PX} px.`,
  not_square: 'The favicon must be square.',
  invalid_name: `The name can be up to ${NAME_MAX_CHARS} characters.`,
}

export class BrandingError extends Error {
  constructor(public code: BrandingErrorCode, public status: 400 | 413 | 415 = code === 'too_large' ? 413 : code === 'unsupported_type' ? 415 : 400) {
    super(MESSAGES[code])
  }
}

/**
 * An SVG may only reference itself (#ids) or data: URIs. Anything else (http, file, relative paths, entities)
 * is refused before the rasterizer sees it.
 */
function svgLoadsExternal(text: string): boolean {
  if (/<!ENTITY|<!DOCTYPE[^>]*\[/i.test(text)) return true
  if (/(?:href|src)\s*=\s*["']\s*(?!data:|#)/i.test(text)) return true
  if (/url\(\s*["']?\s*(?!data:|#)/i.test(text)) return true
  if (/@import/i.test(text)) return true
  return false
}

async function formatOf(data: Buffer): Promise<string | undefined> {
  try {
    return (await sharp(data, { limitInputPixels: MAX_INPUT_PIXELS }).metadata()).format
  } catch {
    return undefined
  }
}

/**
 * Checks a logo by its content and re-encodes it as a PNG. SVGs are rasterized, so scripts, event handlers and
 * foreignObject never reach a browser from our origin.
 */
export async function processLogo(data: Buffer): Promise<Buffer> {
  if (data.length > LOGO_MAX_BYTES) throw new BrandingError('too_large')
  // Text that looks like SVG is checked before any decoder parses it
  if (/<svg[\s>]/i.test(data.subarray(0, 4096).toString('utf8')) && svgLoadsExternal(data.toString('utf8'))) {
    throw new BrandingError('svg_external')
  }
  const format = await formatOf(data)
  if (format !== 'png' && format !== 'webp' && format !== 'svg') throw new BrandingError('unsupported_type')
  if (format === 'svg' && svgLoadsExternal(data.toString('utf8'))) throw new BrandingError('svg_external')
  try {
    return await sharp(data, { limitInputPixels: MAX_INPUT_PIXELS, density: format === 'svg' ? 144 : undefined })
      .resize({ ...LOGO_BOX, fit: 'inside', withoutEnlargement: format !== 'svg' })
      .png()
      .toBuffer()
  } catch {
    throw new BrandingError('unsupported_type')
  }
}

/** Checks a favicon (square PNG, at least 64 px) and re-encodes it as a PNG of at most 256 px. */
export async function processFavicon(data: Buffer): Promise<Buffer> {
  if (data.length > LOGO_MAX_BYTES) throw new BrandingError('too_large')
  if ((await formatOf(data)) !== 'png') throw new BrandingError('unsupported_type')
  const { width = 0, height = 0 } = await sharp(data, { limitInputPixels: MAX_INPUT_PIXELS }).metadata()
  if (width !== height) throw new BrandingError('not_square')
  if (width < FAVICON_MIN_PX) throw new BrandingError('too_small')
  return sharp(data, { limitInputPixels: MAX_INPUT_PIXELS })
    .resize({ width: FAVICON_MAX_PX, height: FAVICON_MAX_PX, fit: 'inside', withoutEnlargement: true })
    .png()
    .toBuffer()
}

/** The install's display name: trimmed, up to 32 characters; blank means none. */
export function cleanBrandName(input: unknown): string | null {
  if (input === null || input === undefined) return null
  if (typeof input !== 'string') throw new BrandingError('invalid_name')
  const name = input.trim()
  if (name.length > NAME_MAX_CHARS) throw new BrandingError('invalid_name')
  return name || null
}
