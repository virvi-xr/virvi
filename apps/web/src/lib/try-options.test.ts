import { describe, expect, it } from 'vitest'
import { TRY_OPTIONS } from './try-options'

describe('TRY_OPTIONS', () => {
  it('offers the Design Studio first, then the scene builder, at their public try pages', () => {
    expect(TRY_OPTIONS.map((o) => [o.key, o.href])).toEqual([
      ['studio', '/try/studio/'],
      ['scene', '/try/scene/'],
    ])
  })
})
