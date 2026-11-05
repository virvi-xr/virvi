import { describe, it, expect } from 'vitest'
import { applyPresetsChange, copyName, friendlyPresetError, nextSwitchFrom, nextSwitchText, presetLabel, presetsFromScene, PRESET_NAME_MAX } from '../src/presets.js'

const http = (status: number, body = '{"error":"x"}') => new Error(`HTTP ${status}: ${body}`)

describe('presetsFromScene', () => {
  it('keeps id and name, and which one is live', () => {
    const scene = { activePresetId: 'b', presets: [{ id: 'a', name: 'Day', elements: [1, 2] }, { id: 'b', name: 'Concert', elements: [] }] }
    expect(presetsFromScene(scene)).toEqual({ activeId: 'b', list: [{ id: 'a', name: 'Day' }, { id: 'b', name: 'Concert' }] })
  })
})

describe('applyPresetsChange', () => {
  it('adds, renames and removes presets from the room message', () => {
    let list = [{ id: 'a', name: 'Day' }]
    list = applyPresetsChange(list, { action: 'upsert', preset: { id: 'b', name: 'Concert' } })
    list = applyPresetsChange(list, { action: 'upsert', preset: { id: 'b', name: 'Gig' } })
    expect(list).toEqual([{ id: 'a', name: 'Day' }, { id: 'b', name: 'Gig' }])
    expect(applyPresetsChange(list, { action: 'delete', presetId: 'a' })).toEqual([{ id: 'b', name: 'Gig' }])
  })
})

describe('copyName and presetLabel', () => {
  it('match the dashboard', () => {
    expect(copyName('Concert', ['Concert'])).toBe('Copy of Concert')
    expect(copyName('Concert', ['Copy of Concert'])).toBe('Copy of Concert (2)')
    expect(copyName('x'.repeat(80), []).length).toBeLessThanOrEqual(PRESET_NAME_MAX)
    expect(presetLabel('booking:abc')).toBe('Booking copy')
  })
})

describe('friendlyPresetError', () => {
  it('uses the server message when there is one, else the edit wording', () => {
    expect(friendlyPresetError(http(400, '{"error":"bad_name","message":"A preset name is required (up to 60 characters)"}'))).toBe('A preset name is required (up to 60 characters)')
    expect(friendlyPresetError(http(403))).toBe("You don't have permission to edit this scene.")
    expect(friendlyPresetError(http(426))).toBe('This scene needs a redeploy to edit')
  })
})

describe('next switch (LIV-86)', () => {
  const presets = [{ id: 'p1', name: 'Day' }, { id: 'p2', name: 'Concert' }]
  const now = Date.parse('2026-11-06T18:00:00Z')

  it('reads the next switch and whether it is a run that can be skipped', () => {
    const res = {
      schedules: [{ id: 's1', presetId: 'p2', nextRuns: ['2026-11-06T20:05:00.000Z', '2026-11-13T20:05:00.000Z'] }],
      status: { nextSwitch: { at: '2026-11-06T20:05:00.000Z', presetId: 'p2', scheduleId: 's1' } },
    }
    expect(nextSwitchFrom(res)).toEqual({ at: '2026-11-06T20:05:00.000Z', presetId: 'p2', scheduleId: 's1', skippable: true })
    // The end of a run in progress switches back: that isn't a run to skip
    const ending = { ...res, status: { nextSwitch: { at: '2026-11-06T23:00:00.000Z', presetId: 'p1', scheduleId: 's1' } } }
    expect(nextSwitchFrom(ending)?.skippable).toBe(false)
    expect(nextSwitchFrom({ schedules: [], status: { nextSwitch: null } })).toBeNull()
    expect(nextSwitchFrom(null)).toBeNull()
  })

  it('says it in words, counting down', () => {
    const at = (iso: string, presetId: string | null = 'p2') => ({ at: iso, presetId, scheduleId: 's1', skippable: true })
    expect(nextSwitchText(at('2026-11-06T20:05:00Z'), presets, now)).toBe('Next switch: Concert in 2 h 05 min')
    expect(nextSwitchText(at('2026-11-06T18:40:00Z'), presets, now)).toBe('Next switch: Concert in 40 min')
    expect(nextSwitchText(at('2026-11-06T18:00:30Z'), presets, now)).toBe('Next switch: Concert in under a minute')
    expect(nextSwitchText(at('2026-11-08T18:00:00Z'), presets, now)).toBe('Next switch: Concert in 2 days')
    expect(nextSwitchText(at('2026-11-07T19:00:00Z'), presets, now)).toBe('Next switch: Concert in 1 day')
    expect(nextSwitchText(at('2026-11-06T19:00:00Z', null), presets, now)).toBe('Next switch: back to the previous preset in 1 h 00 min')
    expect(nextSwitchText(at('2026-11-06T17:00:00Z'), presets, now)).toBe('Next switch: Concert now')
  })
})
