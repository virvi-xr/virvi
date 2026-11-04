import { describe, it, expect } from 'vitest'
import { isTimeZone, latestStart, nextStarts, occurrencesBetween, zonedToUtc, type ScheduleSpec } from '../src/scenes/schedule-time.js'

const spec = (s: Partial<ScheduleSpec>): ScheduleSpec => ({
  recurrence: 'daily', startDate: '2026-03-01', startTime: '19:00', weekdays: [], durationMinutes: 60, timezone: 'America/New_York', ...s,
})
const iso = (d: Date | null | undefined) => d?.toISOString() ?? null

describe('zonedToUtc', () => {
  it('turns a wall-clock time in a timezone into the instant', () => {
    expect(iso(zonedToUtc('2026-01-15', '19:00', 'America/New_York'))).toBe('2026-01-16T00:00:00.000Z') // EST, UTC-5
    expect(iso(zonedToUtc('2026-07-15', '19:00', 'America/New_York'))).toBe('2026-07-15T23:00:00.000Z') // EDT, UTC-4
    expect(iso(zonedToUtc('2026-07-15', '09:30', 'Asia/Kolkata'))).toBe('2026-07-15T04:00:00.000Z')
    expect(iso(zonedToUtc('2026-07-15', '00:00', 'UTC'))).toBe('2026-07-15T00:00:00.000Z')
  })
  it('moves a time that does not exist (the spring-forward hour) to just after the gap', () => {
    // 2026-03-08 02:30 never happens in New York; 03:30 EDT does
    expect(iso(zonedToUtc('2026-03-08', '02:30', 'America/New_York'))).toBe('2026-03-08T07:30:00.000Z')
  })
})

describe('isTimeZone', () => {
  it('accepts IANA names and refuses anything else', () => {
    expect(isTimeZone('Europe/Berlin')).toBe(true)
    expect(isTimeZone('UTC')).toBe(true)
    expect(isTimeZone('Mars/Olympus')).toBe(false)
    expect(isTimeZone('')).toBe(false)
  })
})

describe('daily schedules', () => {
  it('keep 7pm local across the daylight-saving change', () => {
    const s = spec({ startDate: '2026-03-06' })
    const starts = occurrencesBetween(s, new Date('2026-03-06T00:00:00Z'), new Date('2026-03-10T00:00:00Z')).map((o) => iso(o.start))
    expect(starts).toEqual([
      '2026-03-07T00:00:00.000Z', // Mar 6, 19:00 EST
      '2026-03-08T00:00:00.000Z', // Mar 7, 19:00 EST
      '2026-03-08T23:00:00.000Z', // Mar 8, 19:00 EDT
      '2026-03-09T23:00:00.000Z', // Mar 9, 19:00 EDT
    ])
  })
  it('do not start before their first date, and each occurrence ends after its duration', () => {
    const [first] = occurrencesBetween(spec({ startDate: '2026-05-10', durationMinutes: 90 }), new Date('2026-05-01T00:00:00Z'), new Date('2026-05-30T00:00:00Z'))
    expect(iso(first.start)).toBe('2026-05-10T23:00:00.000Z')
    expect(iso(first.end)).toBe('2026-05-11T00:30:00.000Z')
  })
})

describe('weekly schedules', () => {
  it('run on the chosen weekdays only (0 = Sunday), in local time', () => {
    const s = spec({ recurrence: 'weekly', weekdays: [5], startDate: '2026-11-01', startTime: '20:00', timezone: 'Europe/London' })
    const starts = nextStarts(s, new Date('2026-11-01T00:00:00Z'), 3).map(iso)
    expect(starts).toEqual(['2026-11-06T20:00:00.000Z', '2026-11-13T20:00:00.000Z', '2026-11-20T20:00:00.000Z'])
  })
})

describe('one-off schedules', () => {
  it('happen once', () => {
    const s = spec({ recurrence: 'once', startDate: '2026-11-06', startTime: '20:00', durationMinutes: 180 })
    expect(nextStarts(s, new Date('2026-11-01T00:00:00Z'), 5).map(iso)).toEqual(['2026-11-07T01:00:00.000Z'])
    expect(nextStarts(s, new Date('2026-11-08T00:00:00Z'), 5)).toEqual([])
  })
})

describe('latestStart', () => {
  it('finds the occurrence in progress (or the last one) at a moment', () => {
    const s = spec({ startDate: '2026-06-01', durationMinutes: 60 })
    const during = latestStart(s, new Date('2026-06-03T23:30:00Z'))!
    expect(iso(during.start)).toBe('2026-06-03T23:00:00.000Z')
    expect(iso(during.end)).toBe('2026-06-04T00:00:00.000Z')
    expect(latestStart(s, new Date('2026-05-31T00:00:00Z'))).toBeNull()
  })
  it('an open-ended occurrence has no end', () => {
    const s = spec({ recurrence: 'once', startDate: '2026-06-01', durationMinutes: null })
    expect(latestStart(s, new Date('2027-01-01T00:00:00Z'))!.end).toBeNull()
  })
})
