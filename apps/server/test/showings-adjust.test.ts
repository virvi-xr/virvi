import { describe, it, expect } from 'vitest'
import { screenStateAt, type ProgrammeItem } from '@virvixr/shared'
import { planDelay, planEnd, planPlayNow, screenClash, showingInstancesBetween, ShowingError, type ShowingSpec } from '../src/scenes/showings.js'

const feature: ProgrammeItem[] = [{ url: 'reel.mp4', duration: 600, kind: 'ad' }, { url: 'film.mp4', duration: 5400 }]
// Daily 19:00 UTC, 1h40m
const daily = (id: string, time = '19:00', adjustments: ShowingSpec['adjustments'] = []): ShowingSpec => ({
  id, items: feature, adjustments,
  schedule: { recurrence: 'daily', startDate: '2026-10-01', startTime: time, weekdays: [], timezone: 'UTC' },
})
const at = (iso: string) => new Date(iso)
const T19 = Date.parse('2026-11-05T19:00:00Z')
const day = (from: string, to: string, specs: ShowingSpec[]) => showingInstancesBetween(specs, at(from), at(to))

describe('delaying the next show', () => {
  it('moves only the next occurrence, and delays add up', () => {
    let s = daily('a')
    s = { ...s, adjustments: planDelay(s, at('2026-11-05T18:50:00Z'), 10) }
    s = { ...s, adjustments: planDelay(s, at('2026-11-05T18:55:00Z'), 5) }
    const got = day('2026-11-05T12:00:00Z', '2026-11-07T00:00:00Z', [s])
    expect(got.map((i) => new Date(i.startsAt).toISOString())).toEqual(['2026-11-05T19:15:00.000Z', '2026-11-06T19:00:00.000Z'])
  })

  it('a show that has started cannot be delayed: the next one is', () => {
    const s = daily('a')
    const adj = planDelay(s, at('2026-11-05T19:30:00Z'), 10)
    const got = day('2026-11-05T19:30:00Z', '2026-11-07T00:00:00Z', [{ ...s, adjustments: adj }])
    expect(got.map((i) => new Date(i.startsAt).toISOString())).toEqual(['2026-11-05T19:00:00.000Z', '2026-11-06T19:10:00.000Z'])
  })

  it('refuses a delay outside 1 to 60 minutes, or past 3 hours in all', () => {
    const s = daily('a')
    expect(() => planDelay(s, at('2026-11-05T18:00:00Z'), 0)).toThrow(ShowingError)
    expect(() => planDelay(s, at('2026-11-05T18:00:00Z'), 61)).toThrow(ShowingError)
    let adj = s.adjustments!
    for (let i = 0; i < 3; i++) adj = planDelay({ ...s, adjustments: adj }, at('2026-11-05T18:00:00Z'), 60)
    expect(() => planDelay({ ...s, adjustments: adj }, at('2026-11-05T18:00:00Z'), 1)).toThrow(/3 hours/)
  })
})

describe('ending the current show early', () => {
  it('cuts the programme where it was ended, so players go back to the holding image', () => {
    const s = daily('a')
    const now = at('2026-11-05T19:30:00Z') // 20 min into the film
    const ended = { ...s, adjustments: planEnd(s, now) }
    const inst = day('2026-11-05T19:00:00Z', '2026-11-05T23:00:00Z', [ended])[0]
    expect(inst.items).toEqual([{ url: 'reel.mp4', duration: 600, kind: 'ad' }, { url: 'film.mp4', duration: 1200 }])
    expect(screenStateAt([inst], now.getTime() + 1000)).toMatchObject({ mode: 'between' })
    expect(screenStateAt([inst], now.getTime() - 1000)).toMatchObject({ mode: 'playing', index: 1 })
    // Tomorrow's is untouched
    expect(day('2026-11-06T18:00:00Z', '2026-11-06T20:00:00Z', [ended])[0].items).toEqual(feature)
  })

  it('ended during the ads, nothing of the feature is left', () => {
    const s = daily('a')
    const inst = day('2026-11-05T19:00:00Z', '2026-11-05T23:00:00Z', [{ ...s, adjustments: planEnd(s, at('2026-11-05T19:05:00Z')) }])[0]
    expect(inst.items).toEqual([{ url: 'reel.mp4', duration: 300, kind: 'ad' }])
  })

  it('refuses when the showing is not on', () => {
    expect(() => planEnd(daily('a'), at('2026-11-05T18:00:00Z'))).toThrow(/isn't on/)
  })
})

describe('play now', () => {
  it('adds a showing starting now, keeping the scheduled ones', () => {
    const s = daily('a')
    const now = at('2026-11-05T12:00:00Z')
    const got = day('2026-11-05T11:00:00Z', '2026-11-05T23:00:00Z', [{ ...s, adjustments: planPlayNow(s, now) }])
    expect(got.map((i) => i.startsAt)).toEqual([now.getTime(), T19])
    expect(screenStateAt(got, now.getTime() + 5000)).toMatchObject({ mode: 'playing', index: 0, offset: 5 })
  })

  it('a played-now showing can be ended and delayed like any other', () => {
    const s = daily('a')
    const now = at('2026-11-05T12:00:00Z')
    const played = { ...s, adjustments: planPlayNow(s, now) }
    const ended = { ...played, adjustments: planEnd(played, at('2026-11-05T12:01:00Z')) }
    expect(day('2026-11-05T11:00:00Z', '2026-11-05T13:00:00Z', [ended])[0].items).toEqual([{ url: 'reel.mp4', duration: 60, kind: 'ad' }])
  })
})

describe('screenClash', () => {
  it('names the showing a moved or added one would run into', () => {
    const a = daily('a', '19:00')
    const b = daily('b', '21:00')
    const delayed = { ...a, adjustments: planDelay(a, at('2026-11-05T18:00:00Z'), 30) } // 19:30 to 21:10
    expect(screenClash([delayed, b], 'a', at('2026-11-05T18:00:00Z'))).toMatchObject({ showingId: 'b' })
    expect(screenClash([a, b], 'a', at('2026-11-05T18:00:00Z'))).toBeNull()
    const playing = { ...b, adjustments: planPlayNow(b, at('2026-11-05T19:30:00Z')) }
    expect(screenClash([a, playing], 'b', at('2026-11-05T19:30:00Z'))).toMatchObject({ showingId: 'a' })
  })
})

describe('old adjustments', () => {
  it('are dropped once their show is days past', () => {
    const s = daily('a')
    const adj = planDelay(s, at('2026-11-01T18:00:00Z'), 10)
    expect(planDelay({ ...s, adjustments: adj }, at('2026-11-05T18:00:00Z'), 5)).toHaveLength(1)
  })
})
