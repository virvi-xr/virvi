import { describe, it, expect } from 'vitest'
import type { VisitorGiveaway } from '@virvixr/shared'
import { checkInWanted, giveawayCardView, giveawayError, giveawayState, initialGiveawayUi, stayLeft, type GiveawayUi } from '../src/giveaway/card.js'

const STOP = { id: 'stop', label: 'Stop tracking' }

const WALLET = '0xAbCdEf0123456789aBcDeF0123456789AbCdEf12'
const giveaway = (over: Partial<VisitorGiveaway> = {}): VisitorGiveaway => ({
  id: 'g1', name: 'Winter drop', items: [{ name: 'Scarf', thumbnail: null, rarity: 'rare' }, { name: 'Hat', thumbnail: null, rarity: null }],
  endsAt: null, minPresentSeconds: 300, test: false, claim: null, ...over,
})
const claim = (status: NonNullable<VisitorGiveaway['claim']>['status'], over: Partial<NonNullable<VisitorGiveaway['claim']>> = {}) =>
  ({ claim: { status, secondsPresent: 0, txUrl: null, failReason: null, delayed: false, ...over } })
const ui = (over: Partial<GiveawayUi> = {}): GiveawayUi => ({ ...initialGiveawayUi(false, WALLET), ...over })
const httpError = (status: number, body: Record<string, unknown>) => new Error(`HTTP ${status}: ${JSON.stringify(body)}`)

