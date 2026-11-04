import { describe, expect, it } from 'vitest'
import { describeSchedule, formatRunTime, formToBody, liveStatusText, runLabel, type ScheduleForm } from './preset-schedules'

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
