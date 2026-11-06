import { describe, expect, it } from 'vitest'
import { trialEndedOutcome, accountRequired, blockedCopy, signedInNote, openSignUp, subscribeSignUp, resolveSignUp, dismissSignUp } from './trial'

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
