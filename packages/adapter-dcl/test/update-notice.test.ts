import { describe, it, expect } from 'vitest'
import { DCL_HUD_VERSION } from '@virvixr/shared'
import { hudUpdateNotice } from '../src/hud/update-notice'

describe('the in-world update notice for people who work on the scene (LIV-13)', () => {
  it('tells a host, co-host or editor on an older release to redeploy from the dashboard', () => {
    for (const role of ['host', 'cohost', 'editor']) {
      expect(hudUpdateNotice({ role, hudLatest: '2.22.0' }, '2.21.1'))
        .toBe('Virvi 2.22.0 is out (this scene runs 2.21.1). Redeploy it from the Virvi dashboard to update.')
    }
  })
  it('tells the owner of a scene they deploy themselves to update the package', () => {
    expect(hudUpdateNotice({ role: 'host', hudLatest: '2.22.0', virviDeploys: false }, '2.21.1'))
      .toBe("Virvi 2.22.0 is out (this scene runs 2.21.1). Run npm install @virvixr/dcl@latest in the scene's folder and deploy it.")
  })
  it('says nothing when current or newer, to viewers, or when the server sent no latest', () => {
    expect(hudUpdateNotice({ role: 'host', hudLatest: '2.21.1' }, '2.21.1')).toBeNull()
    expect(hudUpdateNotice({ role: 'host', hudLatest: '2.21.0' }, '2.21.1')).toBeNull()
    expect(hudUpdateNotice({ role: 'viewer', hudLatest: '2.22.0' }, '2.21.1')).toBeNull()
    expect(hudUpdateNotice({ role: 'host' }, '2.21.1')).toBeNull()
    expect(hudUpdateNotice({ role: 'host', hudLatest: 5 }, '2.21.1')).toBeNull()
  })
  it('compares against the release this package is', () => {
    expect(hudUpdateNotice({ role: 'host', hudLatest: DCL_HUD_VERSION })).toBeNull()
  })
})
