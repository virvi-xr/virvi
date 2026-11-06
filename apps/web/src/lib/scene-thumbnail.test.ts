import { describe, it, expect } from 'vitest'
import { cropRect, maxZoom, outputSize, outputType, pickedFileError, sourceTooSmall, thumbnailError } from './scene-thumbnail'

describe('cropRect', () => {
  it('centre-crops a wide image to 16:9 at full height', () => {
    expect(cropRect(4000, 1500, { zoom: 1, x: 0.5, y: 0.5 })).toEqual({ sx: (4000 - 2667) / 2, sy: 0, sw: 2667, sh: 1500 })
  })

  it('centre-crops a tall image to 16:9 at full width', () => {
    expect(cropRect(1920, 1920, { zoom: 1, x: 0.5, y: 0.5 })).toEqual({ sx: 0, sy: 420, sw: 1920, sh: 1080 })
  })

  it('moves the crop with x/y (0 = left/top, 1 = right/bottom) and keeps it inside the image', () => {
    expect(cropRect(1920, 1920, { zoom: 1, x: 0.5, y: 0 })).toMatchObject({ sx: 0, sy: 0 })
    expect(cropRect(1920, 1920, { zoom: 1, x: 0.5, y: 1 })).toMatchObject({ sy: 840 })
    expect(cropRect(1920, 1920, { zoom: 1, x: 0.5, y: 7 })).toMatchObject({ sy: 840 })
    expect(cropRect(4000, 1500, { zoom: 1, x: 0, y: 0.5 })).toMatchObject({ sx: 0 })
  })

  it('zooming in takes a smaller 16:9 window', () => {
    const r = cropRect(3840, 2160, { zoom: 2, x: 0.5, y: 0.5 })
    expect(r).toEqual({ sx: 960, sy: 540, sw: 1920, sh: 1080 })
  })
})

describe('limits', () => {
  it('maxZoom keeps the crop at least 960 × 540', () => {
    expect(maxZoom(3840, 2160)).toBe(4)
    expect(maxZoom(960, 540)).toBe(1)
    expect(maxZoom(800, 450)).toBe(1)
  })

  it('a source that cannot give 960 × 540 at 16:9 is too small', () => {
    expect(sourceTooSmall(960, 540)).toBe(false)
    expect(sourceTooSmall(2000, 500)).toBe(true)
    expect(sourceTooSmall(512, 512)).toBe(true)
  })

  it('outputSize scales the crop to at most 1920 × 1080, 16:9', () => {
    expect(outputSize({ sw: 2667, sh: 1500 })).toEqual({ width: 1920, height: 1080 })
    expect(outputSize({ sw: 1280, sh: 720 })).toEqual({ width: 1280, height: 720 })
    expect(outputSize({ sw: 1000.4, sh: 562.7 })).toEqual({ width: 1000, height: 563 })
  })

  it('keeps JPEG as JPEG; PNG and WebP become PNG (Decentraland shows PNG and JPEG)', () => {
    expect(outputType('image/jpeg')).toBe('image/jpeg')
    expect(outputType('image/png')).toBe('image/png')
    expect(outputType('image/webp')).toBe('image/png')
  })

  it('pickedFileError refuses other types and huge files before reading them', () => {
    expect(pickedFileError({ type: 'image/png', size: 1000 })).toBeNull()
    expect(pickedFileError({ type: 'image/gif', size: 1000 })).toBe('Use a PNG, JPEG or WebP image.')
    expect(pickedFileError({ type: 'image/webp', size: 30 * 1024 * 1024 })).toMatch(/25 MB/)
  })

  it("thumbnailError shows the server's own words", () => {
    expect(thumbnailError({ message: 'too_small', body: { error: 'too_small', message: 'The thumbnail must be at least 960 × 540 px.' } })).toBe('The thumbnail must be at least 960 × 540 px.')
    expect(thumbnailError({ message: 'storage_limit_reached', body: { error: 'storage_limit_reached', message: 'Your free plan allows up to 500 MB.' } })).toMatch(/500 MB/)
    expect(thumbnailError({ message: 'API error 413', status: 413, body: {} })).toBe('The image is over 2 MB. Use a smaller file.')
    // Fastify's own body limit (the route's bodyLimit) answers before the server's check
    expect(thumbnailError({ message: 'Payload Too Large', status: 413, body: { code: 'FST_ERR_CTP_BODY_TOO_LARGE', error: 'Payload Too Large', message: 'Request body is too large' } }))
      .toBe('The image is over 2 MB. Use a smaller file.')
    expect(thumbnailError({ message: 'too_many_pixels', status: 413, body: { error: 'too_many_pixels', message: 'The image is over 16 megapixels.' } })).toBe('The image is over 16 megapixels.')
    expect(thumbnailError({ message: 'Forbidden', status: 403, body: { error: 'Forbidden' } })).toBe("Only the scene's hosts and editors can change its thumbnail.")
    expect(thumbnailError(null)).toMatch(/Try again/)
  })
})
