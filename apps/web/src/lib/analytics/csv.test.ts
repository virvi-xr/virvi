import { describe, it, expect } from 'vitest'
import { csvFileName, timeseriesCsv } from './csv'

const p = (t: string, n: number) => ({ t, sessions: n * 2, uniqueVisitors: n, peakConcurrency: 3, dwellAvgSec: 95 })

describe('analytics CSV export (LIV-38)', () => {
  it('writes one row per day, with a header, in UTC', () => {
    expect(timeseriesCsv([p('2026-11-01T00:00:00.000Z', 4), p('2026-11-02T00:00:00.000Z', 0)], 'day')).toBe(
      'Date (UTC),Visitors,Sessions,Peak at once,Average time (seconds)\r\n2026-11-01,4,8,3,95\r\n2026-11-02,0,0,3,95\r\n',
    )
  })
  it('writes hours with their time', () => {
    expect(timeseriesCsv([p('2026-11-01T13:00:00Z', 1)], 'hour').split('\r\n')[1]).toBe('2026-11-01 13:00,1,2,3,95')
  })
  it('an empty range is just the header', () => {
    expect(timeseriesCsv([], 'hour')).toBe('Hour (UTC),Visitors,Sessions,Peak at once,Average time (seconds)\r\n')
  })
  it('names the file after the location and range', () => {
    expect(csvFileName('Bubble Worlds: Main Stage!', '2026-11-01T00:00:00Z', '2026-11-07')).toBe('virvi-visitors-bubble-worlds-main-stage-2026-11-01-to-2026-11-07.csv')
    expect(csvFileName('★★★', '2026-11-01', '2026-11-07')).toBe('virvi-visitors-scene-2026-11-01-to-2026-11-07.csv')
  })
})
