import { describe, it, expect } from 'vitest'
import sharp from 'sharp'
import { SCENE_THUMBNAIL_MAX_BYTES } from '@virvixr/shared'
import { ThumbnailError, deployedThumbnailFile, processSceneThumbnail, thumbnailStorageKey } from '../src/scenes/thumbnail.js'

const img = (w: number, h: number, format: 'png' | 'jpeg' | 'webp' | 'gif', alpha = false) =>
  sharp({ create: { width: w, height: h, channels: alpha ? 4 : 3, background: alpha ? { r: 255, g: 0, b: 0, alpha: 0.5 } : '#3366ff' } })
    .toFormat(format)
    .toBuffer()

async function code(p: Promise<unknown>) {
  try { await p } catch (e) { if (e instanceof ThumbnailError) return e.code; throw e }
  return 'ok'
}

describe('processSceneThumbnail', () => {
  it('keeps a 16:9 PNG or JPEG as it is', async () => {
    const png = await img(1280, 720, 'png')
    const out = await processSceneThumbnail(png)
    expect(out).toMatchObject({ contentType: 'image/png', ext: 'png', width: 1280, height: 720 })
    expect(out.data.equals(png)).toBe(true)
    const jpg = await processSceneThumbnail(await img(1920, 1080, 'jpeg'))
    expect(jpg).toMatchObject({ contentType: 'image/jpeg', ext: 'jpg', width: 1920, height: 1080 })
  })

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
