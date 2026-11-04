import { describe, it, expect } from 'vitest'
import { applyPresetsChange, copyName, friendlyPresetError, presetLabel, presetsFromScene, PRESET_NAME_MAX } from '../src/presets.js'

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
