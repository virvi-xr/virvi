import { describe, it, expect } from 'vitest'
import { screenRows } from './screens'

describe('screens on the analytics page (LIV-38)', () => {
  it('lists screens by watch time, with the average per play', () => {
    expect(screenRows({ Lobby: { plays: 4, watchSec: 100 }, Stage: { plays: 2, watchSec: 900 }, Idle: { plays: 0, watchSec: 0 } })).toEqual([
      { name: 'Stage', plays: 2, watchSec: 900, avgSec: 450 },
      { name: 'Lobby', plays: 4, watchSec: 100, avgSec: 25 },
    ])
  })
  it('is empty with no data, or from an older server', () => {
    expect(screenRows(undefined)).toEqual([])
    expect(screenRows({})).toEqual([])
  })
  it('keeps the top few', () => {
    const many = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`S${i}`, { plays: 1, watchSec: i }]))
    expect(screenRows(many)).toHaveLength(8)
  })
})
