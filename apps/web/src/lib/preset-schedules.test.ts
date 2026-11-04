import { describe, expect, it } from 'vitest'
import { describeSchedule, formatRunTime, formToBody, liveStatusText, localDate, runLabel, timezoneOptions, weekGrid, type ScheduleForm } from './preset-schedules'

const form = (v: Partial<ScheduleForm> = {}): ScheduleForm => ({
  presetId: 'p1', recurrence: 'weekly', weekdays: [5], startDate: '2026-11-06', startTime: '20:00',
  hasEnd: true, durationMinutes: 180, timezone: 'Europe/London', returnToPresetId: '', ...v,
})

describe('describeSchedule', () => {
  it('reads like a sentence', () => {
    expect(describeSchedule({ recurrence: 'weekly', weekdays: [5, 6], startDate: '2026-11-06', startTime: '20:00', durationMinutes: 180, timezone: 'Europe/London' }))
      .toBe('Fridays and Saturdays at 20:00 for 3 h (Europe/London)')
    expect(describeSchedule({ recurrence: 'daily', weekdays: [], startDate: '2026-11-06', startTime: '19:00', durationMinutes: 90, timezone: 'UTC' }))
      .toBe('Every day at 19:00 for 1 h 30 min (UTC)')
    expect(describeSchedule({ recurrence: 'once', weekdays: [], startDate: '2026-11-06', startTime: '19:00', durationMinutes: null, timezone: 'UTC' }))
      .toBe('Once on 2026-11-06 at 19:00, until the next switch (UTC)')
  })
})

describe('formatRunTime', () => {
  it("shows the run in the schedule's timezone, and the viewer's when that differs", () => {
    expect(formatRunTime('2026-11-06T20:00:00.000Z', 'Europe/London', 'Europe/London')).toBe('Fri, Nov 6, 20:00')
    expect(formatRunTime('2026-11-06T20:00:00.000Z', 'Europe/London', 'America/New_York')).toBe('Fri, Nov 6, 20:00 (Fri, Nov 6, 15:00 your time)')
  })
})

describe('formToBody', () => {
  it('sends only what the repeat needs, and null for no end or no return preset', () => {
    expect(formToBody(form())).toEqual({ presetId: 'p1', recurrence: 'weekly', weekdays: [5], startDate: '2026-11-06', startTime: '20:00', durationMinutes: 180, timezone: 'Europe/London', returnToPresetId: null })
    expect(formToBody(form({ recurrence: 'daily', hasEnd: false, returnToPresetId: 'p2' }))).toMatchObject({ weekdays: [], durationMinutes: null, returnToPresetId: 'p2' })
  })
})

describe('runLabel', () => {
  it('says what happened to a run', () => {
    expect(runLabel({ status: 'active', outcome: null })).toBe('Live now')
    expect(runLabel({ status: 'held', outcome: 'held for a booking' })).toBe('Waiting for a booking to end')
    expect(runLabel({ status: 'overridden', outcome: 'switched manually' })).toBe('Switched manually')
    expect(runLabel({ status: 'skipped', outcome: 'x' })).toBe('Missed (the server was offline)')
    expect(runLabel({ status: 'ended', outcome: 'finished' })).toBe('Finished')
    expect(runLabel({ status: 'ended', outcome: 'paused' })).toBe('Ended: paused')
  })
})

