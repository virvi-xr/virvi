import { describe, it, expect } from 'vitest'
import { movedHref } from './redirect'

describe('movedHref', () => {
  it('keeps the query and the hash', () => {
    expect(movedHref('/sync', '?scene=s1', '#history')).toBe('/sync?scene=s1#history')
    expect(movedHref('/drops', '?id=g1&tab=claims', '')).toBe('/drops?id=g1&tab=claims')
  })
  it('is just the new path when there is neither', () => {
    expect(movedHref('/sync', '', '')).toBe('/sync')
  })
  it('adds the ? and # when they are missing', () => {
    expect(movedHref('/drops', 'id=g1', 'top')).toBe('/drops?id=g1#top')
    expect(movedHref('/drops', '?', '#')).toBe('/drops')
  })
})
