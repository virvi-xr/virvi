import { describe, it, expect } from 'vitest'
import { FRAME_DEFAULTS, FRAME_THICKNESS, checkFrame, defaultFrame, frameOf, frameColorRgb, withFrameStyle } from '@virvixr/shared'

/** Frames around images and video screens (LIV-129): what may be saved, and what a runtime draws. */
describe('checkFrame', () => {
  it('keeps a valid frame, tidied', () => {
    expect(checkFrame({ enabled: true, style: 'classic', color: '#6B4A2B', thickness: 8 }))
      .toEqual({ ok: true, value: { enabled: true, style: 'classic', color: '#6b4a2b', thickness: 8 } })
    // A frame switched off keeps its settings, so switching it back on brings them back
    expect(checkFrame({ enabled: false, style: 'gallery', color: '#ffffff', thickness: 3, extra: 1 }))
      .toEqual({ ok: true, value: { enabled: false, style: 'gallery', color: '#ffffff', thickness: 3 } })
  })
  it('fills in the style defaults for a missing colour or thickness', () => {
    expect(checkFrame({ enabled: true, style: 'thin' })).toEqual({ ok: true, value: { enabled: true, ...FRAME_DEFAULTS.thin, style: 'thin' } })
  })
  it('null removes the frame', () => {
    expect(checkFrame(null)).toEqual({ ok: true, value: null })
  })
  it('refuses what it could not draw, with a reason', () => {
    expect(checkFrame('gold')).toEqual({ ok: false, error: 'That frame is not available.' })
    expect(checkFrame({ enabled: true, style: 'ornate' })).toEqual({ ok: false, error: 'Choose a frame style: Thin, Classic or Gallery.' })
    expect(checkFrame({ enabled: true, style: 'thin', color: 'red' })).toEqual({ ok: false, error: 'The frame colour must be a hex colour like #1c1c1c.' })
    expect(checkFrame({ enabled: true, style: 'thin', thickness: 0 }))
      .toEqual({ ok: false, error: `Frame thickness goes from ${FRAME_THICKNESS.min} to ${FRAME_THICKNESS.max}.` })
    expect(checkFrame({ enabled: true, style: 'thin', thickness: 21 }).ok).toBe(false)
    expect(checkFrame({ enabled: true, style: 'thin', thickness: '5' }).ok).toBe(false)
    expect(checkFrame({ enabled: 'yes', style: 'thin' })).toEqual({ ok: false, error: 'A frame is on or off.' })
  })
})

describe('frameOf (what a runtime draws)', () => {
  it('is null with no frame, a frame switched off, or one it does not know', () => {
    expect(frameOf(undefined)).toBeNull()
    expect(frameOf(null)).toBeNull()
    expect(frameOf({ enabled: false, style: 'thin' })).toBeNull()
    expect(frameOf({ enabled: true, style: 'ornate' })).toBeNull()
    expect(frameOf('thin')).toBeNull()
  })
  it('draws a usable frame from anything close: a bad colour or thickness falls back or is held in range', () => {
    expect(frameOf({ enabled: true, style: 'classic', color: 'nope', thickness: 99 }))
      .toEqual({ enabled: true, style: 'classic', color: FRAME_DEFAULTS.classic.color, thickness: FRAME_THICKNESS.max })
    expect(frameOf({ enabled: true, style: 'thin', thickness: -3 })!.thickness).toBe(FRAME_THICKNESS.min)
  })
})

describe('frame helpers', () => {
  it('a new frame is Thin with its defaults, switched on', () => {
    expect(defaultFrame()).toEqual({ enabled: true, style: 'thin', ...FRAME_DEFAULTS.thin })
  })
  it('changing style brings that style\'s colour and thickness, unless they were changed from the old style\'s', () => {
    const thin = defaultFrame()
    expect(withFrameStyle(thin, 'classic')).toEqual({ enabled: true, style: 'classic', ...FRAME_DEFAULTS.classic })
    const custom = { ...thin, color: '#ff0000', thickness: 5 }
    expect(withFrameStyle(custom, 'gallery')).toEqual({ enabled: true, style: 'gallery', color: '#ff0000', thickness: 5 })
  })
  it('reads a hex colour as 0-1 channels', () => {
    expect(frameColorRgb('#ff8000')).toEqual({ r: 1, g: 128 / 255, b: 0 })
  })
  it('defaults are inside the range', () => {
    for (const d of Object.values(FRAME_DEFAULTS)) {
      expect(d.thickness).toBeGreaterThanOrEqual(FRAME_THICKNESS.min)
      expect(d.thickness).toBeLessThanOrEqual(FRAME_THICKNESS.max)
    }
  })
})
