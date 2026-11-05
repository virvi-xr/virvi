import { describe, it, expect } from 'vitest'
import { showNow, showControlMessage, copiedMessage, copyDayChoices, copyResultMessage, copyShowingBody, copyToDaysBodies, nextWeekBodies, thisWeek, copyTargets, describeShowing, duplicateShowingForm, formToShowingBody, showingToForm, parseLength, previewAt, programmeLength, programmeProblem, type Showing, type ShowingForm } from './showings'

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

describe('duplicateShowingForm', () => {
  const saved = (extra: Partial<Showing> = {}): Showing => ({
    id: 's1', elementId: 'v1', title: 'Film', description: 'd', posterUrl: null,
    items: [{ url: 'https://cdn/reel.mp4', duration: 600, kind: 'ad' }, { url: 'https://cdn/film.mp4', duration: 5520, kind: 'video' }],
    recurrence: 'weekly', weekdays: [5, 6], startDate: '2026-11-06', startTime: '19:00', timezone: 'America/New_York',
    enabled: true, lengthSeconds: 6120, nextStarts: [], ...extra,
  })

  it('is the next screening: the same programme, starting when this one ends, on the next 5 minutes', () => {
    // 19:00 + 1:42:00 = 20:42 → 20:45
    const f = duplicateShowingForm(saved())
    expect(f).toMatchObject({ title: 'Film', description: 'd', recurrence: 'weekly', weekdays: [5, 6], startDate: '2026-11-06', startTime: '20:45', timezone: 'America/New_York', enabled: true })
    expect(f.items).toEqual(showingToForm(saved()).items)
  })

  it('an end on the 5 minutes starts right then', () => {
    expect(duplicateShowingForm(saved({ startTime: '19:03' })).startTime).toBe('20:45')
    expect(duplicateShowingForm(saved({ startTime: '19:08' })).startTime).toBe('20:50')
  })

  it('past midnight, a one-off moves to the next day and weekly days move on one', () => {
    expect(duplicateShowingForm(saved({ recurrence: 'once', startDate: '2026-12-31', startTime: '23:00' }))).toMatchObject({ startDate: '2027-01-01', startTime: '00:45' })
    expect(duplicateShowingForm(saved({ startTime: '23:00' }))).toMatchObject({ weekdays: [6, 0], startTime: '00:45' })
    expect(duplicateShowingForm(saved({ recurrence: 'daily', startTime: '23:00' }))).toMatchObject({ recurrence: 'daily', startTime: '00:45' })
  })
})

describe('copy to another screen', () => {
  const showing: Showing = {
    id: 'sh1', elementId: 'v1', title: 'Night of the Living Dead', description: null, posterUrl: 'https://cdn/poster.jpg',
    items: [{ url: 'https://cdn/reel.mp4', duration: 90.5, kind: 'ad' }, { url: 'https://elsewhere/film.mp4', duration: 5754.25, kind: 'video' }],
    recurrence: 'weekly', startDate: '2026-11-06', startTime: '19:00', weekdays: [5, 6], timezone: 'America/New_York', enabled: false,
    lengthSeconds: 5844.75, nextStarts: [],
  }

  it('sends the same showing with its exact lengths, so videos from elsewhere keep theirs', () => {
    expect(copyShowingBody(showing)).toEqual({
      title: 'Night of the Living Dead', description: null, posterUrl: 'https://cdn/poster.jpg',
      items: [{ url: 'https://cdn/reel.mp4', kind: 'ad', duration: 90.5 }, { url: 'https://elsewhere/film.mp4', kind: 'video', duration: 5754.25 }],
      recurrence: 'weekly', weekdays: [5, 6], startDate: '2026-11-06', startTime: '19:00', timezone: 'America/New_York', enabled: false,
    })
  })

  it('leaves out an unknown length rather than sending 0', () => {
    expect(copyShowingBody({ ...showing, items: [{ url: 'https://cdn/film.mp4', duration: 0, kind: 'video' }] }).items).toEqual([{ url: 'https://cdn/film.mp4', kind: 'video' }])
  })

  it('offers the other video screens, saying which are not in Schedule mode', () => {
    const screens = [
      { id: 'v1', type: 'video', name: 'Main', properties: { offType: 6 } },
      { id: 'v2', type: 'video', name: 'Lobby', properties: { offType: 6 } },
      { id: 'v3', type: 'video', name: '', properties: { offType: 0 } },
      { id: 'i1', type: 'image', name: 'Poster', properties: {} },
    ]
    expect(copyTargets(screens, 'v1')).toEqual([
      { id: 'v2', name: 'Lobby', scheduled: true, label: 'Lobby' },
      { id: 'v3', name: 'Video screen', scheduled: false, label: 'Video screen (not in Schedule mode)' },
    ])
  })

  it('says where it went, and when a screen needs switching to Schedule mode', () => {
    expect(copiedMessage(showing, { name: 'Lobby', scheduled: true })).toBe('Copied Night of the Living Dead to Lobby.')
    expect(copiedMessage({ ...showing, title: null }, { name: 'Side', scheduled: false }))
      .toBe('Copied Untitled showing to Side. It plays there once Side is set to Scheduled showings.')
  })
})

