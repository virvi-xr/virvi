import { describe, expect, it } from 'vitest'
import { applyPresetsChange, copyName, editingPreset, presetDisplayName } from './presets'

const scene = (active: string | null, ...names: [string, string][]) => ({
  activePresetId: active,
  presets: names.map(([id, name]) => ({ id, name, elements: [] as unknown[] })),
})

describe('editingPreset', () => {
  it('edits the chosen preset, else the live one, never just the first', () => {
    const s = scene('b', ['a', 'Default'], ['b', 'Concert'])
    expect(editingPreset(s, null)?.id).toBe('b')
    expect(editingPreset(s, 'a')?.id).toBe('a')
  })
  it('falls back to the live one when the choice is gone, and to the first only with no live preset', () => {
    expect(editingPreset(scene('b', ['a', 'A'], ['b', 'B']), 'gone')?.id).toBe('b')
    expect(editingPreset(scene(null, ['a', 'A'], ['b', 'B']), null)?.id).toBe('a')
    expect(editingPreset(scene(null), null)).toBeUndefined()
  })
})

describe('copyName', () => {
  it('names a copy, numbering it when the name is taken', () => {
    expect(copyName('Concert', ['Concert'])).toBe('Copy of Concert')
    expect(copyName('Concert', ['Concert', 'Copy of Concert'])).toBe('Copy of Concert (2)')
    expect(copyName('Concert', ['Copy of Concert', 'Copy of Concert (2)'])).toBe('Copy of Concert (3)')
  })
  it('stays within the 60-character limit', () => {
    expect(copyName('x'.repeat(60), []).length).toBeLessThanOrEqual(60)
  })
})

describe('presetDisplayName', () => {
  it('shows booking copies as such', () => {
    expect(presetDisplayName('booking:3f2a')).toBe('Booking copy')
    expect(presetDisplayName('Concert')).toBe('Concert')
  })
})

describe('applyPresetsChange', () => {
  it('adds a new preset with no elements yet, renames in place, and removes deleted ones', () => {
    const s = scene('a', ['a', 'Default'])
    const added = applyPresetsChange(s, { action: 'upsert', preset: { id: 'b', name: 'Concert' } })
    expect(added.presets.map((p) => [p.id, p.name, p.elements.length])).toEqual([['a', 'Default', 0], ['b', 'Concert', 0]])
    const renamed = applyPresetsChange(added, { action: 'upsert', preset: { id: 'b', name: 'Gig' } })
    expect(renamed.presets.map((p) => p.name)).toEqual(['Default', 'Gig'])
    expect(applyPresetsChange(renamed, { action: 'delete', presetId: 'b' }).presets.map((p) => p.id)).toEqual(['a'])
  })
})
