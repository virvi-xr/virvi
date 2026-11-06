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
  it("passes the studio scene's checkout link, query and all, through to next", async () => {
    const { d } = deps(200)
    d.href = 'https://virvi.io/auth/handoff#code=X&next=/studio/checkout?design=2f1c6a0e-8d3b-4c1a-9f6e-0b7d5e4a3c21'
    expect(await runHandoff(d)).toBe('signed-in')
    expect(d.go).toHaveBeenLastCalledWith('/studio/checkout?design=2f1c6a0e-8d3b-4c1a-9f6e-0b7d5e4a3c21')
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
    // An expired access token with a live refresh token is still signed in (AuthProvider renews it on load)
    expect(hasAccountSession(stored({ exp: NOW / 1000 - 1, kind: 'account' }), NOW)).toBe(true)
    expect(hasAccountSession(JSON.stringify({ token: tok({ exp: NOW / 1000 - 1, kind: 'account' }), refresh: tok({ exp: NOW / 1000 + 3600, kind: 'account', refresh: true }) }), NOW)).toBe(true)
    expect(hasAccountSession(JSON.stringify({ token: tok({ exp: NOW / 1000 - 1, kind: 'account' }), refresh: tok({ exp: NOW / 1000 - 1, kind: 'account', refresh: true }) }), NOW)).toBe(false)
    expect(hasAccountSession(JSON.stringify({ token: tok({ exp: NOW / 1000 - 1, kind: 'account' }), refresh: null }), NOW)).toBe(false)
    expect(hasAccountSession(JSON.stringify({ token: tok({ exp: NOW / 1000 - 1, kind: 'scene', sceneId: 's1' }), refresh: 'r' }), NOW)).toBe(false)
    expect(hasAccountSession(stored({ exp: NOW / 1000 + 60, kind: 'scene', sceneId: 's1' }), NOW)).toBe(false)
    expect(hasAccountSession(stored({ exp: NOW / 1000 + 60, kind: 'scene', sceneId: null, via: 'studio' }), NOW)).toBe(false)
    expect(hasAccountSession(stored({ exp: NOW / 1000 + 60 }), NOW)).toBe(false)
    expect(hasAccountSession(null, NOW)).toBe(false)
    expect(hasAccountSession('{not json', NOW)).toBe(false)
  })
})

describe('runHandoff with a stored session', () => {
  const acct = () => stored({ exp: NOW / 1000 + 60, kind: 'account' })
  it('a failing code (non-200) keeps the existing full session and goes to next', async () => {
    const { calls, d } = deps(410)
    const r = await runHandoff({ ...d, storedSession: acct, now: () => NOW })
    expect(r).toBe('signed-in')
    expect(d.saveSession).not.toHaveBeenCalled()
    expect(calls.at(-1)).toBe('go:/analytics/?scene=abc')
  })
  it('a throwing exchange keeps the existing full session and goes to next', async () => {
    const { calls, d } = deps(200)
    d.exchange.mockImplementation(async () => { throw new Error('network') })
    const r = await runHandoff({ ...d, storedSession: acct, now: () => NOW })
    expect(r).toBe('signed-in')
    expect(d.saveSession).not.toHaveBeenCalled()
    expect(calls.at(-1)).toBe('go:/analytics/?scene=abc')
  })
  it('no code and an existing full session: no exchange, straight to next', async () => {
    const { calls, d } = deps(200)
    d.href = 'https://virvi.io/auth/handoff/#next=%2Fanalytics%2F%3Fscene%3Dabc'
    const r = await runHandoff({ ...d, storedSession: acct, now: () => NOW })
    expect(r).toBe('signed-in')
    expect(d.exchange).not.toHaveBeenCalled()
    expect(d.saveSession).not.toHaveBeenCalled()
    expect(calls).toEqual(['replace:/auth/handoff/', 'go:/analytics/?scene=abc'])
  })
  it('replaces a stored scene pass, or a session with neither a live access token nor a refresh token, as before', async () => {
    const dead = (p: Record<string, unknown>) => JSON.stringify({ token: tok(p), refresh: null, user: { id: 'u' } })
    for (const s of [stored({ exp: NOW / 1000 + 60, kind: 'scene', sceneId: 's1' }), dead({ exp: NOW / 1000 - 1, kind: 'account' })]) {
      const { d } = deps(200)
      await runHandoff({ ...d, storedSession: () => s, now: () => NOW })
      expect(d.exchange).toHaveBeenCalledWith('SECRET')
      expect(d.saveSession).toHaveBeenCalled()
    }
  })
})

