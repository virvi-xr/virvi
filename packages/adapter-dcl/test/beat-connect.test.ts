import { describe, it, expect, vi, beforeEach } from 'vitest'
import { CHECKIN_INTERVAL_MS, type AvailableBeat, type VisitorBeat } from '@virvixr/shared'
import { cardView, type BeatUi } from '../src/beat/card.js'

// The overlay draws with @dcl/sdk; here it only records what it would draw
const overlay = vi.hoisted(() => ({ card: null as null | { beat: VisitorBeat | AvailableBeat | null; ui: BeatUi }, handler: null as null | ((a: string) => void), mounted: 0 }))
vi.mock('../src/beat/BeatOverlay.js', () => ({
  setBeatCard: (c: { beat: VisitorBeat | AvailableBeat | null; ui: BeatUi }) => { overlay.card = c },
  setBeatCardHandler: (h: (a: string) => void) => { overlay.handler = h },
  mountBeatOverlay: () => { overlay.mounted++ },
}))

import { GUEST_NOTICE_MS, startSceneBeats } from '../src/beat/connect.js'

const NOW = Date.parse('2026-11-14T10:30:00.000Z')
const beat = (over: Partial<VisitorBeat> = {}): VisitorBeat => ({
  id: 'b1', name: 'Launch', imageUrl: '', startsAt: '2026-11-14T10:00:00.000Z', endsAt: '2026-11-14T12:00:00.000Z',
  minPresentSeconds: 300, status: 'live', soldOut: false, claimUntil: '2026-11-15T12:00:00.000Z', test: false, autoClaim: false, myClaim: null, ...over,
})
const present = (secondsPresent: number) => ({ myClaim: { status: 'present' as const, secondsPresent, txUrl: null, final: false, heldUntil: null } })
const httpError = (status: number, code: string) => new Error(`HTTP ${status}: ${JSON.stringify({ error: code })}`)
const flush = () => new Promise((r) => setTimeout(r, 0))
const state = () => cardView(overlay.card!.beat, NOW, overlay.card!.ui).state

function setup(guest = false) {
  const on: ((s: string) => void)[] = []
  const available: ((b: AvailableBeat | null) => void)[] = []
  const virvi = {
    onStateChange: (fn: any) => { on.push(fn); return () => {} },
    onBeatAvailable: (fn: any) => { available.push(fn); return () => { available.splice(available.indexOf(fn), 1) } },
    currentBeat: vi.fn(async () => ({ beat: beat() as VisitorBeat | null })),
    trackBeat: vi.fn(async () => ({ beat: beat(present(0)) })),
    beatCheckIn: vi.fn(async () => ({ beat: beat(present(30)) })),
    claimBeat: vi.fn(async () => ({ beat: beat({ myClaim: { status: 'claimed', secondsPresent: 300, txUrl: null, final: false, heldUntil: null } }) })),
    stopTrackingBeat: vi.fn(async () => {}),
  }
  const systems: ((dt: number) => void)[] = []
  const openUrl = vi.fn()
  const dispose = startSceneBeats(virvi as any, {
    registerSystem: (fn) => { systems.push(fn) },
    unregisterSystem: (fn) => { systems.splice(systems.indexOf(fn), 1) },
  }, { guest, hud: null, openUrl, now: () => NOW })
  const tick = (seconds: number) => systems.forEach((fn) => fn(seconds))
  const connect = () => on.forEach((fn) => fn('connected'))
  const emitState = (st: string) => on.forEach((fn) => fn(st))
  const announce = (b: AvailableBeat | null) => available.forEach((fn) => fn(b))
  const httpCalls = () => [virvi.currentBeat, virvi.trackBeat, virvi.beatCheckIn, virvi.claimBeat, virvi.stopTrackingBeat].reduce((n, f) => n + f.mock.calls.length, 0)
  return { virvi, tick, connect, dispose, openUrl, systems, emitState, announce, httpCalls }
}

