import { describe, it, expect } from 'vitest'
import { FRAME_DEFAULTS, FRAME_THICKNESS, defaultFrame } from '@virvixr/shared'
import { FRAMEABLE, frameDraftOf, frameFromDraft, frameLabel, stepThickness, withDraftStyle, withFrame } from '../src/frames.js'
import { toLayoutItem } from '../src/layout.js'

/** Setting an image's or screen's frame from the HUD's Layout panel (LIV-129). */
describe('HUD frame editing', () => {
  it('only images and video screens take a frame (ad spaces stay unframed)', () => {
    expect([...FRAMEABLE].sort()).toEqual(['image', 'video'])
  })

  it('a draft starts from the saved frame, or a Thin one switched off', () => {
    expect(frameDraftOf(null)).toEqual({ ...defaultFrame(), enabled: false })
    const saved = { enabled: true, style: 'classic' as const, color: '#c9a227', thickness: 9 }
    expect(frameDraftOf(saved)).toEqual(saved)
  })

  it('picking a style turns the frame on and brings that style\'s look; Off keeps the settings', () => {
    const d = frameDraftOf(null)
    const classic = withDraftStyle(d, 'classic')
    expect(classic).toEqual({ enabled: true, style: 'classic', ...FRAME_DEFAULTS.classic })
    expect(withDraftStyle(classic, 'off')).toEqual({ ...classic, enabled: false })
  })

  it('thickness steps by one and stays in range', () => {
    const d = { ...defaultFrame(), thickness: FRAME_THICKNESS.max }
    expect(stepThickness(d, 1).thickness).toBe(FRAME_THICKNESS.max)
    expect(stepThickness(d, -1).thickness).toBe(FRAME_THICKNESS.max - 1)
    expect(stepThickness({ ...d, thickness: FRAME_THICKNESS.min }, -1).thickness).toBe(FRAME_THICKNESS.min)
  })

  it('a draft is checked the way the server checks it', () => {
    expect(frameFromDraft(defaultFrame('gallery'))).toEqual({ ok: true, value: defaultFrame('gallery') })
    expect(frameFromDraft({ ...defaultFrame(), color: 'red' }).ok).toBe(false)
  })

  it('reads in a few words', () => {
    expect(frameLabel(null)).toBe('No frame')
    expect(frameLabel({ ...defaultFrame(), enabled: false })).toBe('No frame')
    expect(frameLabel(defaultFrame('classic'))).toBe('Classic frame, 6%')
  })

  it('saving keeps the element\'s other properties', () => {
    expect(withFrame({ textureSrc: 'a.png', emission: 1 }, defaultFrame())).toEqual({ textureSrc: 'a.png', emission: 1, frame: defaultFrame() })
    expect(withFrame(null, defaultFrame())).toEqual({ frame: defaultFrame() })
  })

  it('a layout row carries the saved frame, and keeps it across an update without properties', () => {
    const row = toLayoutItem({ id: 'e1', name: 'Poster', type: 'image', properties: { frame: defaultFrame('gallery') } })
    expect(row.frame).toEqual(defaultFrame('gallery'))
    expect(toLayoutItem({ id: 'e1', name: 'Poster', type: 'image', enabled: false }, row).frame).toEqual(defaultFrame('gallery'))
    expect(toLayoutItem({ id: 'e2', name: 'Bad', type: 'image', properties: { frame: 'gold' } }).frame).toBeNull()
    // stored outside the rules: shown as drawn (thickness held at the most), not as no frame
    expect(toLayoutItem({ id: 'e3', name: 'Old', type: 'image', properties: { frame: { enabled: true, style: 'thin', thickness: 99 } } }).frame)
      .toEqual({ ...defaultFrame(), thickness: FRAME_THICKNESS.max })
  })
})
