import { describe, it, expect } from 'vitest'
import { landingRoute, signinPath } from './landing-route'

describe('signinPath', () => {
  it('builds the sign-in URL', () => {
    expect(signinPath()).toBe('/signin/')
    expect(signinPath('/x')).toBe('/signin/?next=%2Fx')
    expect(signinPath(null, 'register')).toBe('/signin/?mode=register')
    expect(signinPath('/x', 'register')).toBe('/signin/?next=%2Fx&mode=register')
  })
})

describe('landingRoute', () => {
  const base = { search: '', loading: false, signedIn: false, scenePass: false }

  it('forwards an old /?next= link to sign-in, even while loading', () => {
    expect(landingRoute({ ...base, search: '?next=%2Fanalytics%2F%3Fscene%3Dabc', loading: true })).toEqual({ go: '/signin/?next=%2Fanalytics%2F%3Fscene%3Dabc' })
  })

  it('ignores an unsafe next', () => {
    expect(landingRoute({ ...base, search: '?next=//evil.com' })).toBe('show')
  })

  it('waits while the session loads', () => {
    expect(landingRoute({ ...base, loading: true })).toBe('wait')
  })

  it('sends a signed-in user to their scenes', () => {
    expect(landingRoute({ ...base, signedIn: true })).toEqual({ go: '/scenes' })
  })

  it('shows the landing page to a scene pass visitor', () => {
    expect(landingRoute({ ...base, signedIn: true, scenePass: true })).toBe('show')
    // a trial visitor has no scenes to go to: the landing page (and its Try link) stays
    expect(landingRoute({ ...base, signedIn: true, trial: true })).toBe('show')
  })

  it('shows the landing page to a signed-out visitor', () => {
    expect(landingRoute(base)).toBe('show')
  })
})
