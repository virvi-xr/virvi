import { describe, it, expect } from 'vitest'
import { beatConsentText, type VisitorBeat } from '@virvixr/shared'
import { beatError, cardView, GuestNotice, initialBeatUi, type BeatUi } from '../src/beat/card.js'

const START = Date.parse('2026-11-14T10:00:00.000Z')
const END = Date.parse('2026-11-14T12:00:00.000Z')
const CLAIM_UNTIL = Date.parse('2026-11-15T12:00:00.000Z')
const DURING = START + 30 * 60_000
const AFTER = END + 60_000

const beat = (over: Partial<VisitorBeat> = {}): VisitorBeat => ({
  id: 'b1', name: 'Launch', imageUrl: 'https://img.example/b1.png', startsAt: new Date(START).toISOString(), endsAt: new Date(END).toISOString(),
  minPresentSeconds: 300, status: 'live', soldOut: false, claimUntil: new Date(CLAIM_UNTIL).toISOString(), test: false, myClaim: null, ...over,
})
const claim = (status: NonNullable<VisitorBeat['myClaim']>['status'], secondsPresent = 0, txUrl: string | null = null, more: { final?: boolean; heldUntil?: string | null } = {}) =>
  ({ myClaim: { status, secondsPresent, txUrl, final: more.final ?? false, heldUntil: more.heldUntil ?? null } })
const ui = (over: Partial<BeatUi> = {}): BeatUi => ({ ...initialBeatUi(false), ...over })
const actions = (v: ReturnType<typeof cardView>) => v.actions.map((a) => `${a.id}:${a.label}`)
const httpError = (status: number, code: string) => new Error(`HTTP ${status}: ${JSON.stringify({ error: code })}`)
const STORED = 'Your wallet and name are still saved for this BEAT. Stop tracking to delete them.'

