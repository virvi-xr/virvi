import { describe, it, expect } from 'vitest'
import { screenStateAt, type ProgrammeItem } from '@virvixr/shared'
import { showingInstancesBetween, showingOverlaps, itemsWithoutLength, type ShowingSpec } from '../src/scenes/showings.js'

const feature: ProgrammeItem[] = [{ url: 'reel.mp4', duration: 600, kind: 'ad' }, { url: 'film.mp4', duration: 5400 }]
const fridays = (id: string, time: string, items = feature): ShowingSpec => ({
  id, items,
  schedule: { recurrence: 'weekly', startDate: '2026-10-01', startTime: time, weekdays: [5], timezone: 'America/New_York' },
})

describe('showingInstancesBetween', () => {
  it('expands repeating showings into start instants, keeping 7pm local across a daylight-saving change', () => {
    const got = showingInstancesBetween([fridays('a', '19:00')], new Date('2026-10-26T00:00:00Z'), new Date('2026-11-08T00:00:00Z'))
    expect(got.map((s) => new Date(s.startsAt).toISOString())).toEqual(['2026-10-30T23:00:00.000Z', '2026-11-07T00:00:00.000Z'])
    expect(got[0]).toMatchObject({ showingId: 'a', items: feature })
  })
  it('includes a showing that started before the window and is still running', () => {
    const got = showingInstancesBetween([fridays('a', '19:00')], new Date('2026-11-07T01:00:00Z'), new Date('2026-11-07T02:00:00Z'))
    expect(got).toHaveLength(1)
    // Joined 1h in (the reel then 50 minutes of the film)
    expect(screenStateAt(got, Date.parse('2026-11-07T01:00:00Z'))).toMatchObject({ mode: 'playing', index: 1, offset: 3000 })
  })
  it('merges several showings in start order', () => {
    const got = showingInstancesBetween([fridays('late', '21:30'), fridays('early', '19:00')], new Date('2026-11-06T00:00:00Z'), new Date('2026-11-08T00:00:00Z'))
    expect(got.map((s) => s.showingId)).toEqual(['early', 'late'])
  })
  it('a one-off shows once', () => {
    const once: ShowingSpec = { id: 'p', items: feature, schedule: { recurrence: 'once', startDate: '2026-11-13', startTime: '20:00', weekdays: [], timezone: 'Europe/London' } }
    const got = showingInstancesBetween([once], new Date('2026-11-01T00:00:00Z'), new Date('2026-12-01T00:00:00Z'))
    expect(got.map((s) => new Date(s.startsAt).toISOString())).toEqual(['2026-11-13T20:00:00.000Z'])
  })
})

describe('showingOverlaps', () => {
  it('7pm and 9:30pm Fridays fit (the 7pm show ends at 8:40pm)', () => {
    expect(showingOverlaps([fridays('a', '19:00'), fridays('b', '21:30')], new Date('2026-10-01T00:00:00Z'))).toEqual([])
  })
  it('refuses a showing that starts before the previous one ends, naming both and when', () => {
    const got = showingOverlaps([fridays('a', '19:00'), fridays('b', '20:00')], new Date('2026-10-01T00:00:00Z'))
    expect(got[0]).toEqual({ first: 'a', second: 'b', at: '2026-10-03T00:00:00.000Z' })
  })
  it('catches an overlap that only happens on some days (daily against Fridays)', () => {
    const daily: ShowingSpec = { id: 'd', items: [{ url: 's.mp4', duration: 1800 }], schedule: { recurrence: 'daily', startDate: '2026-10-01', startTime: '19:30', weekdays: [], timezone: 'America/New_York' } }
    const got = showingOverlaps([daily, fridays('f', '19:00')], new Date('2026-10-01T00:00:00Z'))
    expect(got.length).toBeGreaterThan(0)
    expect(got[0]).toMatchObject({ first: 'f', second: 'd' })
  })
  it('a showing in another timezone is compared by real time', () => {
    const london: ShowingSpec = { id: 'l', items: feature, schedule: { recurrence: 'weekly', startDate: '2026-10-01', startTime: '23:30', weekdays: [5], timezone: 'Europe/London' } }
    // 23:30 London on 2 Oct is 18:30 New York: runs to 20:10 NY, so the 7pm NY show overlaps
    expect(showingOverlaps([london, fridays('a', '19:00')], new Date('2026-10-01T00:00:00Z'))[0]).toMatchObject({ first: 'l', second: 'a' })
  })
})

describe('showingOverlaps: a showing against itself', () => {
  it('a daily programme longer than a day overlaps itself', () => {
    const long: ShowingSpec = { id: 'x', items: [{ url: 'marathon.mp4', duration: 25 * 3600 }], schedule: { recurrence: 'daily', startDate: '2026-10-01', startTime: '12:00', weekdays: [], timezone: 'UTC' } }
    expect(showingOverlaps([long], new Date('2026-10-01T00:00:00Z'))).toEqual([{ first: 'x', second: 'x', at: '2026-10-02T12:00:00.000Z' }])
  })
})

describe('itemsWithoutLength', () => {
  it('lists the videos that cannot be scheduled', () => {
    expect(itemsWithoutLength([{ url: 'a', duration: 10 }, { url: 'b', duration: 0 }, { url: 'c', duration: Number.NaN }])).toEqual(['b', 'c'])
  })
})
