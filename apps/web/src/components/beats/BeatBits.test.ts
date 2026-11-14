import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { FrozenNote } from './BeatBits'

describe('FrozenNote', () => {
  it('shows the locked sentence on a frozen BEAT', () => {
    expect(renderToStaticMarkup(createElement(FrozenNote, { frozen: true }))).toContain('Name, description and artwork are locked once the first BEAT is minted.')
  })
  it('shows nothing otherwise', () => {
    expect(renderToStaticMarkup(createElement(FrozenNote, { frozen: false }))).toBe('')
  })
})
