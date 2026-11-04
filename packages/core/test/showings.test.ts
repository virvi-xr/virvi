import { describe, it, expect } from 'vitest'
import {
  programmeLength, positionAt, screenStateAt, findShowingOverlaps, serverNow, needsResync, showingSign,
  type ProgrammeItem, type ShowingInstance,
} from '@virvixr/shared'

const MIN = 60_000
// Pre-show reel 5:00, two trailers 2:30 each, feature 1:30:00
const programme: ProgrammeItem[] = [
  { url: 'reel.mp4', duration: 300, kind: 'video' },
  { url: 'trailer-a.mp4', duration: 150, kind: 'ad' },
  { url: 'trailer-b.mp4', duration: 150, kind: 'ad' },
  { url: 'feature.mp4', duration: 5400, kind: 'video' },
]
const T0 = Date.UTC(2026, 10, 6, 0, 0) // Fri 7pm New York
const show = (startsAt: number, items = programme, id = 's1'): ShowingInstance => ({ showingId: id, startsAt, items, title: 'Night of the Living Dead' })

describe('programmeLength', () => {
  it('adds up the items', () => {
    expect(programmeLength(programme)).toBe(6000)
    expect(programmeLength([])).toBe(0)
  })
})

describe('positionAt', () => {
  it('finds the item and the second into it', () => {
    expect(positionAt(programme, 0)).toEqual({ index: 0, offset: 0 })
    expect(positionAt(programme, 299.5)).toEqual({ index: 0, offset: 299.5 })
    expect(positionAt(programme, 754)).toEqual({ index: 3, offset: 154 })
  })
  it('an item boundary belongs to the next item', () => {
    expect(positionAt(programme, 300)).toEqual({ index: 1, offset: 0 })
    expect(positionAt(programme, 600)).toEqual({ index: 3, offset: 0 })
  })
  it('is null before the start and from the end on', () => {
    expect(positionAt(programme, -1)).toBeNull()
    expect(positionAt(programme, 6000)).toBeNull()
    expect(positionAt([], 0)).toBeNull()
  })
  it('skips items with no usable length', () => {
    const items = [{ url: 'a', duration: 0 }, { url: 'b', duration: 10 }]
    expect(positionAt(items, 0)).toEqual({ index: 1, offset: 0 })
  })
})

describe('screenStateAt', () => {
  const showings = [show(T0 + 150 * MIN, programme, 's2'), show(T0)] // out of order on purpose

  it('is between shows before the first, counting down to it', () => {
    expect(screenStateAt(showings, T0 - 10 * MIN)).toEqual({ mode: 'between', next: showings[1], startsIn: 600 })
  })
  it('plays the right item at the right second mid-show, with how long ago it started', () => {
    const s = screenStateAt(showings, T0 + 754_000)
    expect(s).toMatchObject({ mode: 'playing', index: 3, offset: 154, elapsed: 754, endsAt: T0 + 6_000_000 })
    if (s.mode === 'playing') {
      expect(s.showing.showingId).toBe('s1')
      expect(s.item.url).toBe('feature.mp4')
      expect(s.next?.showingId).toBe('s2')
    }
  })
  it('is between shows once a showing ends, counting down to the next', () => {
    expect(screenStateAt(showings, T0 + 6_000_000)).toEqual({ mode: 'between', next: showings[0], startsIn: 3000 })
  })
  it('has nothing next after the last showing', () => {
    expect(screenStateAt(showings, T0 + 150 * MIN + 6_000_000)).toEqual({ mode: 'between', next: null, startsIn: null })
    expect(screenStateAt([], T0)).toEqual({ mode: 'between', next: null, startsIn: null })
  })
  it('two visitors arriving at different times see the same moment', () => {
    const now = T0 + 3_333_000
    // One joined at 7:02, the other at 7:40; both ask at the same server instant
    const a = screenStateAt(showings, now)
    const b = screenStateAt(showings, now)
    expect(a).toEqual(b)
    expect(a).toMatchObject({ index: 3, offset: 2733 })
  })
  it('works out a whole programme played from a daylight-saving week (start instants are UTC)', () => {
    // 7pm New York on the Saturday before and the Sunday after the 2026-11-01 change are 23:00Z and 00:00Z
    const before = show(Date.UTC(2026, 9, 31, 23, 0))
    const after = show(Date.UTC(2026, 10, 2, 0, 0))
    expect(screenStateAt([before, after], Date.UTC(2026, 10, 2, 0, 12, 34))).toMatchObject({ mode: 'playing', index: 3, offset: 154 })
  })
})

