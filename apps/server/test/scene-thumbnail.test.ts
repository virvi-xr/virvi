import { describe, it, expect } from 'vitest'
import sharp from 'sharp'
import { SCENE_THUMBNAIL_MAX_BYTES } from '@virvixr/shared'
import { IMPORT_THUMBNAIL_RULES, ThumbnailError, deployedThumbnailFile, processSceneThumbnail, thumbnailStorageKey } from '../src/scenes/thumbnail.js'

const img = (w: number, h: number, format: 'png' | 'jpeg' | 'webp' | 'gif', alpha = false) =>
  sharp({ create: { width: w, height: h, channels: alpha ? 4 : 3, background: alpha ? { r: 255, g: 0, b: 0, alpha: 0.5 } : '#3366ff' } })
    .toFormat(format)
    .toBuffer()

async function code(p: Promise<unknown>) {
  try { await p } catch (e) { if (e instanceof ThumbnailError) return e.code; throw e }
  return 'ok'
}

describe('processSceneThumbnail', () => {
  it('re-encodes every upload: transparency stays PNG, everything else becomes JPEG', async () => {
    const clear = await img(1280, 720, 'png', true)
    const out = await processSceneThumbnail(clear)
    expect(out).toMatchObject({ contentType: 'image/png', ext: 'png', width: 1280, height: 720 })
    const opaque = await processSceneThumbnail(await img(1280, 720, 'png'))
    expect(opaque).toMatchObject({ contentType: 'image/jpeg', ext: 'jpg' })
    expect((await sharp(opaque.data).metadata()).format).toBe('jpeg')
    const jpg = await processSceneThumbnail(await img(1920, 1080, 'jpeg'))
    expect(jpg).toMatchObject({ contentType: 'image/jpeg', ext: 'jpg', width: 1920, height: 1080 })
  })

  it('strips EXIF (GPS included) and anything after the image', async () => {
    const withGps = await sharp({ create: { width: 1280, height: 720, channels: 3, background: '#3366ff' } })
      .jpeg()
      .withExif({ IFD0: { Copyright: 'secret-owner' }, IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '51/1 30/1 0/1' } })
      .toBuffer()
    expect((await sharp(withGps).metadata()).exif).toBeDefined()
    const out = await processSceneThumbnail(withGps)
    expect((await sharp(out.data).metadata()).exif).toBeUndefined()
    expect(out.data.includes('secret-owner')).toBe(false)

    const trailing = Buffer.concat([await img(1280, 720, 'png', true), Buffer.from('TRAILING-SECRET')])
    expect((await processSceneThumbnail(trailing)).data.includes('TRAILING-SECRET')).toBe(false)
  })

  it('turns an image upright by its EXIF orientation (3 = upside down)', async () => {
    // Red on top, blue below, then flagged as rotated 180°: upright, blue is on top
    const top = await sharp({ create: { width: 1280, height: 360, channels: 3, background: '#ff0000' } }).png().toBuffer()
    const raw = await sharp({ create: { width: 1280, height: 720, channels: 3, background: '#0000ff' } })
      .composite([{ input: top, top: 0, left: 0 }]).jpeg().toBuffer()
    const flagged = await sharp(raw).withMetadata({ orientation: 3 }).jpeg().toBuffer()
    expect((await sharp(flagged).metadata()).orientation).toBe(3)
    const out = await processSceneThumbnail(flagged)
    const { data, info } = await sharp(out.data).raw().toBuffer({ resolveWithObject: true })
    const at = (y: number) => [...data.subarray((y * info.width + 640) * info.channels, (y * info.width + 640) * info.channels + 3)]
    expect(at(10)[2]).toBeGreaterThan(200) // blue on top
    expect(at(10)[0]).toBeLessThan(60)
    expect(at(710)[0]).toBeGreaterThan(200) // red below
    expect((await sharp(out.data).metadata()).orientation).toBeUndefined()
  })

  it('refuses an image over 4096 × 4096 pixels in all before decoding it, however small the file', async () => {
    const huge = await img(5470, 3077, 'png') // 16:9-ish, 16.8 megapixels, a few KB
    expect(huge.length).toBeLessThan(2 * 1024 * 1024)
    expect(await code(processSceneThumbnail(huge))).toBe('too_many_pixels')
    expect(new ThumbnailError('too_many_pixels').status).toBe(413)
    expect(await code(processSceneThumbnail(await img(5460, 3071, 'png')))).toBe('ok')
  }, 30_000)

  it('stores a WebP as JPEG (PNG when it has transparency): Decentraland shows only PNG and JPEG', async () => {
    const solid = await processSceneThumbnail(await img(1280, 720, 'webp'))
    expect(solid).toMatchObject({ contentType: 'image/jpeg', ext: 'jpg' })
    expect((await sharp(solid.data).metadata()).format).toBe('jpeg')
    const clear = await processSceneThumbnail(await img(1280, 720, 'webp', true))
    expect(clear).toMatchObject({ contentType: 'image/png', ext: 'png' })
  })

  it('scales an image over 1920 × 1080 down to it', async () => {
    const out = await processSceneThumbnail(await img(3840, 2160, 'jpeg'))
    expect([out.width, out.height]).toEqual([1920, 1080])
    expect((await sharp(out.data).metadata()).width).toBe(1920)
  })

  it('refuses other formats by their bytes, not their name', async () => {
    expect(await code(processSceneThumbnail(await img(1280, 720, 'gif')))).toBe('unsupported_type')
    expect(await code(processSceneThumbnail(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')))).toBe('unsupported_type')
    // PNG magic bytes in front of garbage
    expect(await code(processSceneThumbnail(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64)])))).toBe('unsupported_type')
    expect(await code(processSceneThumbnail(Buffer.alloc(0)))).toBe('unsupported_type')
  })

  it('refuses a file over 2 MB, one under 960 × 540, and one that is not 16:9, each with a clear message', async () => {
    const big = Buffer.concat([await img(1280, 720, 'png'), Buffer.alloc(SCENE_THUMBNAIL_MAX_BYTES)])
    expect(await code(processSceneThumbnail(big))).toBe('too_large')
    expect(await code(processSceneThumbnail(await img(640, 360, 'png')))).toBe('too_small')
    expect(await code(processSceneThumbnail(await img(1024, 1024, 'png')))).toBe('wrong_shape')
    const e = await processSceneThumbnail(await img(640, 360, 'png')).catch((x) => x as ThumbnailError)
    expect(e.status).toBe(400)
    expect(e.message).toMatch(/960 × 540/)
    expect(new ThumbnailError('too_large').status).toBe(413)
    expect(new ThumbnailError('unsupported_type').message).toMatch(/PNG, JPEG or WebP/)
  })

  it('takes a pixel of rounding off 16:9', async () => {
    expect(await code(processSceneThumbnail(await img(1000, 563, 'png')))).toBe('ok')
  })
})

