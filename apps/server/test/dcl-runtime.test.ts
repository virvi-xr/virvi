import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { runtimeFiles, DCL_RUNTIME_VERSION } from '../src/services/dcl/runtime.js'

describe('dcl runtime', () => {
  it('returns the built generic runtime', async () => {
    const files = await runtimeFiles()
    const js = files.get('bin/index.js')
    expect(js && js.byteLength).toBeGreaterThan(0)
    const src = Buffer.from(js!).toString('utf8')
    expect(src).toContain('getSceneInformation')
    // The HUD registers with a virtual canvas (scales on high-DPI screens) and textures its launcher from the icon
    expect(src).toContain('virtualWidth')
    expect(src).toContain('images/virvi/hud-v.png')
    expect(DCL_RUNTIME_VERSION).toBe(9)
  })

  it('names Virvi items for analytics (v4)', async () => {
    const src = Buffer.from((await runtimeFiles()).get('bin/index.js')!).toString('utf8')
    expect(src).toContain('Video screen')
    expect(src).toContain('Unnamed object')
  })

  it('falls back to a plain V when the HUD icon is missing, and tells an out-of-date HUD to redeploy (v5)', async () => {
    const src = Buffer.from((await runtimeFiles()).get('bin/index.js')!).toString('utf8')
    expect(src).toContain('is not in this scene, so the HUD launcher shows a plain V')
    expect(src).toContain('This scene needs a redeploy to edit')
  })

  it('plays scheduled showings and has the HUD Presets section (v6)', async () => {
    const src = Buffer.from((await runtimeFiles()).get('bin/index.js')!).toString('utf8')
    expect(src).toContain('screen_showings')
    expect(src).toContain('Now showing')
    expect(src).toContain('Presets')
  })

  it('has the HUD Stream panel, off image picker, Clear copies and the next scheduled switch (v7)', async () => {
    const src = Buffer.from((await runtimeFiles()).get('bin/index.js')!).toString('utf8')
    expect(src).toContain('streams_choose')
    expect(src).toContain('streams_off_image')
    expect(src).toContain('layout_clear')
    expect(src).toContain('Next switch')
  })

  it('has the showings list and host controls on Schedule-mode screens (v8)', async () => {
    const src = Buffer.from((await runtimeFiles()).get('bin/index.js')!).toString('utf8')
    expect(src).toContain('showings_open')
    expect(src).toContain('showings_control')
    expect(src).toContain('Close showings')
  })

  it('runs placed items\' click actions: link, sound, move and teleport (v9)', async () => {
    const src = Buffer.from((await runtimeFiles()).get('bin/index.js')!).toString('utf8')
    expect(src).toContain('.teleportTo=="string"')
    expect(src).toContain('.teleportPlayer(')
    expect(src).toContain('.movePlayer(')
  })

  it('keeps v3 to v8 for deploys still waiting to be signed', async () => {
    for (const v of [3, 4, 5, 6, 7, 8]) expect((await runtimeFiles(v)).has('bin/index.js')).toBe(true)
  })

  it('speaks the Virvi protocol only', async () => {
    const src = Buffer.from((await runtimeFiles()).get('bin/index.js')!).toString('utf8')
    expect(src).toContain('virvi_scene')
    expect(src).not.toMatch(/vlm_scene|vlm\.gg|models\/vlm\//) // virvi-rename: keep
  })

  it('deploys the HUD icon with the runtime', async () => {
    const files = await runtimeFiles()
    expect([...files.keys()].sort()).toEqual(['bin/index.js', 'images/virvi/hud-v.png'])
    const icon = files.get('images/virvi/hud-v.png')!
    const asset = readFileSync(new URL('../../../packages/dcl/assets/hud-v.png', import.meta.url))
    expect(Buffer.from(icon).equals(asset)).toBe(true)
  })

  it('ships no pre-Virvi runtime (clean break: v1 and v2 used the old protocol)', async () => {
    await expect(runtimeFiles(1)).rejects.toThrow()
    await expect(runtimeFiles(2)).rejects.toThrow()
  })

  it('rejects an unknown version', async () => {
    await expect(runtimeFiles(99)).rejects.toThrow()
    await expect(runtimeFiles(0)).rejects.toThrow()
  })
})