describe('runHandoff over an existing account session', () => {
  const acctTok = (id: string, extra: Record<string, unknown> = {}) => tok({ exp: NOW / 1000 + 60, kind: 'account', id, ...extra })
  const storedAcct = (id = 'u1', displayName: string | null = 'Ada') => () => JSON.stringify({ token: acctTok(id, { wallet: '0x1111111111111111111111111111111111111111' }), refresh: 'r-old', user: { id, displayName } })
  function exch(body: { accessToken: string; refreshToken: string | null; user: Record<string, unknown> }) {
    const calls: string[] = []
    const choose = vi.fn(async (_c: { them: string; stored: string }) => 'them' as 'them' | 'stay')
    return {
      calls, choose,
      d: {
        href: base,
        replaceUrl: vi.fn((u: string) => calls.push(`replace:${u}`)),
        exchange: vi.fn(async (c: string) => { calls.push(`exchange:${c}`); return { status: 200, body } }),
        saveSession: vi.fn(),
        go: vi.fn((u: string) => calls.push(`go:${u}`)),
        choose,
        now: () => NOW,
      },
    }
  }

  it('a HUD scene code keeps the stored account session (no save) and goes to next', async () => {
    const { d, calls, choose } = exch({ accessToken: tok({ exp: NOW / 1000 + 60, kind: 'scene', sceneId: 's1', id: 'u1' }), refreshToken: null, user: { id: 'u1', displayName: 'Ada' } })
    expect(await runHandoff({ ...d, storedSession: storedAcct() })).toBe('signed-in')
    expect(d.exchange).toHaveBeenCalledWith('SECRET')
    expect(d.saveSession).not.toHaveBeenCalled()
    expect(choose).not.toHaveBeenCalled()
    expect(calls.at(-1)).toBe('go:/analytics/?scene=abc')
  })
  it("a HUD scene code for someone else's account still keeps the stored session, without asking", async () => {
    const { d, choose } = exch({ accessToken: tok({ exp: NOW / 1000 + 60, kind: 'scene', sceneId: 's1', id: 'u2' }), refreshToken: null, user: { id: 'u2', displayName: 'Bob' } })
    expect(await runHandoff({ ...d, storedSession: storedAcct() })).toBe('signed-in')
    expect(d.saveSession).not.toHaveBeenCalled()
    expect(choose).not.toHaveBeenCalled()
  })
  it('a scene code with no stored session is saved as before', async () => {
    const body = { accessToken: tok({ exp: NOW / 1000 + 60, kind: 'scene', sceneId: 's1', id: 'u1' }), refreshToken: null, user: { id: 'u1' } }
    const { d } = exch(body)
    expect(await runHandoff({ ...d, storedSession: () => null })).toBe('signed-in')
    expect(d.saveSession).toHaveBeenCalledWith({ token: body.accessToken, refresh: null, user: body.user })
  })
  it('the same account refreshes the stored session without asking', async () => {
    const body = { accessToken: acctTok('u1'), refreshToken: 'r-new', user: { id: 'u1', displayName: 'Ada' } }
    const { d, calls, choose } = exch(body)
    expect(await runHandoff({ ...d, storedSession: storedAcct() })).toBe('signed-in')
    expect(choose).not.toHaveBeenCalled()
    expect(d.saveSession).toHaveBeenCalledWith({ token: body.accessToken, refresh: 'r-new', user: body.user })
    expect(calls.at(-1)).toBe('go:/analytics/?scene=abc')
  })
  it('a different account asks first, naming both; "Continue as them" saves the new session', async () => {
    const body = { accessToken: acctTok('u2', { wallet: '0xabcdef0000000000000000000000000000001234' }), refreshToken: 'r2', user: { id: 'u2', displayName: 'Bob' } }
    const { d, calls, choose } = exch(body)
    choose.mockImplementation(async () => {
      expect(d.saveSession).not.toHaveBeenCalled()
      expect(d.go).not.toHaveBeenCalled()
      return 'them'
    })
    expect(await runHandoff({ ...d, storedSession: storedAcct() })).toBe('signed-in')
    expect(choose).toHaveBeenCalledWith({ them: 'Bob (0xabcd…1234)', stored: 'Ada (0x1111…1111)' })
    expect(d.saveSession).toHaveBeenCalledWith({ token: body.accessToken, refresh: 'r2', user: body.user })
    expect(calls.at(-1)).toBe('go:/analytics/?scene=abc')
  })
  it('"Stay signed in" keeps the stored session and goes to next', async () => {
    const { d, calls, choose } = exch({ accessToken: acctTok('u2'), refreshToken: 'r2', user: { id: 'u2', displayName: 'Bob' } })
    choose.mockResolvedValue('stay')
    expect(await runHandoff({ ...d, storedSession: storedAcct() })).toBe('signed-in')
    expect(d.saveSession).not.toHaveBeenCalled()
    expect(calls.at(-1)).toBe('go:/analytics/?scene=abc')
  })
  it('names an account with no display name by its short wallet', async () => {
    const { d, choose } = exch({ accessToken: acctTok('u2', { wallet: '0xabcdef0000000000000000000000000000001234' }), refreshToken: 'r2', user: { id: 'u2', displayName: null } })
    await runHandoff({ ...d, storedSession: storedAcct('u1', null) })
    expect(choose).toHaveBeenCalledWith({ them: '0xabcd…1234', stored: '0x1111…1111' })
  })
  const expiredAcct = (id = 'u1') => () => JSON.stringify({
    token: acctTok(id, { exp: NOW / 1000 - 60, wallet: '0x1111111111111111111111111111111111111111' }),
    refresh: tok({ exp: NOW / 1000 + 6 * 86400, kind: 'account', id, refresh: true }),
    user: { id, displayName: 'Ada' },
  })
  it('an expired access token with a live refresh token is NOT overwritten by a scene pass', async () => {
    const { d, choose, calls } = exch({ accessToken: tok({ exp: NOW / 1000 + 60, kind: 'scene', sceneId: 's1', id: 'u2' }), refreshToken: null, user: { id: 'u2', displayName: 'Bob' } })
    expect(await runHandoff({ ...d, storedSession: expiredAcct() })).toBe('signed-in')
    expect(d.saveSession).not.toHaveBeenCalled()
    expect(choose).not.toHaveBeenCalled()
    expect(calls.at(-1)).toBe('go:/analytics/?scene=abc')
  })
  it('an expired access token with a live refresh token gets the choice for a different account', async () => {
    const { d, choose } = exch({ accessToken: acctTok('u2', { wallet: '0xabcdef0000000000000000000000000000001234' }), refreshToken: 'r2', user: { id: 'u2', displayName: 'Bob' } })
    choose.mockResolvedValue('stay')
    await runHandoff({ ...d, storedSession: expiredAcct() })
    expect(choose).toHaveBeenCalledWith({ them: 'Bob (0xabcd…1234)', stored: 'Ada (0x1111…1111)' })
    expect(d.saveSession).not.toHaveBeenCalled()
  })
  it('a stored session with neither a valid access token nor a refresh token is no session: replaced without asking', async () => {
    const dead = JSON.stringify({ token: acctTok('u1', { exp: NOW / 1000 - 60 }), refresh: null, user: { id: 'u1' } })
    for (const s of [dead, stored({ exp: NOW / 1000 + 60, kind: 'scene', sceneId: 's1', id: 'u1' })]) {
      const { d, choose } = exch({ accessToken: acctTok('u2'), refreshToken: 'r2', user: { id: 'u2' } })
      await runHandoff({ ...d, storedSession: () => s })
      expect(choose).not.toHaveBeenCalled()
      expect(d.saveSession).toHaveBeenCalled()
    }
  })
  it('two accounts with the same display name get different labels (the name is freely editable)', async () => {
    const { d, choose } = exch({ accessToken: acctTok('u2', { wallet: '0xabcdef0000000000000000000000000000001234' }), refreshToken: 'r2', user: { id: 'u2', displayName: 'Ada' } })
    await runHandoff({ ...d, storedSession: storedAcct('u1', 'Ada') })
    const { them, stored: mine } = choose.mock.calls[0][0]
    expect(them).not.toBe(mine)
    expect(them).toBe('Ada (0xabcd…1234)')
  })
  it('an account with no wallet shows its masked email, else "another Virvi account"', async () => {
    const { d, choose } = exch({ accessToken: acctTok('u2', { email: 'mallory@evil.io' }), refreshToken: 'r2', user: { id: 'u2', displayName: 'Ada', email: 'mallory@evil.io' } })
    await runHandoff({ ...d, storedSession: () => JSON.stringify({ token: acctTok('u1'), refresh: 'r', user: { id: 'u1', displayName: 'Ada' } }) })
    expect(choose).toHaveBeenCalledWith({ them: 'Ada (m•••@evil.io)', stored: 'another Virvi account' })
  })
})
