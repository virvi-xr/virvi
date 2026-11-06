import { describe, expect, it } from 'vitest'
import { stashTrialHandover, takeTrialHandover, trialEndedOutcome, trialBearerStale, renewedTrialBearer, trialStartMessage, accountRequired, blockedCopy, signedInNote, openSignUp, subscribeSignUp, resolveSignUp, dismissSignUp } from './trial'

describe('accountRequired', () => {
  it('reads the action from an account_required refusal', () => {
    const err = Object.assign(new Error('account_required'), { status: 403, body: { error: 'account_required', action: 'POST /api/studio/topups' } })
    expect(accountRequired(err)).toEqual({ action: 'POST /api/studio/topups' })
  })
  it('ignores other errors', () => {
    expect(accountRequired(Object.assign(new Error('x'), { status: 403, body: { error: 'scene_pass_not_allowed' } }))).toBeNull()
    expect(accountRequired(Object.assign(new Error('x'), { status: 401, body: { error: 'account_required', action: 'a' } }))).toBeNull()
    expect(accountRequired(new Error('plain'))).toBeNull()
    expect(accountRequired(null)).toBeNull()
  })
})

describe('blockedCopy', () => {
  it('names the design and its revisions for finalize', () => {
    expect(blockedCopy('POST /api/studio/designs/:id/finalize', { designName: 'Neon Jacket', revisions: 4 }).title)
      .toBe('Create a free account to finalize Neon Jacket. Your design and its 4 revisions are saved.')
  })
  it('falls back to the default for unknown actions', () => {
    expect(blockedCopy('POST /nope', {}).title).toBe('Create a free account to use this.')
  })
  it('has copy for the limits', () => {
    for (const a of ['more_designs', 'more_prompts', 'upload_more', 'POST /api/studio/topups']) {
      const c = blockedCopy(a, {})
      expect(c.title).not.toBe('Create a free account to use this.')
      expect(c.unlocks.length).toBeGreaterThan(0)
    }
  })
})

describe('sign-up bridge', () => {
  it('resolves a pending openSignUp when the sheet completes, and joins a second request', async () => {
    const seen: unknown[] = []
    const off = subscribeSignUp((r) => seen.push(r))
    const a = openSignUp({ action: 'x', ctx: {} })
    const b = openSignUp({ action: 'x', ctx: {} })
    resolveSignUp('tok')
    await expect(a).resolves.toBe('tok')
    await expect(b).resolves.toBe('tok')
    expect(seen.at(-1)).toBeNull()
    off()
  })
  it('rejects when the sheet is closed', async () => {
    const off = subscribeSignUp(() => {})
    const p = openSignUp({ action: 'x', ctx: {} })
    dismissSignUp()
    await expect(p).rejects.toThrow('closed')
    off()
  })
  it('rejects at once when no sheet is mounted', async () => {
    await expect(openSignUp({ action: 'x', ctx: {} })).rejects.toThrow()
  })
})

describe('trialEndedOutcome', () => {
  it('swaps to a stored non-trial session from another token', () => {
    expect(trialEndedOutcome({ token: 'acct', user: { id: 'u' } }, 'trial')).toBe('swap')
  })
  it('signs out when nothing else is stored', () => {
    expect(trialEndedOutcome(null, 'trial')).toBe('logout')
    expect(trialEndedOutcome({ token: 'trial', user: { trial: true } }, 'trial')).toBe('logout')
    expect(trialEndedOutcome({ token: 'other', user: { trial: true } }, 'trial')).toBe('logout')
  })
})

describe('dismissed sign-up', () => {
  it('rejects the pending call and lets the next one start fresh', async () => {
    const seen: unknown[] = []
    const off = subscribeSignUp((r) => seen.push(r))
    const a = openSignUp({ action: 'x', ctx: {} })
    dismissSignUp()
    await expect(a).rejects.toThrow('closed')
    const b = openSignUp({ action: 'y', ctx: {} })
    expect(b).not.toBe(a)
    resolveSignUp('t2')
    await expect(b).resolves.toBe('t2')
    off()
  })
})

describe('blockedCopy emphasis', () => {
  it('returns the design name separately', () => {
    expect(blockedCopy('POST /api/studio/designs/:id/finalize', { designName: 'Neon Jacket', revisions: 4 }).emphasis).toBe('Neon Jacket')
  })
})

describe('nav copy', () => {
  it('names the locked page', () => {
    expect(blockedCopy('nav:/scenes', { label: 'Scenes' }).title).toBe('Create a free account to use Scenes.')
    expect(blockedCopy('nav:/scenes', {}).title).toBe('Create a free account to use this.')
  })
})

