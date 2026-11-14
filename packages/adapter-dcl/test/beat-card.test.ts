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
const claim = (status: NonNullable<VisitorBeat['myClaim']>['status'], secondsPresent = 0, txUrl: string | null = null) => ({ myClaim: { status, secondsPresent, txUrl } })
const ui = (over: Partial<BeatUi> = {}): BeatUi => ({ ...initialBeatUi(false), ...over })
const actions = (v: ReturnType<typeof cardView>) => v.actions.map((a) => `${a.id}:${a.label}`)
const httpError = (status: number, code: string) => new Error(`HTTP ${status}: ${JSON.stringify({ error: code })}`)

describe('BEAT card', () => {
  it('hidden: no BEAT', () => {
    expect(cardView(null, DURING, ui())).toMatchObject({ state: 'hidden', visible: false })
  })

  it('guest: the wallet notice until it has been shown, then hidden', () => {
    expect(cardView(beat(), DURING, ui({ guest: true }))).toMatchObject({ state: 'guest', visible: true, line: 'Connect a wallet to earn this BEAT', actions: [{ id: 'dismiss', label: 'OK' }] })
    expect(cardView(beat(), DURING, ui({ guest: true, noticeDone: true }))).toMatchObject({ state: 'hidden', visible: false })
  })

  it('offer: attend for N minutes, with Track my attendance', () => {
    const v = cardView(beat(), DURING, ui())
    expect(v).toMatchObject({ state: 'offer', visible: true, title: 'Launch', line: 'Attend for 5 minutes to earn the Launch BEAT', test: false })
    expect(actions(v)).toEqual(['track:Track my attendance'])
    expect(cardView(beat({ minPresentSeconds: 60 }), DURING, ui()).line).toBe('Attend for 1 minute to earn the Launch BEAT')
  })

  it('consent: the consent text before the confirm', () => {
    const v = cardView(beat(), DURING, ui({ view: 'consent' }))
    expect(v).toMatchObject({ state: 'consent', body: beatConsentText('Launch') })
    expect(actions(v)).toEqual(['confirm:Confirm', 'cancel:Cancel'])
    expect(cardView(beat(), DURING, ui({ view: 'consent', busy: true })).actions).toEqual([])
  })

  it('tracking: minutes present against the minimum, and Stop tracking', () => {
    const v = cardView(beat(claim('present', 130)), DURING, ui())
    expect(v).toMatchObject({ state: 'tracking', progress: { fraction: 130 / 300, label: '2 of 5 minutes' } })
    expect(actions(v)).toEqual(['stop:Stop tracking'])
  })

  it('claimable: Claim your BEAT, also after the end until the grace runs out', () => {
    expect(actions(cardView(beat(claim('present', 300)), DURING, ui()))).toEqual(['claim:Claim your BEAT'])
    expect(cardView(beat(claim('present', 300)), AFTER, ui()).state).toBe('claimable')
    expect(cardView(beat({ status: 'ended', ...claim('present', 300) }), AFTER, ui()).state).toBe('claimable')
    expect(cardView(beat(claim('present', 300)), CLAIM_UNTIL + 1, ui()).state).toBe('hidden')
  })

  it('pending: claimed or minting, even when sold out', () => {
    expect(cardView(beat(claim('claimed', 300)), DURING, ui())).toMatchObject({ state: 'pending', line: 'Sending your BEAT…', actions: [] })
    expect(cardView(beat(claim('minting', 300)), DURING, ui()).state).toBe('pending')
    expect(cardView(beat({ soldOut: true, ...claim('claimed', 300) }), DURING, ui()).state).toBe('pending')
  })

  it('minted: in your wallet, with the tx link when there is one', () => {
    const tx = 'https://amoy.polygonscan.com/tx/0xabc'
    const v = cardView(beat(claim('minted', 300, tx)), AFTER, ui())
    expect(v).toMatchObject({ state: 'minted', line: 'Your Launch BEAT is in your wallet', txUrl: tx })
    expect(actions(v)).toEqual(['view_tx:View on Polygonscan'])
    const noTx = cardView(beat(claim('minted', 300, null)), AFTER, ui())
    expect(noTx).toMatchObject({ state: 'minted', line: 'Your Launch BEAT is in your wallet', txUrl: null, actions: [] })
  })

  it('failed: we will retry', () => {
    expect(cardView(beat(claim('failed', 300)), DURING, ui())).toMatchObject({ state: 'failed', line: "We couldn't send your BEAT yet. We'll retry." })
  })

  it('soldOut: All claimed, when there is no claim', () => {
    expect(cardView(beat({ soldOut: true }), DURING, ui())).toMatchObject({ state: 'soldOut', line: 'All claimed', actions: [] })
    expect(cardView(beat({ soldOut: true, ...claim('present', 300) }), DURING, ui()).state).toBe('soldOut')
  })

  it('ended: a visitor who never reached the minimum', () => {
    expect(cardView(beat(), AFTER, ui())).toMatchObject({ state: 'ended', line: 'This BEAT has ended.', actions: [] })
    expect(cardView(beat(claim('present', 120)), AFTER, ui()).state).toBe('ended')
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
    const lines = ['no_wallet', 'bad_consent', 'too_late', 'too_early', 'not_yet', 'all_claimed', 'already_claimed', 'not_tracking', 'not_available', 'scene_pass_required']
      .map((c) => beatError(httpError(409, c)))
    expect(new Set(lines).size).toBe(lines.length)
    for (const l of lines) expect(l).not.toBe('Something went wrong. Try again.')
    expect(beatError(httpError(403, 'no_wallet'))).toBe('Connect a wallet to earn this BEAT.')
    expect(beatError(httpError(409, 'too_late'), 'claim')).toBe('The time to claim this BEAT is over.')
  })

  it('anything else is a generic line', () => {
    expect(beatError(httpError(500, 'boom'))).toBe('Something went wrong. Try again.')
    expect(beatError(new Error('offline'))).toBe('Something went wrong. Try again.')
  })
})
