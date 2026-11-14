import { describe, it, expect, vi, beforeEach } from 'vitest'
import { CHECKIN_INTERVAL_MS, type VisitorBeat } from '@virvixr/shared'
import { cardView, type BeatUi } from '../src/beat/card.js'

// The overlay draws with @dcl/sdk; here it only records what it would draw
const overlay = vi.hoisted(() => ({ card: null as null | { beat: VisitorBeat | null; ui: BeatUi }, handler: null as null | ((a: string) => void), mounted: 0 }))
vi.mock('../src/beat/BeatOverlay.js', () => ({
  setBeatCard: (c: { beat: VisitorBeat | null; ui: BeatUi }) => { overlay.card = c },
  setBeatCardHandler: (h: (a: string) => void) => { overlay.handler = h },
  mountBeatOverlay: () => { overlay.mounted++ },
}))

import { startSceneBeats } from '../src/beat/connect.js'

const NOW = Date.parse('2026-11-14T10:30:00.000Z')
const beat = (over: Partial<VisitorBeat> = {}): VisitorBeat => ({
  id: 'b1', name: 'Launch', imageUrl: '', startsAt: '2026-11-14T10:00:00.000Z', endsAt: '2026-11-14T12:00:00.000Z',
  minPresentSeconds: 300, status: 'live', soldOut: false, claimUntil: '2026-11-15T12:00:00.000Z', test: false, myClaim: null, ...over,
})
const present = (secondsPresent: number) => ({ myClaim: { status: 'present' as const, secondsPresent, txUrl: null } })
const httpError = (status: number, code: string) => new Error(`HTTP ${status}: ${JSON.stringify({ error: code })}`)
const flush = () => new Promise((r) => setTimeout(r, 0))
const state = () => cardView(overlay.card!.beat, NOW, overlay.card!.ui).state

function setup(guest = false) {
  const on: ((s: string) => void)[] = []
  const virvi = {
    onStateChange: (fn: any) => { on.push(fn); return () => {} },
    currentBeat: vi.fn(async () => ({ beat: beat() as VisitorBeat | null })),
    trackBeat: vi.fn(async () => ({ beat: beat(present(0)) })),
    beatCheckIn: vi.fn(async () => ({ beat: beat(present(30)) })),
    claimBeat: vi.fn(async () => ({ beat: beat({ myClaim: { status: 'claimed', secondsPresent: 300, txUrl: null } }) })),
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
  return { virvi, tick, connect, dispose, openUrl, systems }
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
    expect(overlay.card!.ui.note).toBe('Connect a wallet to earn this BEAT.')
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

  it('opens the tx on Polygonscan', async () => {
    const t = setup()
    const tx = 'https://polygonscan.com/tx/0xabc'
    t.virvi.currentBeat.mockResolvedValue({ beat: beat({ myClaim: { status: 'minted', secondsPresent: 300, txUrl: tx } }) })
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

  it('a guest sees the wallet notice once per BEAT, then the card hides', async () => {
    const t = setup(true)
    t.connect()
    await flush()
    expect(state()).toBe('guest')
    overlay.handler!('dismiss')
    expect(state()).toBe('hidden')
    t.tick(CHECKIN_INTERVAL_MS / 1000)
    await flush()
    expect(state()).toBe('hidden')
    // Another BEAT gets its own notice
    t.virvi.currentBeat.mockResolvedValue({ beat: beat({ id: 'b2' }) })
    t.tick(CHECKIN_INTERVAL_MS / 1000)
    await flush()
    expect(state()).toBe('guest')
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
