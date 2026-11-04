import { describe, it, expect, vi } from 'vitest'
import { runHandoff, hasAccountSession } from './handoff'

const base = 'https://virvi.io/auth/handoff/#code=SECRET&next=%2Fanalytics%2F%3Fscene%3Dabc'

function deps(status: number) {
  const calls: string[] = []
  return {
    calls,
    d: {
      href: base,
      replaceUrl: vi.fn((u: string) => calls.push(`replace:${u}`)),
      exchange: vi.fn(async (c: string) => { calls.push(`exchange:${c}`); return status === 200 ? { status, body: { accessToken: 'a', refreshToken: 'r', user: { id: 'u' } } } : { status } }),
      saveSession: vi.fn(),
      go: vi.fn((u: string) => calls.push(`go:${u}`)),
    },
  }
}

describe('runHandoff', () => {
  it('reads the code from the fragment and strips the whole fragment before exchanging, then signs in and goes to next', async () => {
    const { calls, d } = deps(200)
    expect(await runHandoff(d)).toBe('signed-in')
    expect(calls[0]).toBe('replace:/auth/handoff/')
    expect(calls[1]).toBe('exchange:SECRET')
    expect(d.saveSession).toHaveBeenCalledWith({ token: 'a', refresh: 'r', user: { id: 'u' } })
    expect(calls.at(-1)).toBe('go:/analytics/?scene=abc')
  })
  it('a used or expired code (410) falls back to sign-in with the same next', async () => {
    const { calls, d } = deps(410)
    expect(await runHandoff(d)).toBe('fallback')
    expect(d.saveSession).not.toHaveBeenCalled()
    expect(calls.at(-1)).toBe(`go:/signin/?next=${encodeURIComponent('/analytics/?scene=abc')}`)
  })
  it('an off-site next is ignored', async () => {
    const { d } = deps(200)
    d.href = 'https://virvi.io/auth/handoff/#code=X&next=%2F%2Fevil.com'
    await runHandoff(d)
    expect(d.go).toHaveBeenLastCalledWith('/analytics/')
  })
  it('a code in the query string is never exchanged, and is removed from the address bar', async () => {
    const { calls, d } = deps(200)
    d.href = 'https://virvi.io/auth/handoff/?code=SECRET&next=%2Fanalytics%2F%3Fscene%3Dabc'
    expect(await runHandoff(d)).toBe('fallback')
    expect(d.exchange).not.toHaveBeenCalled()
    expect(calls[0]).toBe('replace:/auth/handoff/')
    expect(calls.at(-1)).toBe('go:/signin/?next=%2Fanalytics%2F')
  })
})

const tok = (p: Record<string, unknown>) => `x.${Buffer.from(JSON.stringify(p)).toString('base64url')}.y`
const NOW = 1_800_000_000_000
const stored = (p: Record<string, unknown>) => JSON.stringify({ token: tok(p), refresh: 'r', user: { id: 'u' } })

describe('hasAccountSession', () => {
  it('is true only for an unexpired account session', () => {
    expect(hasAccountSession(stored({ exp: NOW / 1000 + 60, kind: 'account' }), NOW)).toBe(true)
    expect(hasAccountSession(stored({ exp: NOW / 1000 - 1, kind: 'account' }), NOW)).toBe(false)
    expect(hasAccountSession(stored({ exp: NOW / 1000 + 60, kind: 'scene', sceneId: 's1' }), NOW)).toBe(false)
    expect(hasAccountSession(stored({ exp: NOW / 1000 + 60, kind: 'scene', sceneId: null, via: 'studio' }), NOW)).toBe(false)
    expect(hasAccountSession(stored({ exp: NOW / 1000 + 60 }), NOW)).toBe(false)
    expect(hasAccountSession(null, NOW)).toBe(false)
    expect(hasAccountSession('{not json', NOW)).toBe(false)
  })
})

describe('runHandoff with a stored session', () => {
  it('keeps an existing full session: no exchange, no save, straight to next', async () => {
    const { calls, d } = deps(200)
    const r = await runHandoff({ ...d, storedSession: () => stored({ exp: NOW / 1000 + 60, kind: 'account' }), now: () => NOW })
    expect(r).toBe('signed-in')
    expect(d.exchange).not.toHaveBeenCalled()
    expect(d.saveSession).not.toHaveBeenCalled()
    expect(calls).toEqual(['replace:/auth/handoff/', 'go:/analytics/?scene=abc'])
  })
  it('replaces a stored scene pass or expired session as before', async () => {
    for (const p of [{ exp: NOW / 1000 + 60, kind: 'scene', sceneId: 's1' }, { exp: NOW / 1000 - 1, kind: 'account' }]) {
      const { d } = deps(200)
      await runHandoff({ ...d, storedSession: () => stored(p), now: () => NOW })
      expect(d.exchange).toHaveBeenCalledWith('SECRET')
      expect(d.saveSession).toHaveBeenCalled()
    }
  })
})
