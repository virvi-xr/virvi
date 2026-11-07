import { describe, it, expect } from 'vitest'
import { readSession, scenePassAllows, tokenUserId, trialAllows } from './session'

const tok = (p: Record<string, unknown>) => `x.${Buffer.from(JSON.stringify(p)).toString('base64url')}.y`
const NOW = 1_800_000_000_000
const exp = NOW / 1000 + 600

describe('readSession', () => {
  it('drops kind-less and expired tokens', () => {
    expect(readSession(tok({ exp }), NOW)).toEqual({ ok: false })
    expect(readSession(tok({ exp: NOW / 1000 - 1, kind: 'account' }), NOW)).toEqual({ ok: false })
    expect(readSession('garbage', NOW)).toEqual({ ok: false })
  })
  it('account tokens have no scene pass; scene tokens do; a visitor pass is dropped', () => {
    expect(readSession(tok({ exp, kind: 'account' }), NOW)).toEqual({ ok: true, scenePass: null })
    expect(readSession(tok({ exp, kind: 'scene', sceneId: 's1', locationId: 'l1' }), NOW)).toEqual({ ok: true, scenePass: { sceneId: 's1', locationId: 'l1' } })
    expect(readSession(tok({ exp, kind: 'scene', sceneId: null }), NOW)).toEqual({ ok: false })
    // The studio scene's pass is a visitor pass too: never kept, never an account session.
    expect(readSession(tok({ exp, kind: 'scene', sceneId: null, locationId: null, via: 'studio' }), NOW)).toEqual({ ok: false })
  })
})

describe('scenePassAllows', () => {
  const pass = { sceneId: 's1', locationId: 'l1' }
  it('allows only its own scene analytics', () => {
    expect(scenePassAllows('/analytics/', '?scene=s1', pass)).toBe(true)
    expect(scenePassAllows('/analytics/', '?location=l1', pass)).toBe(true)
    expect(scenePassAllows('/analytics/', '?scene=s2', pass)).toBe(false)
    expect(scenePassAllows('/analytics/', '', pass)).toBe(false)
    expect(scenePassAllows('/analytics', '?scene=s1', pass)).toBe(true)
    expect(scenePassAllows('/analyticsfoo', '?scene=s1', pass)).toBe(false)
    expect(scenePassAllows('/analytics-admin/', '?scene=s1', pass)).toBe(false)
    expect(scenePassAllows('/scenes/', '', pass)).toBe(false)
    expect(scenePassAllows('/settings/', '', pass)).toBe(false)
  })
})

describe('trialAllows', () => {
  it('lets a trial open the Design Studio, its scenes, the wizard, imports and demos', () => {
    for (const p of ['/studio', '/studio/', '/studio/abc', '/scenes', '/scenes/', '/scenes/new', '/scenes/new/', '/scenes/abc', '/import', '/import/', '/demo/analytics', '/demo/events/']) {
      expect(trialAllows(p), p).toBe(true)
    }
  })
  it('keeps everything else locked', () => {
    for (const p of ['/settings', '/deploy', '/scenes-x', '/studio-x', '/scenes/a/b', '/imports', '/demo', '/analytics', '/events']) {
      expect(trialAllows(p), p).toBe(false)
    }
  })
})

describe('tokenUserId', () => {
  it('reads the user id from a token', () => {
    expect(tokenUserId(tok({ id: 'u1', kind: 'trial' }))).toBe('u1')
    expect(tokenUserId(tok({ sub: 'u2' }))).toBe('u2')
    expect(tokenUserId('garbage')).toBeNull()
  })
})
