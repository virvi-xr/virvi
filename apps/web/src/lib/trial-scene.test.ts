import { describe, expect, it } from 'vitest'
import { importLimitNote, importMaxBytes, offTypeLocked, pairChoices, sceneListActions, sceneLockRequest, sceneTabLocked, TRIAL_SCENE_NOTE, TRIAL_SCENE_TABS } from './trial-scene'

describe('sceneTabLocked', () => {
  it('opens the name, presets and elements (and the trial element types) for a trial', () => {
    for (const t of ['name', 'presets', 'elements', 'model', 'image', 'video', 'sound']) expect(sceneTabLocked(t, true)).toBe(false)
  })
  it('locks everything account-only for a trial', () => {
    for (const t of ['roles', 'collaborators', 'destinations', 'hyperfy', 'streams', 'showings', 'schedules', 'ar',
      'widget', 'ad_space', 'ads', 'moderation', 'settings', 'realtime', 'media-names', 'room-set', 'something-new']) {
      expect(sceneTabLocked(t, true)).toBe(true)
    }
  })
  it('never locks anything for an account', () => {
    for (const t of ['name', 'roles', 'collaborators', 'destinations', 'hyperfy', 'streams', 'showings', 'schedules', 'ar', 'widget', 'settings']) {
      expect(sceneTabLocked(t, false)).toBe(false)
    }
  })
  it('lists the open tabs', () => {
    expect([...TRIAL_SCENE_TABS]).toEqual(expect.arrayContaining(['name', 'presets', 'elements']))
  })
})

describe('sceneLockRequest', () => {
  it('opens the sheet with a nav action and the label', () => {
    expect(sceneLockRequest('roles', 'Roles')).toEqual({ action: 'nav:scene/roles', ctx: { label: 'Roles' } })
  })
})

describe('offTypeLocked', () => {
  it('locks ads and scheduled showings for a trial only', () => {
    expect([0, 1, 2, 4, 5, 6].filter((v) => offTypeLocked(v, true))).toEqual([4, 5, 6])
    expect([0, 1, 2, 4, 5, 6].filter((v) => offTypeLocked(v, false))).toEqual([])
  })
})

describe('pairChoices', () => {
  it('is personal only for a trial', () => {
    expect(pairChoices(true)).toEqual(['personal'])
    expect(pairChoices(false)).toEqual(['personal', 'shared'])
  })
})

describe('importLimitNote', () => {
  it('names the trial limits', () => {
    expect(importLimitNote(true)).toBe('Guests can import 2 scenes of up to 25 MB. Create a free account for more.')
    expect(importLimitNote(false)).toBeNull()
  })
})

describe('importMaxBytes', () => {
  it('is 25 MB for a trial and the account cap otherwise', () => {
    expect(importMaxBytes(true, 200 * 1024 * 1024)).toBe(26214400)
    expect(importMaxBytes(false, 200 * 1024 * 1024)).toBe(200 * 1024 * 1024)
    expect(importMaxBytes(true, 10)).toBe(10)
  })
})

describe('scenes list', () => {
  it('offers a trial New scene and Import, no blank scene', () => {
    expect(sceneListActions(true)).toEqual(['import', 'new'])
    expect(sceneListActions(false)).toEqual(['blank', 'import', 'new'])
  })
  it('says the scene is held for the trial', () => {
    expect(TRIAL_SCENE_NOTE).toBe('Held for your trial — create an account to keep it')
  })
})
