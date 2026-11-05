import { describe, expect, it } from 'vitest'
import { eventShowingLabel, eventShowingsFor, eventPresetLabel, eventPresetsFor } from './event-presets'

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

describe('showings that follow the event (LIV-87)', () => {
  const rows = [
    { id: 'a', sceneId: 's1', elementId: 'e1', screenName: 'Big screen', title: 'Film', enabled: true },
    { id: 'b', sceneId: 's2', elementId: 'e2', screenName: null, title: null, enabled: false },
  ]
  it("lists one scene's showings, naming the film and its screen", () => {
    expect(eventShowingsFor('s1', rows).map(eventShowingLabel)).toEqual(['Film on Big screen'])
    expect(eventShowingsFor('s2', rows).map(eventShowingLabel)).toEqual(['Untitled showing on Video screen (paused: the event needs a start time)'])
    expect(eventShowingsFor('s3', undefined)).toEqual([])
  })
})
