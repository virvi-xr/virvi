import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { BeatsGateView, FrozenNote } from './BeatBits'
import type { BeatAvailability } from '@/lib/beats'

describe('FrozenNote', () => {
  it('shows the locked sentence on a BEAT that has started', () => {
    expect(renderToStaticMarkup(createElement(FrozenNote, { locked: true }))).toContain('This BEAT has started, so its name, description, Tradeable setting, location and times are locked')
  })
  it('shows nothing otherwise', () => {
    expect(renderToStaticMarkup(createElement(FrozenNote, { locked: false }))).toBe('')
  })
})

describe('BeatsGateView', () => {
  const NOTICE = 'BEATs on this network are temporarily unavailable. Existing BEATs are safe.'
  const render = (a: BeatAvailability | null) => renderToStaticMarkup(createElement(BeatsGateView, { a, children: () => createElement('p', null, 'THE BEATS') }))
  it('shows the BEATs with no notice while the network is set up', () => {
    const html = render({ enabled: true, chain: 'polygon', test: false, canCreate: true, reason: null })
    expect(html).toContain('THE BEATS')
    expect(html).not.toContain(NOTICE)
  })
  it('an unconfigured network keeps the BEATs, with a short notice above them', () => {
    const html = render({ enabled: true, chain: 'polygon', test: false, canCreate: false, reason: 'not_configured' })
    expect(html).toContain(NOTICE)
    expect(html).toContain('THE BEATS')
    expect(html.indexOf(NOTICE)).toBeLessThan(html.indexOf('THE BEATS'))
  })
  it('while BEATs are off, says so and nothing else', () => {
    const html = render({ enabled: false, chain: 'polygon', test: false, canCreate: false, reason: null })
    expect(html).toContain("BEATs aren&#x27;t available yet.")
    expect(html).not.toContain('THE BEATS')
  })
})