describe('giveaway card (LIV-194)', () => {
  it('hides with no giveaway', () => {
    expect(giveawayCardView(null, ui())).toMatchObject({ state: 'hidden', visible: false, actions: [] })
  })

  it('a guest gets the wallet notice, with no button, until the notice is done', () => {
    const v = giveawayCardView({ name: 'Winter drop', test: true }, initialGiveawayUi(true, null))
    expect(v).toMatchObject({ state: 'guest', visible: true, line: 'Connect a wallet to claim Winter drop.', test: true, actions: [] })
    expect(giveawayCardView({ name: 'Winter drop', test: true }, { ...initialGiveawayUi(true, null), noticeDone: true }).state).toBe('hidden')
  })

  it('a guest given a full giveaway still only sees the notice', () => {
    expect(giveawayState(giveaway(), initialGiveawayUi(true, null))).toBe('guest')
  })

  it('not consented: the free items (the title already names it), the notice with the short wallet, and Agree and continue', () => {
    const v = giveawayCardView(giveaway(), ui())
    expect(v).toMatchObject({
      state: 'consent',
      title: 'Winter drop',
      line: 'Free: Scarf, Hat.',
      notice: 'Virvi will mint these to your wallet 0xabcd…ef12. The host sees that this wallet claimed.',
      actions: [{ id: 'agree', label: 'Agree and continue' }],
    })
  })

  it('present and short of the minimum: how long is left as m:ss, and Stop tracking', () => {
    const v = giveawayCardView(giveaway(claim('present', { secondsPresent: 45 })), ui())
    expect(v).toMatchObject({ state: 'present', line: 'Stay 4:15 more to claim.', actions: [STOP], notice: null })
    expect(giveawayCardView(giveaway({ minPresentSeconds: 3600, ...claim('present', { secondsPresent: 3595 }) }), ui()).line).toBe('Stay 0:05 more to claim.')
    expect(stayLeft(754)).toBe('12:34')
  })

  it('the countdown ticks on from the last server read, and reaching 0 shows Claim', () => {
    const T = 1_000_000
    const g = giveaway(claim('present', { secondsPresent: 45 }))
    const seen = ui({ seenAt: T })
    expect(giveawayCardView(g, seen, T).line).toBe('Stay 4:15 more to claim.')
    expect(giveawayCardView(g, seen, T + 30_500).line).toBe('Stay 3:45 more to claim.')
    expect(giveawayCardView(g, seen, T + 254_000).line).toBe('Stay 0:01 more to claim.')
    expect(giveawayCardView(g, seen, T + 255_000)).toMatchObject({ state: 'ready', line: null })
    expect(giveawayCardView(g, seen, T + 9_000_000).state).toBe('ready')
    // A clock behind the read never adds time back
    expect(giveawayCardView(g, seen, T - 60_000).line).toBe('Stay 4:15 more to claim.')
    // Only a present claim counts on
    expect(giveawayState(giveaway(claim('waiting', { secondsPresent: 10 })), seen, T + 900_000)).toBe('sending')
  })

  it('present with the minimum: Claim and Stop tracking, no text', () => {
    const v = giveawayCardView(giveaway(claim('present', { secondsPresent: 300 })), ui())
    expect(v).toMatchObject({ state: 'ready', line: null, actions: [{ id: 'claim', label: 'Claim' }, STOP] })
    expect(giveawayState(giveaway({ minPresentSeconds: 0, ...claim('present') }), ui())).toBe('ready')
  })

  it('waiting and minting say On its way.', () => {
    for (const s of ['waiting', 'minting'] as const) {
      expect(giveawayCardView(giveaway(claim(s, { secondsPresent: 300 })), ui())).toMatchObject({ state: 'sending', line: 'On its way.', actions: [] })
    }
  })

  it('a delayed claim (paused, or waiting a while) says Still sending.', () => {
    for (const s of ['waiting', 'minting'] as const) {
      expect(giveawayCardView(giveaway(claim(s, { delayed: true })), ui())).toMatchObject({ state: 'sending', line: 'Still sending.', actions: [] })
    }
  })

  it('sent: Sent ✓ and View opens the tx', () => {
    const tx = 'https://polygonscan.com/tx/0xabc'
    expect(giveawayCardView(giveaway(claim('waiting')), ui()).actions).toEqual([])
    expect(giveawayCardView(giveaway(claim('sent', { txUrl: tx })), ui())).toMatchObject({ state: 'sent', line: 'Sent ✓', txUrl: tx, actions: [{ id: 'view_tx', label: 'View' }] })
    expect(giveawayCardView(giveaway(claim('sent')), ui())).toMatchObject({ line: 'Sent ✓', actions: [] })
  })

  it('failed: the reason text', () => {
    expect(giveawayCardView(giveaway(claim('failed', { failReason: 'sold_out' })), ui())).toMatchObject({ state: 'failed', line: "Couldn't send: this giveaway ran out.", actions: [] })
    expect(giveawayCardView(giveaway(claim('failed', { failReason: 'ended' })), ui()).line).toBe("Couldn't send: this giveaway ended.")
    expect(giveawayCardView(giveaway(claim('failed', { failReason: 'item_removed' })), ui()).line).toBe("Couldn't send: the host removed an item.")
    expect(giveawayCardView(giveaway(claim('failed', { failReason: 'reverted' })), ui()).line).toBe("Couldn't send: the collection refused the mint.")
    expect(giveawayCardView(giveaway(claim('failed', { failReason: 'replaced' })), ui()).line).toBe("Couldn't send: Virvi is checking what happened.")
    expect(giveawayCardView(giveaway(claim('failed')), ui()).line).toBe("Couldn't send: something went wrong.")
  })

  it('busy: Working… and no buttons; the note rides along', () => {
    expect(giveawayCardView(giveaway(), ui({ busy: true }))).toMatchObject({ line: 'Working…', actions: [] })
    expect(giveawayCardView(giveaway(), ui({ note: 'x' })).note).toBe('x')
  })

  it('checks in only while present and short of the minimum on the server count (not the local estimate)', () => {
    expect(checkInWanted(giveaway(claim('present', { secondsPresent: 10 })), ui({ seenAt: 0 }))).toBe(true)
    expect(checkInWanted(giveaway(claim('present', { secondsPresent: 10 })), ui())).toBe(true)
    expect(checkInWanted(giveaway(claim('present', { secondsPresent: 300 })), ui())).toBe(false)
    expect(checkInWanted(giveaway(), ui())).toBe(false)
    expect(checkInWanted(giveaway(claim('waiting')), ui())).toBe(false)
  })

  it('maps error codes to short lines', () => {
    expect(giveawayError(httpError(403, { error: 'wallet_required' }))).toBe('Connect a wallet to claim.')
    expect(giveawayError(httpError(403, { error: 'wallet_blocked' }))).toBe("This wallet can't claim giveaways any more.")
    expect(giveawayError(httpError(409, { error: 'already_claimed' }))).toBe('This wallet already claimed this giveaway.')
    expect(giveawayError(httpError(409, { error: 'claimed' }))).toBe("You've already claimed this giveaway.")
    expect(giveawayError(httpError(409, { error: 'too_soon', secondsLeft: 75 }))).toBe('Stay 1:15 more to claim.')
    expect(giveawayError(httpError(409, { error: 'too_soon' }))).toBe("You haven't been here long enough yet.")
    expect(giveawayError(httpError(409, { error: 'sold_out' }))).toBe('This giveaway ran out.')
    expect(giveawayError(httpError(409, { error: 'closed' }))).toBe('This giveaway is closed.')
    expect(giveawayError(httpError(400, { error: 'consent_outdated' }))).toBe('This scene needs an update before you can claim. Ask the host to update it.')
    expect(giveawayError(httpError(403, { error: 'profile_required' }))).toBe('Set up your Decentraland profile (an avatar) first, then come back to claim.')
    expect(giveawayError(httpError(429, { error: 'too_many_new_wallets' }))).toBe('Too many new wallets have claimed from your network. Try again later.')
    expect(giveawayError(httpError(404, { error: 'not_tracking' }))).toBe("You haven't joined this giveaway.")
    expect(giveawayError(httpError(403, { error: 'scene_pass_required' }))).toBe('Giveaways can only be claimed from inside the scene.')
    expect(giveawayError(httpError(429, { error: 'rate_limited' }))).toBe('Too many tries. Wait a moment.')
    expect(giveawayError(new TypeError('Failed to fetch'))).toBe("Couldn't reach Virvi. Check your connection and try again.")
    expect(giveawayError(new Error('boom'))).toBe('Something went wrong. Try again.')
  })
})
