import { describe, it, expect } from 'vitest'
import { HUD_ICON_SRC, hudIconInScene, HUD_ICON_MISSING_HINT } from '../src/hud/icon.js'

describe('hudIconInScene', () => {
  it("finds the icon in the scene's deployed files, whatever their case", () => {
    expect(hudIconInScene([{ file: 'bin/index.js' }, { file: HUD_ICON_SRC }])).toBe(true)
    expect(hudIconInScene([{ file: 'Images/Virvi/HUD-V.png' }])).toBe(true)
  })
  it('reports a scene deployed without it (virvi-dcl install never ran)', () => {
    expect(hudIconInScene([{ file: 'bin/index.js' }, { file: 'scene.json' }])).toBe(false)
  })
  it("doesn't guess when the file list is unknown", () => {
    expect(hudIconInScene(undefined)).toBeNull()
    expect(hudIconInScene([])).toBeNull()
  })
})

it('the hint says how to fix it', () => {
  expect(HUD_ICON_MISSING_HINT).toContain('npx @virvixr/dcl install')
  expect(HUD_ICON_MISSING_HINT).toContain(HUD_ICON_SRC)
})