describe('startSceneBeats', () => {
  beforeEach(() => { overlay.card = null; overlay.handler = null })

  it('reads the current BEAT on connect and every CHECKIN_INTERVAL_MS', async () => {
    const t = setup()
    t.tick(CHECKIN_INTERVAL_MS / 1000)
    expect(t.virvi.currentBeat).not.toHaveBeenCalled() // not connected yet
    t.connect()
    await flush()
    expect(t.virvi.currentBeat).toHaveBeenCalledTimes(1)
    expect(state()).toBe('offer')
    t.tick(CHECKIN_INTERVAL_MS / 2000)
    await flush()
    expect(t.virvi.currentBeat).toHaveBeenCalledTimes(1)
    t.tick(CHECKIN_INTERVAL_MS / 2000)
    await flush()
    expect(t.virvi.currentBeat).toHaveBeenCalledTimes(2)
    expect(t.virvi.beatCheckIn).not.toHaveBeenCalled()
  })

  it('switches from currentBeat polling to check-ins once tracking, and uses the BEAT they return', async () => {
    const t = setup()
    t.connect()
    await flush()
    overlay.handler!('track')
    expect(state()).toBe('consent')
    overlay.handler!('confirm')
    await flush()
    expect(t.virvi.trackBeat).toHaveBeenCalledWith('b1')
    expect(state()).toBe('tracking')
    t.tick(CHECKIN_INTERVAL_MS / 1000)
    await flush()
    expect(t.virvi.beatCheckIn).toHaveBeenCalledWith('b1')
    expect(t.virvi.currentBeat).toHaveBeenCalledTimes(1)
    expect(overlay.card!.beat!.myClaim!.secondsPresent).toBe(30)
    // Reached the minimum: back to reading, and Claim your BEAT
    t.virvi.beatCheckIn.mockResolvedValueOnce({ beat: beat(present(300)) })
    t.tick(CHECKIN_INTERVAL_MS / 1000)
    await flush()
    expect(state()).toBe('claimable')
    t.virvi.currentBeat.mockResolvedValue({ beat: beat(present(300)) })
    t.tick(CHECKIN_INTERVAL_MS / 1000)
    await flush()
    expect(t.virvi.beatCheckIn).toHaveBeenCalledTimes(2)
    expect(t.virvi.currentBeat).toHaveBeenCalledTimes(2)
    overlay.handler!('claim')
    await flush()
    expect(t.virvi.claimBeat).toHaveBeenCalledWith('b1')
    expect(state()).toBe('pending')
  })

  it('a check-in that says not_tracking drops the claim', async () => {
    const t = setup()
    t.virvi.currentBeat.mockResolvedValue({ beat: beat(present(60)) })
    t.connect()
    await flush()
    t.virvi.beatCheckIn.mockRejectedValueOnce(httpError(404, 'not_tracking'))
    t.virvi.currentBeat.mockResolvedValue({ beat: beat() })
    t.tick(CHECKIN_INTERVAL_MS / 1000)
    await flush()
    await flush()
    expect(state()).toBe('offer')
  })

  it('a failed opt-in shows its line', async () => {
    const t = setup()
    t.connect()
    await flush()
    t.virvi.trackBeat.mockRejectedValueOnce(httpError(403, 'no_wallet'))
    overlay.handler!('track')
    overlay.handler!('confirm')
    await flush()
    expect(overlay.card!.ui.note).toBe("Sign in to Decentraland with a wallet to earn this BEAT. Guests can't.")
    expect(state()).toBe('offer')
  })

  it('Stop tracking goes back to the offer', async () => {
    const t = setup()
    t.virvi.currentBeat.mockResolvedValue({ beat: beat(present(60)) })
    t.connect()
    await flush()
    overlay.handler!('stop')
    await flush()
    expect(t.virvi.stopTrackingBeat).toHaveBeenCalledWith('b1')
    expect(state()).toBe('offer')
  })

  it('plain-ux I1: Stop tracking also works once claimable', async () => {
    const t = setup()
    t.virvi.currentBeat.mockResolvedValue({ beat: beat(present(600)) })
    t.connect()
    await flush()
    expect(state()).toBe('claimable')
    overlay.handler!('stop')
    await flush()
    expect(t.virvi.stopTrackingBeat).toHaveBeenCalledWith('b1')
    expect(state()).toBe('offer')
  })

  it('opens the tx on Polygonscan', async () => {
    const t = setup()
    const tx = 'https://polygonscan.com/tx/0xabc'
    t.virvi.currentBeat.mockResolvedValue({ beat: beat({ myClaim: { status: 'minted', secondsPresent: 300, txUrl: tx, final: false, heldUntil: null } }) })
    t.connect()
    await flush()
    overlay.handler!('view_tx')
    expect(t.openUrl).toHaveBeenCalledWith(tx)
  })

  it('never has two requests in flight: a tick while one is pending is skipped', async () => {
    const t = setup()
    let release: (v: { beat: VisitorBeat | null }) => void = () => {}
    t.virvi.currentBeat.mockImplementationOnce(() => new Promise((r) => { release = r }))
    t.connect()
    t.tick(CHECKIN_INTERVAL_MS / 1000)
    t.connect()
    await flush()
    expect(t.virvi.currentBeat).toHaveBeenCalledTimes(1)
    release({ beat: beat() })
    await flush()
    t.tick(CHECKIN_INTERVAL_MS / 1000)
    await flush()
    expect(t.virvi.currentBeat).toHaveBeenCalledTimes(2)
  })

  it('a guest makes no BEAT HTTP calls and sees the wallet notice from beat_available, once per BEAT', async () => {
    const t = setup(true)
    t.connect()
    await flush()
    expect(state()).toBe('hidden')
    t.announce({ name: 'Launch', test: true })
    expect(state()).toBe('guest')
    expect(cardView(overlay.card!.beat, NOW, overlay.card!.ui)).toMatchObject({ line: "Sign in to Decentraland with a wallet to earn this BEAT. Guests can't.", test: true })
    overlay.handler!('dismiss')
    expect(state()).toBe('hidden')
    // The same BEAT again (a reconnect): no second notice
    t.announce({ name: 'Launch', test: true })
    expect(state()).toBe('hidden')
    for (let i = 0; i < 4; i++) t.tick(CHECKIN_INTERVAL_MS / 1000)
    t.connect()
    await flush()
    // Another BEAT gets its own notice
    t.announce({ name: 'Closing night', test: false })
    expect(state()).toBe('guest')
    t.announce(null)
    expect(state()).toBe('hidden')
    expect(t.httpCalls()).toBe(0)
  })

  it("the guest notice hides by itself after GUEST_NOTICE_MS", () => {
    const t = setup(true)
    t.announce({ name: 'Launch', test: false })
    t.tick(GUEST_NOTICE_MS / 1000 - 1)
    expect(state()).toBe('guest')
    t.tick(1)
    expect(state()).toBe('hidden')
  })

  it('signed-in visitors ignore beat_available and keep using HTTP', async () => {
    const t = setup()
    t.announce({ name: 'Other', test: false })
    expect(overlay.card!.beat).toBeNull()
    t.connect()
    await flush()
    expect(t.virvi.currentBeat).toHaveBeenCalledTimes(1)
    expect(overlay.card!.beat).toMatchObject({ id: 'b1' })
  })

  it('a press while a poll is in flight waits for it, then runs', async () => {
    const t = setup()
    t.connect()
    await flush()
    let release: (v: { beat: VisitorBeat | null }) => void = () => {}
    t.virvi.currentBeat.mockImplementationOnce(() => new Promise((r) => { release = r }))
    t.tick(CHECKIN_INTERVAL_MS / 1000)
    overlay.handler!('track')
    overlay.handler!('confirm')
    await flush()
    expect(t.virvi.trackBeat).not.toHaveBeenCalled()
    expect(overlay.card!.ui.busy).toBe(true)
    release({ beat: beat() })
    await flush()
    await flush()
    expect(t.virvi.trackBeat).toHaveBeenCalledWith('b1')
    expect(state()).toBe('tracking')
  })

  it('a queued press is dropped when the poll brings another BEAT', async () => {
    const t = setup()
    t.connect()
    await flush()
    let release: (v: { beat: VisitorBeat | null }) => void = () => {}
    t.virvi.currentBeat.mockImplementationOnce(() => new Promise((r) => { release = r }))
    t.tick(CHECKIN_INTERVAL_MS / 1000)
    overlay.handler!('track')
    overlay.handler!('confirm')
    release({ beat: beat({ id: 'b2' }) })
    await flush()
    await flush()
    expect(t.virvi.trackBeat).not.toHaveBeenCalled()
    expect(state()).toBe('offer')
    expect(overlay.card!.ui.busy).toBe(false)
  })

  it('a Virvi destroyed before it connects stops too', () => {
    const t = setup()
    t.emitState('idle')
    expect(t.systems).toHaveLength(0)
  })

  it('a throwing openUrl is caught', async () => {
    const t = setup()
    t.openUrl.mockImplementation(() => { throw new Error('no runtime') })
    t.virvi.currentBeat.mockResolvedValue({ beat: beat({ myClaim: { status: 'minted', secondsPresent: 300, txUrl: 'https://polygonscan.com/tx/0x1', final: false, heldUntil: null } }) })
    t.connect()
    await flush()
    expect(() => overlay.handler!('view_tx')).not.toThrow()
  })

  it('stops on dispose: no more requests, late responses ignored', async () => {
    const t = setup()
    let release: (v: { beat: VisitorBeat | null }) => void = () => {}
    t.virvi.currentBeat.mockImplementationOnce(() => new Promise((r) => { release = r }))
    t.connect()
    t.dispose()
    expect(t.systems).toHaveLength(0)
    const before = overlay.card
    expect(before!.beat).toBeNull()
    release({ beat: beat(present(60)) })
    await flush()
    expect(overlay.card).toBe(before)
    t.tick(CHECKIN_INTERVAL_MS / 1000)
    t.connect()
    await flush()
    expect(t.virvi.currentBeat).toHaveBeenCalledTimes(1)
  })
})
