import { describe, it, expect } from 'vitest'
import { hudBehindNote, hudRedeployHere } from './hud-version'

describe('the scene page\'s out-of-date HUD warning', () => {
  it('names the versions when the scene is behind', () => {
    expect(hudBehindNote({ version: '2.14.0', latest: '2.15.0', seenAt: '', behind: true }))
      .toBe('This scene runs HUD 2.14.0 in Decentraland; the latest is 2.15.0. Redeploy it to give visitors the latest fixes and features.')
    expect(hudBehindNote({ version: null, latest: '2.15.0', seenAt: '', behind: true })).toContain('an older HUD')
  })
  it('says nothing when current, or when no HUD has called', () => {
    expect(hudBehindNote({ version: '2.15.0', latest: '2.15.0', seenAt: '', behind: false })).toBeNull()
    expect(hudBehindNote(null)).toBeNull()
    expect(hudBehindNote(undefined)).toBeNull()
  })
  it('a scene deployed from its creator\'s own project is told how to update it there, with no Redeploy (LIV-13)', () => {
    const own = { version: '2.14.0', latest: '2.15.0', seenAt: '', behind: true, virviDeploys: false }
    expect(hudBehindNote(own)).toBe('This scene runs HUD 2.14.0 in Decentraland; the latest is 2.15.0. To give visitors the latest fixes and features, run `npm install @virvixr/dcl@latest` in your scene\'s folder, then deploy it the way you usually do.')
    expect(hudRedeployHere(own)).toBe(false)
    expect(hudRedeployHere({ ...own, virviDeploys: true })).toBe(true)
    expect(hudRedeployHere({ version: '2.14.0', latest: '2.15.0', seenAt: '', behind: true })).toBe(true)
  })
})