describe('BEAT card', () => {
  it('hidden: no BEAT', () => {
    expect(cardView(null, DURING, ui())).toMatchObject({ state: 'hidden', visible: false })
  })

  it('guest: the wallet notice (how to take part) until it has been shown, then hidden', () => {
    expect(cardView(beat(), DURING, ui({ guest: true }))).toMatchObject({
      state: 'guest', visible: true, line: "Sign in to Decentraland with a wallet to earn this BEAT. Guests can't.", actions: [{ id: 'dismiss', label: 'OK' }],
    })
    expect(cardView(beat(), DURING, ui({ guest: true, noticeDone: true }))).toMatchObject({ state: 'hidden', visible: false })
  })

  it('offer: stay for N minutes, with Track my attendance', () => {
    const v = cardView(beat(), DURING, ui())
    expect(v).toMatchObject({ state: 'offer', visible: true, title: 'Launch', line: 'Stay for 5 minutes to earn the BEAT.', test: false })
    expect(actions(v)).toEqual(['track:Track my attendance'])
    expect(cardView(beat({ minPresentSeconds: 60 }), DURING, ui()).line).toBe('Stay for 1 minute to earn the BEAT.')
  })

  it('plain-ux I6: before the start the offer says when it starts and that time counts from then', () => {
    expect(cardView(beat(), START - 20 * 60_000, ui()).line).toBe('Stay for 5 minutes to earn the BEAT. It starts at 10:00 AM UTC, and your time counts once it starts.')
  })

  it('plain-ux I7: a 0-minute BEAT asks only to be there, and is not claimable before its start', () => {
    expect(cardView(beat({ minPresentSeconds: 0 }), DURING, ui()).line).toBe('Be there to earn the BEAT.')
    expect(cardView(beat({ minPresentSeconds: 0, ...claim('present', 0) }), START - 60_000, ui()).state).toBe('tracking')
    expect(cardView(beat({ minPresentSeconds: 0, ...claim('present', 0) }), DURING, ui()).state).toBe('claimable')
  })

  it('M11: a practice BEAT says so', () => {
    expect(cardView(beat({ test: true }), DURING, ui()).line).toBe('Stay for 5 minutes to earn the BEAT. This is a practice BEAT.')
  })

  it('consent: the consent text before I agree', () => {
    const v = cardView(beat(), DURING, ui({ view: 'consent' }))
    expect(v).toMatchObject({ state: 'consent', body: beatConsentText('Launch') })
    expect(actions(v)).toEqual(['confirm:I agree', 'cancel:Cancel'])
  })

  it('M4: while busy the buttons go and the card says it is working', () => {
    expect(cardView(beat(), DURING, ui({ view: 'consent', busy: true }))).toMatchObject({ actions: [], line: 'Working…' })
    expect(cardView(beat(claim('present', 300)), DURING, ui({ busy: true }))).toMatchObject({ actions: [], line: 'Working…' })
  })

  it('tracking: minutes present against the minimum, when time counts, and Stop tracking', () => {
    const v = cardView(beat(claim('present', 130)), DURING, ui())
    expect(v).toMatchObject({ state: 'tracking', line: 'Time counts while the event is running.', progress: { fraction: 130 / 300, label: '2 of 5 minutes' } })
    expect(actions(v)).toEqual(['stop:Stop tracking'])
    expect(cardView(beat(claim('present', 0)), START - 20 * 60_000, ui()).line).toBe('This BEAT starts at 10:00 AM UTC. Your time counts once it starts.')
  })

  it('claimable: Claim your BEAT (and Stop tracking), until when, also after the end until the grace runs out', () => {
    const v = cardView(beat(claim('present', 300)), DURING, ui())
    expect(actions(v)).toEqual(['claim:Claim your BEAT', 'stop:Stop tracking'])
    expect(v.line).toBe("You've been here long enough. Claim your BEAT before Nov 15, 12:00 PM UTC. Claiming sends it to your wallet, and it's recorded publicly on Polygon.")
    expect(cardView(beat(claim('present', 300)), CLAIM_UNTIL - 60 * 60_000, ui()).line).toContain('Claiming closes at 12:00 PM UTC.')
    expect(cardView(beat(claim('present', 300)), AFTER, ui()).state).toBe('claimable')
    expect(cardView(beat({ status: 'ended', ...claim('present', 300) }), AFTER, ui()).state).toBe('claimable')
    expect(cardView(beat(claim('present', 300)), CLAIM_UNTIL + 1, ui()).state).toBe('hidden')
  })

  it('pending: claimed or minting, even when sold out; a held claim says the host checks it and by when', () => {
    expect(cardView(beat(claim('claimed', 300)), DURING, ui())).toMatchObject({
      state: 'pending', line: 'Sending your BEAT. This usually takes a few minutes, and you can leave the scene.', actions: [],
    })
    expect(cardView(beat(claim('minting', 300)), DURING, ui()).state).toBe('pending')
    expect(cardView(beat({ soldOut: true, ...claim('claimed', 300) }), DURING, ui()).state).toBe('pending')
    expect(cardView(beat(claim('claimed', 300, null, { heldUntil: new Date(CLAIM_UNTIL).toISOString() })), DURING, ui()).line)
      .toBe("The host checks claims before they're sent. Your BEAT is sent once they do, by Nov 15, 12:00 PM UTC at the latest. You can leave the scene.")
  })

  it('minted: in your wallet, with the tx link when there is one', () => {
    const tx = 'https://amoy.polygonscan.com/tx/0xabc'
    const v = cardView(beat(claim('minted', 300, tx)), AFTER, ui())
    expect(v).toMatchObject({ state: 'minted', line: 'Your Launch BEAT is in your wallet', txUrl: tx })
    expect(actions(v)).toEqual(['view_tx:See it on Polygonscan'])
    const noTx = cardView(beat(claim('minted', 300, null)), AFTER, ui())
    expect(noTx).toMatchObject({ state: 'minted', line: 'Your Launch BEAT is in your wallet', txUrl: null, actions: [] })
  })

  it('plain-ux I2: failed says we keep trying, or for a final failure that we stopped and to ask the host', () => {
    expect(cardView(beat(claim('failed', 300)), DURING, ui())).toMatchObject({ state: 'failed', line: "We couldn't send your BEAT yet. We'll keep trying, so check back later." })
    expect(cardView(beat(claim('failed', 300, null, { final: true })), DURING, ui()).line)
      .toBe("We couldn't send this BEAT to your wallet, and we've stopped trying. Please ask the event host for help.")
  })

  it('removed: the host took the claim out', () => {
    expect(cardView(beat(claim('removed', 300)), DURING, ui())).toMatchObject({
      state: 'removed', line: "The event host removed your claim, so this BEAT won't be sent to you. Ask the host if you think this is a mistake.", actions: [],
    })
  })

  it('plain-ux I1: soldOut: All claimed; a tracking visitor is told what is stored and can still stop', () => {
    expect(cardView(beat({ soldOut: true }), DURING, ui())).toMatchObject({ state: 'soldOut', line: 'All claimed', actions: [] })
    const v = cardView(beat({ soldOut: true, ...claim('present', 300) }), DURING, ui())
    expect(v).toMatchObject({ state: 'soldOut', line: `All claimed. ${STORED}` })
    expect(actions(v)).toEqual(['stop:Stop tracking'])
  })

  it('plain-ux I1: ended: a visitor who never reached the minimum can still stop tracking', () => {
    expect(cardView(beat(), AFTER, ui())).toMatchObject({ state: 'ended', line: 'This BEAT has ended.', actions: [] })
    const v = cardView(beat(claim('present', 120)), AFTER, ui())
    expect(v).toMatchObject({ state: 'ended', line: `This BEAT has ended. ${STORED}` })
    expect(actions(v)).toEqual(['stop:Stop tracking'])
    expect(cardView(beat({ status: 'ended' }), DURING, ui()).state).toBe('ended')
  })

  it('a test BEAT shows the Test label', () => {
    expect(cardView(beat({ test: true }), DURING, ui()).test).toBe(true)
  })

  it('shows the last note', () => {
    expect(cardView(beat(), DURING, ui({ note: 'Nope' })).note).toBe('Nope')
  })
})

