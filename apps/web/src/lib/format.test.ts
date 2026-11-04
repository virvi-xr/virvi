import { describe, it, expect } from 'vitest'
import { countLabel, formatBytes, formatDuration, plural } from './format'

describe('list formatting', () => {
  it('pads the count to two digits and separates thousands', () => {
    expect(countLabel(2)).toBe('02')
    expect(countLabel(0)).toBe('00')
    expect(countLabel(123)).toBe('123')
    expect(countLabel(5482)).toBe('5,482')
  })

  it('pluralizes the noun after the count', () => {
    expect(plural(1, 'event')).toBe('1 event')
    expect(plural(4, 'event')).toBe('4 events')
    expect(plural(0, 'file')).toBe('0 files')
    expect(plural(5482, 'asset')).toBe('5,482 assets')
  })

  it('formats file sizes', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(292_966)).toBe('286.1 KB')
    expect(formatBytes(1_468_006)).toBe('1.4 MB')
  })

  it('formats video lengths as m:ss, or h:mm:ss from an hour', () => {
    expect(formatDuration(2.7)).toBe('0:03')
    expect(formatDuration(59.4)).toBe('0:59')
    expect(formatDuration(754)).toBe('12:34')
    expect(formatDuration(8100.4)).toBe('2:15:00')
    expect(formatDuration(3599.6)).toBe('1:00:00')
  })

  it('has no length for a missing or bad value', () => {
    expect(formatDuration(undefined)).toBeNull()
    expect(formatDuration(null)).toBeNull()
    expect(formatDuration(0)).toBeNull()
    expect(formatDuration('12' as unknown)).toBeNull()
    expect(formatDuration(Number.NaN)).toBeNull()
  })
})