describe('signedInNote', () => {
  it('asks to press the blocked action again', () => {
    expect(signedInNote('POST /api/studio/designs/:id/finalize')).toBe("You're signed in — press Finalize again")
    expect(signedInNote('GET /api/studio/designs/:id/packages')).toBe("You're signed in — press Download again")
    expect(signedInNote('POST /api/studio/topups')).toBe("You're signed in — press Buy prompts again")
    expect(signedInNote('more_designs')).toBe("You're signed in — press New design again")
  })
  it('says only that they are signed in for a nav click or an unknown action, and nothing for no action', () => {
    expect(signedInNote('nav:/scenes')).toBe("You're signed in")
    expect(signedInNote('POST /nope')).toBe("You're signed in")
    expect(signedInNote(null)).toBeNull()
  })
})

describe('trialBearerStale', () => {
  const tok = (claims: object) => `h.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.s`
  const NOW = 1_800_000_000_000
  it('is stale when the trial token has run out or runs out within a minute', () => {
    expect(trialBearerStale(tok({ kind: 'trial', exp: NOW / 1000 - 5 }), NOW)).toBe(true)
    expect(trialBearerStale(tok({ kind: 'trial', exp: NOW / 1000 + 30 }), NOW)).toBe(true)
  })
  it('is fresh with more than a minute left', () => {
    expect(trialBearerStale(tok({ kind: 'trial', exp: NOW / 1000 + 600 }), NOW)).toBe(false)
  })
})

describe('renewedTrialBearer', () => {
  it('uses the renewed token', () => {
    expect(renewedTrialBearer('fresh', true)).toBe('fresh')
  })
  it('drops the bearer when the renewal was refused (the session is gone)', () => {
    expect(renewedTrialBearer(null, false)).toBeNull()
  })
  it('stops instead of signing up without the trial when the server could not be reached', () => {
    expect(() => renewedTrialBearer(null, true)).toThrow("Couldn't reach Virvi. Check your connection and try again.")
  })
})

describe('trialStartMessage', () => {
  it('words each refusal the server gives', () => {
    expect(trialStartMessage('trial_limit')).toBe('Free tries from this network are used up for today. Create a free account to keep going.')
    expect(trialStartMessage('bot_check_failed')).toBe("We couldn't confirm you're human. Try again.")
    expect(trialStartMessage('trials_unavailable')).toBe("Free tries aren't available right now. Create a free account to start.")
    expect(trialStartMessage('bad_device')).toBe('Something went wrong starting your trial. Reload the page and try again.')
  })
  it('never shows a raw code', () => {
    for (const code of ['HTTP 500', 'weird_code', '', undefined]) {
      expect(trialStartMessage(code)).toBe("Something went wrong starting your trial. Try again in a moment.")
    }
  })
})

describe('trial hand-over through Google or Discord', () => {
  const mem = () => {
    const m = new Map<string, string>()
    return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k), m }
  }
  const T = 1_800_000_000_000
  const trial = { token: 'acc', refresh: 'ref', user: { trial: true } }
  it('hands the trial over only to the sign-in this tab started (state matches), once', () => {
    const s = mem()
    const state = stashTrialHandover(s, trial, 'more_prompts', T)!
    expect(state).toMatch(/^[A-Za-z0-9_-]{22,}$/)
    expect(takeTrialHandover(s, 'someone-elses-state', T)).toBeNull()
    expect(takeTrialHandover(s, state, T)).toBeNull() // a wrong state used it up
    const again = stashTrialHandover(s, trial, undefined, T)!
    expect(takeTrialHandover(s, again, T + 60_000)).toEqual({ trialToken: 'ref' })
    expect(takeTrialHandover(s, again, T + 60_000)).toBeNull()
  })
  it('a stale hand-over or a callback without state moves nothing', () => {
    const s = mem()
    const state = stashTrialHandover(s, trial, undefined, T)!
    expect(takeTrialHandover(s, state, T + 16 * 60_000)).toBeNull()
    stashTrialHandover(s, trial, undefined, T)
    expect(takeTrialHandover(s, null, T)).toBeNull()
  })
  it('keeps nothing for an account or no session, and clears an old hand-over', () => {
    const s = mem()
    const state = stashTrialHandover(s, trial, undefined, T)!
    expect(stashTrialHandover(s, { token: 'acc', refresh: 'ref', user: { trial: false } }, undefined, T)).toBeNull()
    expect(takeTrialHandover(s, state, T)).toBeNull()
    expect(stashTrialHandover(s, null, undefined, T)).toBeNull()
  })
  it('ignores a damaged entry', () => {
    const s = mem()
    s.setItem('virvi.trialHandover', '{nope')
    expect(takeTrialHandover(s, 'x', T)).toBeNull()
  })
})
