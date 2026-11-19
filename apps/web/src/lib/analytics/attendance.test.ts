import { describe, it, expect } from 'vitest'
import type { EventAttendanceReport } from '@virvixr/shared'
import { attendanceCsv, attendanceFileName, csvCell, presentLabel } from './attendance'

describe('event attendance helpers', () => {
  it('labels time present', () => {
    expect(presentLabel(10)).toBe('<1 min')
    expect(presentLabel(25 * 60)).toBe('25 min')
    expect(presentLabel(60 * 60)).toBe('1 h')
    expect(presentLabel(65 * 60)).toBe('1 h 5 min')
  })

  it('quotes cells and defuses formulas', () => {
    expect(csvCell('Ann, B')).toBe('"Ann, B"')
    expect(csvCell('say "hi"')).toBe('"say ""hi"""')
    expect(csvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`)
    expect(csvCell('@me')).toBe("'@me")
    expect(csvCell(-3)).toBe('-3')
    expect(csvCell(null)).toBe('')
  })

  it('writes one row per attendee', () => {
    const r: EventAttendanceReport = {
      from: '2026-11-19T18:00:00.000Z', to: '2026-11-19T20:00:00.000Z', locations: 1, truncated: false,
      totals: { visitors: 2, verifiedVisitors: 1, peakConcurrent: 2, avgSecondsPresent: 900 },
      attendees: [
        { visitorId: 'abc', location: 'Main Hall', displayName: 'Ann', wallet: '0xa', verified: true, isGuest: false, firstSeenAt: '2026-11-19T18:05:00.000Z', secondsPresent: 1500 },
        { visitorId: 'def', location: 'Main Hall', displayName: null, wallet: null, verified: false, isGuest: true, firstSeenAt: '2026-11-19T18:30:00.000Z', secondsPresent: 300 },
      ],
    }
    expect(attendanceCsv(r).split('\r\n')).toEqual([
      'Name,Wallet,Verified wallet,Guest,Location,First seen (UTC),Minutes present,Visitor ID',
      'Ann,0xa,yes,no,Main Hall,2026-11-19 18:05,25,abc',
      ',,no,yes,Main Hall,2026-11-19 18:30,5,def',
      '',
    ])
    expect(attendanceFileName('Launch Party!', r.from)).toBe('virvi-attendance-launch-party-2026-11-19.csv')
  })
})
