import { describe, expect, it } from 'vitest'
import { noteMovedHeadsets, takeMovedHeadsetNotice, readTextRecovering, SIGN_IN_UNLOCKS, stashTrialHandover, takeTrialHandover, trialEndedOutcome, trialBearerStale, renewedTrialBearer, trialStartMessage, accountRequired, blockedCopy, signedInNote, signUpButtons, openSignUp, subscribeSignUp, resolveSignUp, dismissSignUp, beginTrial, signUpAutoDismiss, trialNav } from './trial'

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
  it('asks a trial opening a design’s invite link to sign up to join it (LIV-159)', () => {
    expect(blockedCopy('studio_invite', { designName: 'Neon Jacket' })).toEqual({
      title: 'Create a free account to join Neon Jacket.', unlocks: 'Your trial designs and scenes move into your account.', emphasis: 'Neon Jacket',
    })
    expect(blockedCopy('studio_invite', {}).title).toBe('Create a free account to join this design.')
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

describe('signUpButtons', () => {
  const both = { google: true, discord: true }
  it('shows Google and Discord on both tabs', () => {
    expect(signUpButtons('create', both, false).map((b) => b.id)).toEqual(['google', 'discord'])
    expect(signUpButtons('signin', both, false).map((b) => b.id)).toEqual(['google', 'discord'])
  })
  it('puts the wallet first and names it for the tab', () => {
    expect(signUpButtons('create', both, true)[0]).toEqual({ id: 'wallet', label: 'Continue with wallet' })
    expect(signUpButtons('signin', both, true)[0]).toEqual({ id: 'wallet', label: 'Sign in with wallet' })
  })
  it('leaves out providers that are not configured', () => {
    expect(signUpButtons('signin', { google: false, discord: true }, false)).toEqual([{ id: 'discord', label: 'Continue with Discord' }])
    expect(signUpButtons('create', { google: false, discord: false }, false)).toEqual([])
  })
})

describe('beginTrial (/try/studio Start)', () => {
  const deps = (over: Partial<Parameters<typeof beginTrial>[0]> = {}) => {
    const calls = { start: [] as string[], resets: 0 }
    const opts = {
      signedIn: false,
      botToken: 'tok' as string | null,
      startTrial: async (t: string) => { calls.start.push(t) },
      resetBotCheck: () => { calls.resets++ },
      ...over,
    }
    return { opts, calls }
  }
  it('starts a trial with the bot-check token and keeps the check', async () => {
    const { opts, calls } = deps()
    expect(await beginTrial(opts)).toEqual({ ok: true })
    expect(calls.start).toEqual(['tok'])
    expect(calls.resets).toBe(0)
  })
  it('skips the start for a session that already exists', async () => {
    const { opts, calls } = deps({ signedIn: true })
    expect(await beginTrial(opts)).toEqual({ ok: true })
    expect(calls.start).toEqual([])
  })
  it('after a refused start, resets the bot check (its token was spent) and says why', async () => {
    const { opts, calls } = deps({ startTrial: async () => { throw new Error('trial_limit') } })
    expect(await beginTrial(opts)).toEqual({ ok: false, error: trialStartMessage('trial_limit') })
    expect(calls.resets).toBe(1)
  })
})

describe('beginTrial entry', () => {
  it('passes the entry along with the bot-check token', async () => {
    const seen: unknown[][] = []
    const r = await beginTrial({ signedIn: false, botToken: 'tok', entry: 'scene', startTrial: async (...a: unknown[]) => { seen.push(a) }, resetBotCheck: () => {} })
    expect(r).toEqual({ ok: true })
    expect(seen).toEqual([['tok', 'scene']])
  })
})

describe('blockedCopy for scenes, imports, scans and demos', () => {
  it('names the scene for the save, and keeps the layout', () => {
    const c = blockedCopy('POST /api/wizard/scenes', { sceneName: 'Ramen Bar' })
    expect(c.title).toBe('Create a free account to save Ramen Bar. Your layout is kept.')
    expect(c.emphasis).toBe('Ramen Bar')
  })
  it('has a save line without a name', () => {
    const c = blockedCopy('POST /api/wizard/scenes', { sceneName: '  ' })
    expect(c.title).toBe('Create a free account to save your scene. Your layout is kept.')
    expect(c.emphasis).toBeUndefined()
  })
  it('has copy for every phase 2 refusal', () => {
    for (const a of ['POST /api/imports/:id/deploy', 'GET /api/scenes/:sceneId/backup.zip', 'more_imports', 'import_larger', 'more_scans', 'shared_headset', 'element_type', 'room_set']) {
      const c = blockedCopy(a, {})
      expect(c.title, a).not.toBe('Create a free account to use this.')
      expect(c.unlocks.length, a).toBeGreaterThan(0)
    }
  })
  it('a demo action asks for an account to use it with your own scenes', () => {
    expect(blockedCopy('demo:createEvent', {}).title).toBe('Create a free account to use this with your own scenes.')
  })
  it('names the button to press again after sign-in', () => {
    expect(signedInNote('POST /api/wizard/scenes')).toBe("You're signed in — press Create and deploy again")
    expect(signedInNote('more_imports')).toBe("You're signed in — press Import again")
  })
})

describe('trialNav', () => {
  it('opens the Studio and Scenes, sends Analytics, Events and Giveaways to their demos, and locks the rest', () => {
    expect(trialNav('/studio')).toEqual({ href: '/studio', demo: false })
    expect(trialNav('/scenes')).toEqual({ href: '/scenes', demo: false })
    expect(trialNav('/analytics')).toEqual({ href: '/demo/analytics', demo: true })
    expect(trialNav('/events')).toEqual({ href: '/demo/events', demo: true })
    expect(trialNav('/giveaways')).toEqual({ href: '/demo/giveaways', demo: true })
    for (const h of ['/command-center', '/media', '/assets', '/streaming', '/deploy', '/settings', '/admin']) expect(trialNav(h), h).toBeNull()
  })
})

describe('signUpAutoDismiss', () => {
  it('gives up a pending sign-up once the session is no longer a trial', () => {
    expect(signUpAutoDismiss({ pending: true, isTrial: false, submitting: false })).toBe(true)
  })
  it('waits while a sign-up or sign-in from the sheet is in flight: that call resolves the pending action itself', () => {
    expect(signUpAutoDismiss({ pending: true, isTrial: false, submitting: true })).toBe(false)
  })
  it('does nothing for a trial or with nothing pending', () => {
    expect(signUpAutoDismiss({ pending: true, isTrial: true, submitting: false })).toBe(false)
    expect(signUpAutoDismiss({ pending: false, isTrial: false, submitting: false })).toBe(false)
  })
})

describe('trial copy: designs and scenes move', () => {
  it('nav, the default and the sign-in tab say scenes move too', () => {
    expect(blockedCopy('nav:/settings', { label: 'Settings' }).unlocks).toBe('Your trial designs and scenes move into your account.')
    expect(blockedCopy('POST /api/somewhere', {}).unlocks).toBe('Your trial designs and scenes move into your account.')
    expect(SIGN_IN_UNLOCKS).toBe('Your trial designs and scenes move into this account.')
  })
})

describe('readTextRecovering', () => {
  const deps = (over: Partial<{ swapToStoredAccount: (t: string) => string | null; renew: () => Promise<string | null> }> = {}) => ({
    swapToStoredAccount: () => null, renew: async () => null, ...over,
  })
  it('a trial that became an account reads the log as the account', async () => {
    const sent: Array<string | null> = []
    const send = async (b: string | null) => {
      sent.push(b)
      return b === 'trial' ? new Response(JSON.stringify({ error: 'trial_ended' }), { status: 401 }) : new Response('build log', { status: 200 })
    }
    const text = await readTextRecovering(send, 'trial', deps({ swapToStoredAccount: () => 'acct' }))
    expect([text, sent]).toEqual(['build log', ['trial', 'acct']])
  })
  it('an expired access token is renewed and sent once more', async () => {
    const send = async (b: string | null) => b === 'old' ? new Response('{}', { status: 401 }) : new Response('log', { status: 200 })
    expect(await readTextRecovering(send, 'old', deps({ renew: async () => 'new' }))).toBe('log')
  })
  it('a refusal throws with its status and body, after telling onError', async () => {
    const seen: Array<[number, unknown]> = []
    const send = async () => new Response(JSON.stringify({ error: 'files_expired', message: 'gone' }), { status: 410 })
    const err = await readTextRecovering(send, 'acct', deps(), (status, body) => seen.push([status, body])).catch((e) => e)
    expect([err.message, err.status, err.body]).toEqual(['files_expired', 410, { error: 'files_expired', message: 'gone' }])
    expect(seen).toEqual([[410, { error: 'files_expired', message: 'gone' }]])
  })
  it('a non-JSON refusal becomes HTTP <status>', async () => {
    const err = await readTextRecovering(async () => new Response('<html>', { status: 502 }), 'acct', deps()).catch((e) => e)
    expect([err.message, err.status]).toEqual(['HTTP 502', 502])
  })
})

describe('the moved-headset notice', () => {
  const memory = () => {
    const m = new Map<string, string>()
    return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k), m }
  }
  it('a sign-in that moved a paired headset says so once', () => {
    const s = memory()
    noteMovedHeadsets(s, { accessToken: 'a', movedHeadsets: 1 })
    expect(takeMovedHeadsetNotice(s)).toBe('Your paired headset is now on your account. You can remove it in Settings.')
    expect(takeMovedHeadsetNotice(s)).toBeNull()
  })
  it('several headsets', () => {
    const s = memory()
    noteMovedHeadsets(s, { movedHeadsets: 2 })
    expect(takeMovedHeadsetNotice(s)).toBe('Your paired headsets are now on your account. You can remove them in Settings.')
  })
  it('nothing moved, or a body without the field, notes nothing', () => {
    const s = memory()
    for (const body of [{}, { movedHeadsets: 0 }, null, 'x', { movedHeadsets: '1' }]) noteMovedHeadsets(s, body)
    expect(s.m.size).toBe(0)
    expect(takeMovedHeadsetNotice(s)).toBeNull()
  })
})