describe('liveStatusText', () => {
  const names = (id: string | null) => (id === 'p1' ? 'Concert' : id === 'p2' ? 'Day' : null)
  const tz = 'UTC'

  it('says nothing when nothing is scheduled', () => {
    expect(liveStatusText({ reason: { kind: 'none' }, nextSwitch: null }, names, tz)).toEqual({ why: null, next: null })
  })

  it('a schedule in progress shows when it ends and what comes back', () => {
    expect(liveStatusText({
      reason: { kind: 'schedule', scheduleId: 's1', until: '2026-11-06T23:00:00.000Z' },
      nextSwitch: { at: '2026-11-06T23:00:00.000Z', presetId: 'p2', scheduleId: 's1' },
    }, names, tz)).toEqual({ why: 'Scheduled until Fri, Nov 6, 23:00', next: 'Next switch: Day at Fri, Nov 6, 23:00' })
  })

  it('an open-ended schedule, a booking and a manual switch', () => {
    expect(liveStatusText({ reason: { kind: 'schedule', scheduleId: 's1', until: null }, nextSwitch: null }, names, tz).why).toBe('Scheduled, until the next switch')
    expect(liveStatusText({ reason: { kind: 'booking', title: 'Show', until: '2026-11-06T21:30:00.000Z' }, nextSwitch: null }, names, tz).why).toBe('Booking: Show, until Fri, Nov 6, 21:30')
    expect(liveStatusText({
      reason: { kind: 'manual' },
      nextSwitch: { at: '2026-11-07T20:00:00.000Z', presetId: 'p1', scheduleId: 's1' },
    }, names, tz)).toEqual({ why: 'Switched manually; the schedule resumes Sat, Nov 7, 20:00', next: 'Next switch: Concert at Sat, Nov 7, 20:00' })
  })

  it('a return to a deleted preset reads as the previous one', () => {
    expect(liveStatusText({ reason: { kind: 'none' }, nextSwitch: { at: '2026-11-07T20:00:00.000Z', presetId: null, scheduleId: 's1' } }, names, tz).next)
      .toBe('Next switch: back to the previous preset at Sat, Nov 7, 20:00')
  })
})

describe('weekGrid', () => {
  const now = new Date('2026-11-06T12:00:00Z') // a Friday
  const occ = (start: string, end: string | null, presetId = 'p1') => ({ scheduleId: 's1', presetId, start, end })

  it('seven days from today in the viewer timezone, each with its runs placed by local time', () => {
    const days = weekGrid([occ('2026-11-06T20:00:00Z', '2026-11-06T23:00:00Z')], 'UTC', now)
    expect(days.map((d) => d.label)).toEqual(['Fri 6', 'Sat 7', 'Sun 8', 'Mon 9', 'Tue 10', 'Wed 11', 'Thu 12'])
    expect(days[0].blocks).toEqual([{ scheduleId: 's1', presetId: 'p1', top: (20 / 24) * 100, height: (3 / 24) * 100, time: '20:00–23:00' }])
    expect(days.slice(1).every((d) => d.blocks.length === 0)).toBe(true)
  })

  it('a run past midnight carries into the next day', () => {
    const days = weekGrid([occ('2026-11-06T22:00:00Z', '2026-11-07T02:00:00Z')], 'UTC', now)
    expect(days[0].blocks[0]).toMatchObject({ top: (22 / 24) * 100, height: (2 / 24) * 100, time: '22:00–02:00' })
    expect(days[1].blocks[0]).toMatchObject({ top: 0, height: (2 / 24) * 100, time: '22:00–02:00' })
  })

  it('an open-ended run lasts until the next run starts', () => {
    const days = weekGrid([occ('2026-11-06T20:00:00Z', null), occ('2026-11-07T08:00:00Z', '2026-11-07T09:00:00Z', 'p2')], 'UTC', now)
    expect(days[0].blocks[0]).toMatchObject({ height: (4 / 24) * 100, time: '20:00 →' })
    expect(days[1].blocks.map((b) => [b.presetId, b.top, b.height])).toEqual([['p1', 0, (8 / 24) * 100], ['p2', (8 / 24) * 100, (1 / 24) * 100]])
  })

  it('uses the viewer timezone for days and times', () => {
    const days = weekGrid([occ('2026-11-07T01:00:00Z', '2026-11-07T02:00:00Z')], 'America/New_York', now)
    expect(days[0].label).toBe('Fri 6')
    expect(days[0].blocks[0]).toMatchObject({ top: (20 / 24) * 100, time: '20:00–21:00' })
  })
})

describe('form defaults', () => {
  it('today is the local date, not the UTC one', () => {
    // 21:30 on 6 Nov in a UTC-5 browser is already 7 Nov in UTC
    const evening = new Date(2026, 10, 6, 21, 30)
    expect(localDate(evening)).toBe('2026-11-06')
  })
  it('the timezone list always holds the current value (UTC and aliases are missing from some browsers)', () => {
    const list = timezoneOptions('Asia/Calcutta')
    expect(list[0]).toBe('Asia/Calcutta')
    expect(timezoneOptions('UTC')).toContain('UTC')
    expect(new Set(timezoneOptions('Europe/London')).size).toBe(timezoneOptions('Europe/London').length)
  })
})
