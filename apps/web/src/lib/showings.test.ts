import { describe, it, expect } from 'vitest'
import { describeShowing, formToShowingBody, showingToForm, parseLength, previewAt, programmeLength, programmeProblem, type ShowingForm } from './showings'

const form = (extra: Partial<ShowingForm> = {}): ShowingForm => ({
  title: ' Night of the Living Dead ', description: '', posterUrl: '',
  items: [{ url: 'https://cdn/reel.mp4', kind: 'ad', length: '10:00' }, { url: 'https://cdn/film.mp4', kind: 'video', length: '' }],
  recurrence: 'weekly', weekdays: [5, 1], startDate: '2026-11-06', startTime: '19:00', timezone: 'America/New_York', enabled: true, ...extra,
})

describe('parseLength', () => {
  it('reads h:mm:ss, m:ss and plain minutes', () => {
    expect(parseLength('1:30:00')).toBe(5400)
    expect(parseLength('12:34')).toBe(754)
    expect(parseLength('90')).toBe(5400)
    expect(parseLength(' 2:05 ')).toBe(125)
  })
  it('is null for blank or nonsense', () => {
    expect(parseLength('')).toBeNull()
    expect(parseLength('abc')).toBeNull()
    expect(parseLength('1:75')).toBeNull()
    expect(parseLength('0')).toBeNull()
  })
})

describe('formToShowingBody', () => {
  it('trims text, sends lengths in seconds (none when blank) and sorted weekdays', () => {
    expect(formToShowingBody(form())).toEqual({
      title: 'Night of the Living Dead', description: null, posterUrl: null,
      items: [{ url: 'https://cdn/reel.mp4', kind: 'ad', duration: 600 }, { url: 'https://cdn/film.mp4', kind: 'video' }],
      recurrence: 'weekly', weekdays: [1, 5], startDate: '2026-11-06', startTime: '19:00', timezone: 'America/New_York', enabled: true,
    })
  })
  it('drops weekdays unless weekly', () => {
    expect(formToShowingBody(form({ recurrence: 'daily' })).weekdays).toEqual([])
  })
})

describe('programmeProblem', () => {
  it('needs a video, and an ad may not end the showing', () => {
    expect(programmeProblem([])).toBe('Add at least one video.')
    expect(programmeProblem([{ url: 'a', kind: 'video', length: '' }, { url: 'b', kind: 'ad', length: '1:00' }])).toBe('Ads play before the feature: end the showing with a video.')
    expect(programmeProblem(form().items)).toBeNull()
  })
  it('flags a length it cannot read', () => {
    expect(programmeProblem([{ url: 'a', kind: 'video', length: 'soon' }])).toBe('"soon" isn\'t a length: use h:mm:ss, m:ss or minutes.')
  })
})

describe('showing wording', () => {
  const items = [{ url: 'https://cdn/reel.mp4', duration: 600, kind: 'ad' as const }, { url: 'https://cdn/Night.mp4', duration: 5400, kind: 'video' as const }]
  it('describes when it runs and for how long', () => {
    expect(describeShowing({ recurrence: 'weekly', weekdays: [5, 6], startDate: '2026-11-06', startTime: '19:00', timezone: 'America/New_York', items }))
      .toBe('Fridays and Saturdays at 19:00 (America/New_York) · 1:40:00')
    expect(describeShowing({ recurrence: 'once', weekdays: [], startDate: '2026-11-13', startTime: '20:00', timezone: 'UTC', items }))
      .toBe('Once on 2026-11-13 at 20:00 (UTC) · 1:40:00')
    expect(programmeLength(items)).toBe(6000)
  })
  it('previews where the screen will be some minutes in', () => {
    const name = (u: string) => u.split('/').pop()!
    expect(previewAt(items, 14 * 60 + 2, name)).toBe('14:02 into the showing: 4:02 into Night.mp4')
    expect(previewAt(items, 0, name)).toBe('0:00 into the showing: 0:00 into reel.mp4 (ad)')
    expect(previewAt(items, 6000, name)).toBe('The showing has ended by then.')
  })
})

describe('showingToForm', () => {
  it('leaves a sub-second length blank, so the form can still be saved', () => {
    const f = showingToForm({ id: 's', elementId: 'e', title: null, description: null, posterUrl: null, recurrence: 'daily', startDate: '2026-11-06', startTime: '19:00', weekdays: [], timezone: 'UTC', enabled: true, lengthSeconds: 0.4, nextStarts: [],
      items: [{ url: 'https://cdn/blip.mp4', duration: 0.4, kind: 'video' }, { url: 'https://cdn/film.mp4', duration: 5400.4, kind: 'video' }] })
    expect(f.items.map((i) => i.length)).toEqual(['', '1:30:00'])
    expect(programmeProblem(f.items)).toBeNull()
  })
})
