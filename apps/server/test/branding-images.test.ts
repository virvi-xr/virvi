import { describe, it, expect } from 'vitest'
import sharp from 'sharp'
import { BrandingError, cleanBrandName, processFavicon, processLogo, LOGO_MAX_BYTES } from '../src/branding/images.js'

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47])
const png = (w: number, h: number) => sharp({ create: { width: w, height: h, channels: 4, background: '#ff0000' } }).png().toBuffer()
const webp = (w: number, h: number) => sharp({ create: { width: w, height: h, channels: 3, background: '#00ff00' } }).webp().toBuffer()
const jpeg = (w: number, h: number) => sharp({ create: { width: w, height: h, channels: 3, background: '#0000ff' } }).jpeg().toBuffer()
const svg = (inner: string, attrs = '') => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="200" height="50" ${attrs}>${inner}</svg>`)

async function code(p: Promise<unknown>) {
  try { await p } catch (e) { if (e instanceof BrandingError) return e.code; throw e }
  return 'ok'
}

describe('processLogo', () => {
  it('keeps a PNG as a PNG, scaled to fit 320 × 80', async () => {
    const out = await processLogo(await png(800, 100))
    expect(out.subarray(0, 4).equals(PNG_MAGIC)).toBe(true)
    const meta = await sharp(out).metadata()
    expect(meta.width).toBe(320)
    expect(meta.height).toBe(40)
  })

  it('does not enlarge a small logo', async () => {
    const meta = await sharp(await processLogo(await png(100, 20))).metadata()
    expect([meta.width, meta.height]).toEqual([100, 20])
  })

  it('accepts WebP and stores it as PNG', async () => {
    const out = await processLogo(await webp(160, 40))
    expect(out.subarray(0, 4).equals(PNG_MAGIC)).toBe(true)
  })

  it('rasterizes an SVG with a <script> and onload handler, so neither survives', async () => {
    const evil = svg('<script>alert(1)</script><rect width="200" height="50" fill="red"/>', 'onload="alert(2)"')
    const out = await processLogo(evil)
    expect(out.subarray(0, 4).equals(PNG_MAGIC)).toBe(true)
    expect(out.includes('alert')).toBe(false)
    expect(out.includes('<svg')).toBe(false)
  })

  it('rejects an SVG that loads anything from outside the file', async () => {
    expect(await code(processLogo(svg('<image href="https://evil.example/x.png" width="10" height="10"/>')))).toBe('svg_external')
    expect(await code(processLogo(svg('<image xlink:href="file:///etc/passwd" width="10" height="10"/>')))).toBe('svg_external')
    expect(await code(processLogo(svg('<rect style="fill:url(http://evil.example/p)" width="9" height="9"/>')))).toBe('svg_external')
    expect(await code(processLogo(Buffer.from('<?xml version="1.0"?><!DOCTYPE svg [<!ENTITY x SYSTEM "file:///etc/passwd">]><svg xmlns="http://www.w3.org/2000/svg" width="9" height="9"><text>&x;</text></svg>')))).toBe('svg_external')
  })

  it('allows in-file references (gradients by #id, data: images)', async () => {
    const ok = svg('<defs><linearGradient id="g"><stop offset="0" stop-color="red"/></linearGradient></defs><rect width="200" height="50" fill="url(#g)"/>')
    expect(await code(processLogo(ok))).toBe('ok')
  })

  it('checks the content, not the name: JPEG and non-images are refused', async () => {
    expect(await code(processLogo(await jpeg(100, 30)))).toBe('unsupported_type')
    expect(await code(processLogo(Buffer.from('just some text pretending to be a png')))).toBe('unsupported_type')
  })

  it('refuses files over 512 KB', async () => {
    const big = Buffer.concat([await png(10, 10), Buffer.alloc(LOGO_MAX_BYTES)])
    expect(await code(processLogo(big))).toBe('too_large')
  })
})

describe('processFavicon', () => {
  it('accepts a square PNG of at least 64 px and keeps it a PNG (at most 256 px)', async () => {
    const meta = await sharp(await processFavicon(await png(512, 512))).metadata()
    expect([meta.format, meta.width, meta.height]).toEqual(['png', 256, 256])
    expect(await code(processFavicon(await png(64, 64)))).toBe('ok')
  })

  it('refuses small, non-square or non-PNG favicons', async () => {
    expect(await code(processFavicon(await png(32, 32)))).toBe('too_small')
    expect(await code(processFavicon(await png(128, 64)))).toBe('not_square')
    expect(await code(processFavicon(await webp(64, 64)))).toBe('unsupported_type')
  })
})

describe('cleanBrandName', () => {
  it('trims, keeps up to 32 characters, and treats empty as no name', () => {
    expect(cleanBrandName('  Acme Events ')).toBe('Acme Events')
    expect(cleanBrandName('   ')).toBeNull()
    expect(cleanBrandName(null)).toBeNull()
    expect(() => cleanBrandName('x'.repeat(33))).toThrow(BrandingError)
    expect(() => cleanBrandName(42)).toThrow(BrandingError)
  })
})