describe('GuestNotice', () => {
  it('shows once per BEAT for the session, until dismissed or timed out', () => {
    const n = new GuestNotice(10_000)
    expect(n.done('b1')).toBe(false)
    n.tick('b1', 4)
    expect(n.done('b1')).toBe(false)
    n.tick('b1', 7)
    expect(n.done('b1')).toBe(true)
    expect(n.done('b2')).toBe(false)
    n.dismiss('b2')
    expect(n.done('b2')).toBe(true)
  })
})

describe('beatError', () => {
  it('maps the server codes to plain lines', () => {
    const codes = ['no_wallet', 'bad_consent', 'too_late', 'too_early', 'not_started', 'not_yet', 'all_claimed', 'already_claimed', 'not_tracking', 'not_available',
      'scene_pass_required', 'profile_required', 'too_many_from_network', 'too_many_new_wallets', 'wallet_blocked']
    const lines = codes.map((c) => beatError(httpError(409, c)))
    expect(new Set(lines).size).toBe(lines.length)
    for (const l of lines) expect(l).not.toBe('Something went wrong. Try again.')
    expect(beatError(httpError(403, 'no_wallet'))).toBe("Sign in to Decentraland with a wallet to earn this BEAT. Guests can't.")
    expect(beatError(httpError(400, 'bad_consent'))).toBe("This BEAT's terms have changed. Reload the scene and try again.")
    expect(beatError(httpError(409, 'not_available'))).toBe("You stopped tracking this BEAT, so you can't start again.")
    expect(beatError(httpError(409, 'not_started'), 'claim')).toBe("This event hasn't started yet. Claim once it starts.")
    expect(beatError(httpError(409, 'too_late'), 'claim')).toBe('The time to claim this BEAT is over.')
  })

  it('a request that never got an answer says so; anything else is a generic line', () => {
    expect(beatError(new TypeError('Failed to fetch'))).toBe("Couldn't reach Virvi. Check your connection and try again.")
    expect(beatError(httpError(500, 'boom'))).toBe('Something went wrong. Try again.')
    expect(beatError(new Error('boom'))).toBe('Something went wrong. Try again.')
  })
})