describe('copy to other days and to next week', () => {
  const base: Showing = {
    id: 'sh1', elementId: 'v1', title: 'Matinee', description: null, posterUrl: null,
    items: [{ url: 'https://cdn/film.mp4', duration: 5400, kind: 'video' }],
    recurrence: 'once', startDate: '2026-11-06', startTime: '14:00', weekdays: [], timezone: 'America/New_York', enabled: true,
    lengthSeconds: 5400, nextStarts: [],
  }

  it('offers the days a showing is not already on; a daily one has none', () => {
    expect(copyDayChoices(base)).toEqual([0, 1, 2, 3, 4, 6]) // 2026-11-06 is a Friday
    expect(copyDayChoices({ ...base, recurrence: 'weekly', weekdays: [5, 6] })).toEqual([0, 1, 2, 3, 4])
    expect(copyDayChoices({ ...base, recurrence: 'daily' })).toEqual([])
  })

  it('a one-off goes to the next of each chosen day after its date, same time', () => {
    const bodies = copyToDaysBodies(base, [6, 1])
    expect(bodies.map((b) => [b.recurrence, b.startDate, b.startTime, b.weekdays])).toEqual([
      ['once', '2026-11-09', '14:00', []],
      ['once', '2026-11-07', '14:00', []],
    ].sort((a, b) => String(a[1]).localeCompare(String(b[1]))))
    expect(bodies[0].items).toEqual([{ url: 'https://cdn/film.mp4', kind: 'video', duration: 5400 }])
  })

  it('a weekly one becomes one more weekly showing on the chosen days, leaving out days it is already on', () => {
    const weekly = { ...base, recurrence: 'weekly' as const, weekdays: [5] }
    expect(copyToDaysBodies(weekly, [3, 1, 5]).map((b) => [b.recurrence, b.weekdays, b.startDate])).toEqual([['weekly', [1, 3], '2026-11-06']])
    expect(copyToDaysBodies(weekly, [5])).toEqual([])
    expect(copyToDaysBodies({ ...base, recurrence: 'daily' }, [1])).toEqual([])
  })

  it('this week runs Sunday to Saturday around the given day', () => {
    expect(thisWeek('2026-11-05')).toEqual({ start: '2026-11-01', end: '2026-11-07' })
    expect(thisWeek('2026-11-01')).toEqual({ start: '2026-11-01', end: '2026-11-07' })
    expect(thisWeek('2026-11-07')).toEqual({ start: '2026-11-01', end: '2026-11-07' })
    expect(thisWeek('2026-12-31')).toEqual({ start: '2026-12-27', end: '2027-01-02' })
  })

  it("copies this week's one-off showings 7 days on; repeating and other weeks' ones stay put", () => {
    const list: Showing[] = [
      { ...base, id: 'a', startDate: '2026-11-01' },
      { ...base, id: 'b', startDate: '2026-11-07', title: 'Late' },
      { ...base, id: 'c', startDate: '2026-11-08' },
      { ...base, id: 'd', startDate: '2026-10-31' },
      { ...base, id: 'e', recurrence: 'weekly', weekdays: [2] },
    ]
    expect(nextWeekBodies(list, '2026-11-05').map((b) => [b.title, b.startDate])).toEqual([['Matinee', '2026-11-08'], ['Late', '2026-11-14']])
  })

  it('says how many were copied and which clashed', () => {
    expect(copyResultMessage(2, [])).toBe('Copied 2 showings.')
    expect(copyResultMessage(1, [])).toBe('Copied 1 showing.')
    expect(copyResultMessage(1, ['Matinee on 2026-11-09'])).toBe("Copied 1 showing. Not copied, because it clashes with a showing already there: Matinee on 2026-11-09.")
    expect(copyResultMessage(0, ['A on 2026-11-08', 'B on 2026-11-14'])).toBe("Copied 0 showings. Not copied, because they clash with showings already there: A on 2026-11-08 and B on 2026-11-14.")
  })
})

describe('host controls', () => {
  const NOW = Date.parse('2026-11-05T19:30:00Z')
  const at = (ms: number) => new Date(ms).toISOString()
  const s = (upcoming: Showing['upcoming']): Pick<Showing, 'enabled' | 'upcoming'> => ({ enabled: true, upcoming })

  it('finds the show on now and the next one that has not started', () => {
    expect(showNow(s([
      { startsAt: at(NOW - 600_000), lengthSeconds: 6000 },
      { startsAt: at(NOW + 86_400_000), lengthSeconds: 6000 },
    ]), NOW)).toEqual({ on: { endsAt: at(NOW - 600_000 + 6_000_000) }, next: at(NOW + 86_400_000) })
    expect(showNow(s([{ startsAt: at(NOW + 60_000), lengthSeconds: 60 }]), NOW)).toEqual({ on: null, next: at(NOW + 60_000) })
  })

  it('a paused showing, or one from an older server without upcoming, has no controls', () => {
    expect(showNow({ enabled: false, upcoming: [{ startsAt: at(NOW), lengthSeconds: 60 }] }, NOW)).toEqual({ on: null, next: null })
    expect(showNow({ enabled: true }, NOW)).toEqual({ on: null, next: null })
  })

  it('says what each control did', () => {
    expect(showControlMessage('delay', 'Matinee')).toBe('Matinee: the next show starts 5 minutes later.')
    expect(showControlMessage('end', null)).toBe('Untitled showing: ended. The screen goes back to its holding image.')
    expect(showControlMessage('play-now', 'Matinee')).toBe('Matinee: playing now for everyone in the scene.')
  })
})