describe('findShowingOverlaps', () => {
  it('finds showings that start before the one before them ends', () => {
    const a = show(T0, programme, 'a')
    const b = show(T0 + 99 * MIN, programme, 'b') // a runs 100 minutes
    const c = show(T0 + 200 * MIN, programme, 'c') // b ends at T0+199m
    expect(findShowingOverlaps([c, b, a])).toEqual([['a', 'b']])
  })
  it('back to back is fine', () => {
    expect(findShowingOverlaps([show(T0, programme, 'a'), show(T0 + 100 * MIN, programme, 'b')])).toEqual([])
  })
  it('a long showing can overlap several after it', () => {
    const long = show(T0, [{ url: 'x', duration: 3 * 3600 }], 'long')
    expect(findShowingOverlaps([long, show(T0 + 60 * MIN, programme, 'b'), show(T0 + 170 * MIN, programme, 'c')]))
      .toEqual([['long', 'b'], ['long', 'c']])
  })
})

describe('server clock', () => {
  it('corrects the local clock by the measured offset', () => {
    expect(serverNow(1_000_000, -2500)).toBe(997_500)
  })
  it('asks for a re-seek only past the tolerance', () => {
    expect(needsResync(100, 101.5)).toBe(false)
    expect(needsResync(100, 97.9)).toBe(true)
    expect(needsResync(100, 102.5, 3)).toBe(false)
  })
})

describe('showingSign', () => {
  const T = Date.UTC(2026, 10, 6, 20, 0)
  const film = (extra: Partial<ShowingInstance> = {}): ShowingInstance => ({
    showingId: 's', startsAt: T, title: 'Film',
    items: [{ url: 'a', duration: 60, kind: 'ad' }, { url: 'b', duration: 30, kind: 'ad' }, { url: 'f', duration: 5400 }],
    ...extra,
  })
  const at = (s: ShowingInstance[], ms: number) => showingSign(screenStateAt(s, ms))

  it('counts down to the next showing in minutes and seconds within the hour', () => {
    expect(at([film()], T - 754_000)).toBe('Next: Film\nin 12:34')
    expect(at([film()], T - 500)).toBe('Next: Film\nin 0:01')
  })

  it('in hours and minutes within the day, and days beyond', () => {
    expect(at([film()], T - (3 * 3600 + 5 * 60) * 1000)).toBe('Next: Film\nin 3 h 05 min')
    expect(at([film()], T - 30 * 3600 * 1000)).toBe('Next: Film\nin 1 day')
    expect(at([film()], T - 50 * 3600 * 1000)).toBe('Next: Film\nin 2 days')
  })

  it('an untitled showing is "Next showing"', () => {
    expect(at([film({ title: undefined })], T - 60_000)).toBe('Next showing\nin 1:00')
    expect(at([film({ title: '  ' })], T - 60_000)).toBe('Next showing\nin 1:00')
  })

  it('nothing scheduled: no sign', () => {
    expect(at([], T)).toBeNull()
  })

  it('during the ads before the feature, counts down to the feature', () => {
    expect(at([film()], T + 10_000)).toBe('Film starts in 1:20')
    expect(at([film()], T + 75_000)).toBe('Film starts in 0:15')
    expect(at([film({ title: undefined })], T + 75_000)).toBe('The film starts in 0:15')
  })

  it('names the film for its first 15 seconds, then leaves the picture clear', () => {
    expect(at([film()], T + 90_000)).toBe('Now showing: Film')
    expect(at([film()], T + 104_000)).toBe('Now showing: Film')
    expect(at([film()], T + 105_000)).toBeNull()
    expect(at([film({ title: undefined })], T + 91_000)).toBeNull()
  })

  it('a programme of only ads shows no countdown to a feature', () => {
    expect(at([film({ items: [{ url: 'a', duration: 60, kind: 'ad' }] })], T + 10_000)).toBeNull()
  })
})
