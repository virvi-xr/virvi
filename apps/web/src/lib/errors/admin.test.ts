import { describe, it, expect } from 'vitest'
import { hourlyBuckets, barHeights, kindLabel, sinceLabel } from './admin'

describe('Errors page helpers', () => {
  it('fills a timeline into fixed hours ending now, with zeros for quiet hours', () => {
    const now = Date.parse('2026-11-08T12:30:00Z')
    const b = hourlyBuckets([{ hour: '2026-11-08T10:00:00.000Z', count: 3 }, { hour: '2026-11-08T12:00:00.000Z', count: 5 }, { hour: '2026-11-01T00:00:00.000Z', count: 9 }], 4, now)
    expect(b).toEqual([
      { hour: '2026-11-08T09:00:00.000Z', count: 0 }, { hour: '2026-11-08T10:00:00.000Z', count: 3 },
      { hour: '2026-11-08T11:00:00.000Z', count: 0 }, { hour: '2026-11-08T12:00:00.000Z', count: 5 },
    ])
  })
  it('scales bars to the largest, keeping any non-zero bar visible', () => {
    expect(barHeights([0, 1, 50, 100])).toEqual([0, 2, 50, 100])
    expect(barHeights([0, 0])).toEqual([0, 0])
  })
  it('labels kinds and ages plainly', () => {
    expect(kindLabel('server_5xx')).toBe('Server 5xx')
    expect(kindLabel('api')).toBe('API error')
    expect(sinceLabel('2026-11-08T12:00:00Z', Date.parse('2026-11-08T12:30:00Z'))).toBe('30m ago')
    expect(sinceLabel('2026-11-06T12:00:00Z', Date.parse('2026-11-08T12:00:00Z'))).toBe('2d ago')
  })
})