describe('processSceneThumbnail with the import rules (LIV-89)', () => {
  const imported = (b: Buffer) => processSceneThumbnail(b, IMPORT_THUMBNAIL_RULES)

  it('keeps any shape as it is, never cropped or stretched, and takes a small one', async () => {
    for (const [w, h] of [[1024, 1024], [512, 768], [300, 200], [64, 64], [1280, 720]]) {
      const out = await imported(await img(w, h, 'png'))
      expect([out.width, out.height]).toEqual([w, h])
      const meta = await sharp(out.data).metadata()
      expect([meta.width, meta.height]).toEqual([w, h])
    }
  })

  it('refuses one under 64 × 64, and still caps its size, bytes and pixels', async () => {
    expect(await code(imported(await img(63, 200, 'png')))).toBe('too_small')
    expect(await code(imported(await img(200, 63, 'png')))).toBe('too_small')
    expect((await imported(await img(200, 63, 'png')).catch((e) => e as ThumbnailError)).message).toMatch(/64 × 64/)
    // Scaled down to fit 1920 × 1920, shape kept
    const tall = await imported(await img(2000, 4000, 'jpeg'))
    expect([tall.width, tall.height]).toEqual([960, 1920])
    const wide = await imported(await img(3840, 2160, 'jpeg'))
    expect([wide.width, wide.height]).toEqual([1920, 1080])
    expect(await code(imported(Buffer.concat([await img(200, 200, 'png'), Buffer.alloc(SCENE_THUMBNAIL_MAX_BYTES)])))).toBe('too_large')
    expect(await code(imported(await img(5470, 3077, 'png')))).toBe('too_many_pixels')
    expect(await code(imported(await img(300, 300, 'gif')))).toBe('unsupported_type')
  }, 30_000)

  it('still re-encodes it: no metadata, upright', async () => {
    const withGps = await sharp({ create: { width: 400, height: 300, channels: 3, background: '#3366ff' } })
      .jpeg().withExif({ IFD0: { Copyright: 'secret-owner' } }).toBuffer()
    const out = await imported(withGps)
    expect((await sharp(out.data).metadata()).exif).toBeUndefined()
    expect(out.data.includes('secret-owner')).toBe(false)
    // Orientation 6 (turned 90°): a 400 × 300 file shows as 300 × 400
    const turned = await sharp(await img(400, 300, 'jpeg')).withMetadata({ orientation: 6 }).jpeg().toBuffer()
    const up = await imported(turned)
    expect([up.width, up.height]).toEqual([300, 400])
  })
})

describe('thumbnail paths', () => {
  it('stores under the scene by content hash, and deploys to images/scene-thumbnail-<hash>', () => {
    const sceneId = '11111111-2222-4333-8444-555555555555'
    const key = thumbnailStorageKey(sceneId, { data: Buffer.from('abc'), ext: 'png' })
    expect(key).toMatch(/^scenes\/11111111-2222-4333-8444-555555555555\/thumbnail-[0-9a-f]{16}\.png$/)
    expect(thumbnailStorageKey(sceneId, { data: Buffer.from('abc'), ext: 'png' })).toBe(key)
    const hash = /thumbnail-([0-9a-f]{16})/.exec(key)![1]
    expect(deployedThumbnailFile(key)).toBe(`images/scene-thumbnail-${hash}.png`)
    expect(deployedThumbnailFile(`scenes/${sceneId}/thumbnail-${hash}.jpg`)).toBe(`images/scene-thumbnail-${hash}.jpg`)
    expect(deployedThumbnailFile(null)).toBeNull()
    expect(deployedThumbnailFile('media/x.png')).toBeNull()
  })
})
