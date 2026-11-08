import { describe, it, expect } from 'vitest'
import { FRAME_DEFAULTS, FRAME_THICKNESS, defaultFrame } from '@virvixr/shared'
import { FRAME_CHOICES, frameChoiceOf, frameFormOf, frameSaved, frameSummary, pickFrameChoice, thicknessFrom } from './frames'

/** The dashboard's frame field on images and video screens (LIV-129). */
describe('frame form', () => {
  it('starts from the saved frame, or a Thin one switched off', () => {
    expect(frameFormOf(undefined)).toEqual({ ...defaultFrame(), enabled: false })
    expect(frameFormOf({ enabled: true, style: 'gallery', color: '#AABBCC', thickness: 4 })).toEqual({ enabled: true, style: 'gallery', color: '#aabbcc', thickness: 4 })
    expect(frameFormOf('nonsense')).toEqual({ ...defaultFrame(), enabled: false })
  })

  it('offers None and the three styles, and shows which is chosen', () => {
    expect(FRAME_CHOICES.map((c) => c.label)).toEqual(['None', 'Thin', 'Classic', 'Gallery'])
    expect(frameChoiceOf({ ...defaultFrame('classic'), enabled: false })).toBe('none')
    expect(frameChoiceOf(defaultFrame('classic'))).toBe('classic')
  })

  it('choosing a style turns it on with that style\'s look; None turns it off and keeps the rest', () => {
    const off = frameFormOf(undefined)
    expect(pickFrameChoice(off, 'classic')).toEqual({ enabled: true, style: 'classic', ...FRAME_DEFAULTS.classic })
    const custom = { ...defaultFrame(), color: '#ff0000' }
    expect(pickFrameChoice(custom, 'gallery').color).toBe('#ff0000')
    expect(pickFrameChoice(custom, 'none')).toEqual({ ...custom, enabled: false })
  })

  it('reads a typed or slid thickness, held in range and to whole steps', () => {
    expect(thicknessFrom('7')).toBe(7)
    expect(thicknessFrom('7.6')).toBe(8)
    expect(thicknessFrom('0')).toBe(FRAME_THICKNESS.min)
    expect(thicknessFrom('99')).toBe(FRAME_THICKNESS.max)
    expect(thicknessFrom('abc')).toBeNull()
  })

  it('saving puts the frame in with the element\'s other properties, checked', () => {
    expect(frameSaved({ textureSrc: 'a.png' }, defaultFrame('classic'))).toEqual({ ok: true, properties: { textureSrc: 'a.png', frame: defaultFrame('classic') } })
    expect(frameSaved({ textureSrc: 'a.png' }, { ...defaultFrame(), color: '#12' })).toEqual({ ok: false, error: 'The frame colour must be a hex colour like #1c1c1c.' })
  })

  it('sums up the saved frame in a few words', () => {
    expect(frameSummary(undefined)).toBe('None')
    expect(frameSummary({ ...defaultFrame(), enabled: false })).toBe('None')
    expect(frameSummary(defaultFrame('classic'))).toBe('Classic · Wood · 6%')
    expect(frameSummary({ ...defaultFrame(), color: '#123456' })).toBe('Thin · #123456 · 2%')
  })
})
