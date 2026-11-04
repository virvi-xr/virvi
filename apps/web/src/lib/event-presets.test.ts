import { describe, expect, it } from 'vitest'
import { eventPresetLabel, eventPresetsFor } from './event-presets'

describe('eventPresetsFor', () => {
  const schedules = [
    { id: 's1', sceneId: 'a', presetId: 'p1', presetName: 'Concert', enabled: true },
    { id: 's2', sceneId: 'b', presetId: 'p3', presetName: 'Night', enabled: true },
  ]
  const presets = [
    { id: 'p1', sceneId: 'a', name: 'Concert' }, { id: 'p2', sceneId: 'a', name: 'Day' }, { id: 'p3', sceneId: 'b', name: 'Night' },
  ]
  it('splits one scene into what is scheduled and what is left to choose', () => {
    expect(eventPresetsFor('a', schedules, presets)).toEqual({ scheduled: [schedules[0]], choices: [presets[1]] })
    expect(eventPresetsFor('c', schedules, presets)).toEqual({ scheduled: [], choices: [] })
    expect(eventPresetsFor('a')).toEqual({ scheduled: [], choices: [] })
  })
  it('says why a schedule is paused', () => {
    expect(eventPresetLabel({ presetName: 'Concert', enabled: true })).toBe('Concert')
    expect(eventPresetLabel({ presetName: 'Concert', enabled: false })).toBe('Concert (paused: the event needs a start and an end time)')
  })
})
