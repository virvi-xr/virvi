import { describe, expect, it } from 'vitest'
import { describeSchedule, formatRunTime, formToBody, runLabel, type ScheduleForm } from './preset-schedules'

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
