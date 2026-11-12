import { describe, it, expect } from 'vitest'
import { creditLine, licenseLabel } from './catalog'

describe('catalog credits', () => {
  it('credits an MIT pack model with its artist and license', () => {
    expect(creditLine({ author: 'Mr Dhingia', pack: { id: 'dhingia-interiors', name: 'Mr Dhingia: Interiors', license: 'mit', attribution: 'MIT…' } }))
      .toBe('by Mr Dhingia · Mr Dhingia: Interiors · MIT')
  })

  it('says when a pack states no license', () => {
    expect(creditLine({ author: 'Kirzoz', pack: { id: 'last-slice-kirzoz', name: 'Last Slice: Kirzoz', license: 'unstated', attribution: '' } }))
      .toBe('by Kirzoz · Last Slice: Kirzoz · license unstated')
  })

  it('a model with no pack (a user upload) has no credit line', () => {
    expect(creditLine({ author: 'me', pack: null })).toBe('')
    expect(creditLine({ author: null })).toBe('')
  })

  it('leaves out a missing artist', () => {
    expect(creditLine({ author: null, pack: { id: 'p', name: 'P', license: 'mit', attribution: '' } })).toBe('P · MIT')
  })

  it('labels licenses', () => {
    expect(licenseLabel('cc-by-nc-3.0')).toBe('CC BY-NC 3.0')
    expect(licenseLabel('mit')).toBe('MIT')
    expect(licenseLabel('unstated')).toBe('license unstated')
    expect(licenseLabel('cc0')).toBe('CC0')
    expect(licenseLabel('something-else')).toBe('something-else')
    // The licenses a model can be shared under (LIV-20)
    expect(licenseLabel('cc-by-sa-4.0')).toBe('CC BY-SA 4.0')
    expect(licenseLabel('cc0-1.0')).toBe('CC0 (public domain)')
    expect(licenseLabel('virvi-only')).toBe('Virvi users only')
  })
})
