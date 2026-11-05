import { describe, it, expect } from 'vitest'
import { DELAY_STEP_MINUTES, showControlError, showControlNote, showingRow, showingsFromApi, timeLeft, type HUDShowing } from '../src/showings.js'
import { screensFromPreset } from '../src/streams.js'

const T = Date.parse('2026-11-05T20:00:00.000Z')
const show = (over: Partial<HUDShowing> = {}): HUDShowing => ({ id: 'sh1', title: 'Film', enabled: true, upcoming: [], ...over })

describe('screensFromPreset', () => {
  it('marks screens in Schedule mode (offType 6)', () => {
    const screens = screensFromPreset({ elements: [
      { id: 'v1', type: 'video', name: 'A', properties: { offType: 6 } },
      { id: 'v2', type: 'video', name: 'B', properties: { offType: 1 } },
    ] })
    expect(screens.map((s) => s.scheduled)).toEqual([true, false])
  })
})

describe('showingsFromApi', () => {
  it('reads ISO show times as ms and drops unreadable ones', () => {
    expect(showingsFromApi({ showings: [
      { id: 'a', title: null, enabled: false, upcoming: [{ startsAt: '2026-11-05T20:00:00.000Z', lengthSeconds: 600 }, { startsAt: 'nope', lengthSeconds: 5 }] },
      { id: 'b' },
    ] })).toEqual([
      { id: 'a', title: '', enabled: false, upcoming: [{ startsAt: T, lengthSeconds: 600 }] },
      { id: 'b', title: '', enabled: true, upcoming: [] },
    ])
    expect(showingsFromApi(null)).toEqual([])
  })
})

describe('timeLeft', () => {
  it('rounds up to whole minutes, then hours, then days', () => {
    expect(timeLeft(1)).toBe('1 min')
    expect(timeLeft(9 * 60_000)).toBe('9 min')
    expect(timeLeft(65 * 60_000)).toBe('1 h 05 min')
    expect(timeLeft(2 * 86_400_000)).toBe('2 days')
  })
})

describe('showingRow', () => {
  it('a show on now can be ended, and the next one delayed', () => {
    const s = show({ upcoming: [{ startsAt: T - 60_000, lengthSeconds: 600 }, { startsAt: T + 3_600_000, lengthSeconds: 600 }] })
    expect(showingRow(s, T)).toEqual({ id: 'sh1', title: 'Film', status: 'On now, 9 min left', canEnd: true, canPlay: false, canDelay: true })
  })
  it('between shows it can play now', () => {
    const s = show({ title: '', upcoming: [{ startsAt: T + 65 * 60_000, lengthSeconds: 600 }] })
    expect(showingRow(s, T)).toEqual({ id: 'sh1', title: 'Untitled showing', status: 'Next in 1 h 05 min', canEnd: false, canPlay: true, canDelay: true })
    expect(showingRow(show(), T).status).toBe('Nothing coming up')
    expect(showingRow(show(), T).canDelay).toBe(false)
  })
  it('a paused showing has no controls', () => {
    expect(showingRow(show({ enabled: false, upcoming: [{ startsAt: T - 1, lengthSeconds: 60 }] }), T))
      .toEqual({ id: 'sh1', title: 'Film', status: 'Paused on virvi.io', canEnd: false, canPlay: false, canDelay: false })
  })
})

describe('control wording', () => {
  it('says what happened', () => {
    expect(showControlNote('delay', 'Film')).toBe(`Film: the next show starts ${DELAY_STEP_MINUTES} min later`)
    expect(showControlNote('end', '')).toBe('Untitled showing: ended')
    expect(showControlNote('play-now', 'Film')).toBe('Film: playing now for everyone')
  })
  it("shows the server's own reason for a refusal", () => {
    const err = new Error('HTTP 409: {"error":"showing_overlap","message":"That would run into \\"Late\\", at 21:05."}')
    expect(showControlError(err)).toBe('That would run into "Late", at 21:05.')
    expect(showControlError(new Error('HTTP 400: {"error":"nothing_to_delay","message":"Nothing coming up to delay."}'))).toBe('Nothing coming up to delay.')
  })
  it('falls back to the usual edit wording', () => {
    expect(showControlError(new Error('HTTP 403: {"error":"Forbidden"}'))).toBe("You don't have permission to edit this scene.")
    expect(showControlError(new Error('HTTP 409: not json'))).toBe('Something went wrong — try again')
    expect(showControlError(new TypeError('fetch failed'))).toBe('Disconnected from Virvi. Reconnecting…')
  })
})
