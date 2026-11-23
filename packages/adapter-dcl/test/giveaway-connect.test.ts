import { describe, it, expect, vi, beforeEach } from 'vitest'
import { CHECKIN_INTERVAL_MS, type AvailableGiveaway, type VisitorGiveaway } from '@virvixr/shared'
import { giveawayCardView, type GiveawayUi } from '../src/giveaway/card.js'

// The overlay draws with @dcl/sdk; here it only records what it would draw
type Card = { giveaway: VisitorGiveaway | AvailableGiveaway | null; ui: GiveawayUi }
const overlay = vi.hoisted(() => ({ card: null as null | Card, handler: null as null | ((a: string) => void), mounted: 0 }))
vi.mock('../src/giveaway/GiveawayOverlay.js', () => ({
  setGiveawayCard: (c: Card) => { overlay.card = c },
  setGiveawayCardHandler: (h: (a: string) => void) => { overlay.handler = h },
  mountGiveawayOverlay: () => { overlay.mounted++ },
}))

import { GUEST_NOTICE_MS, startSceneGiveaways } from '../src/giveaway/connect.js'

const WALLET = '0xabcdef0123456789abcdef0123456789abcdef12'
const giveaway = (over: Partial<VisitorGiveaway> = {}): VisitorGiveaway => ({
  id: 'g1', name: 'Winter drop', items: [{ name: 'Scarf', thumbnail: null, rarity: null }], endsAt: null, minPresentSeconds: 300, test: false, claim: null, ...over,
})
const claim = (status: NonNullable<VisitorGiveaway['claim']>['status'], secondsPresent = 0, txUrl: string | null = null) =>
  ({ claim: { status, secondsPresent, txUrl, failReason: null, delayed: false } })
const httpError = (status: number, body: Record<string, unknown>) => new Error(`HTTP ${status}: ${JSON.stringify(body)}`)
const flush = () => new Promise((r) => setTimeout(r, 0))
const clock = { ms: Date.parse('2026-11-23T10:00:00.000Z') }
const view = () => giveawayCardView(overlay.card!.giveaway, overlay.card!.ui, clock.ms)
const state = () => view().state

function setup(guest = false) {
  const on: ((s: string) => void)[] = []
  const available: ((g: AvailableGiveaway | null) => void)[] = []
  const virvi = {
    onStateChange: (fn: any) => { on.push(fn); return () => {} },
    onGiveawayAvailable: (fn: any) => { available.push(fn); return () => { available.splice(available.indexOf(fn), 1) } },
    currentGiveaway: vi.fn(async () => ({ giveaway: giveaway() as VisitorGiveaway | null })),
    trackGiveaway: vi.fn(async () => ({ giveaway: giveaway(claim('present')) })),
    giveawayCheckIn: vi.fn(async () => ({ giveaway: giveaway(claim('present', 30)) })),
    claimGiveaway: vi.fn(async () => ({ giveaway: giveaway(claim('waiting', 300)) })),
    stopGiveaway: vi.fn(async () => {}),
  }
  const systems: ((dt: number) => void)[] = []
  const openUrl = vi.fn()
  const dispose = startSceneGiveaways(virvi as any, {
    registerSystem: (fn) => { systems.push(fn) },
    unregisterSystem: (fn) => { systems.splice(systems.indexOf(fn), 1) },
  }, { guest, wallet: guest ? null : WALLET, hud: null, openUrl, now: () => clock.ms })
  const tick = (seconds: number) => systems.forEach((fn) => fn(seconds))
  const connect = () => on.forEach((fn) => fn('connected'))
  const emitState = (st: string) => on.forEach((fn) => fn(st))
  const announce = (g: AvailableGiveaway | null) => available.forEach((fn) => fn(g))
  const httpCalls = () => [virvi.currentGiveaway, virvi.trackGiveaway, virvi.giveawayCheckIn, virvi.claimGiveaway, virvi.stopGiveaway]
    .reduce((n, f) => n + f.mock.calls.length, 0)
  return { virvi, tick, connect, dispose, openUrl, systems, emitState, announce, httpCalls }
}

describe('startSceneGiveaways (LIV-194)', () => {
  beforeEach(() => { overlay.card = null; overlay.handler = null })

  it('reads the current giveaway on connect and every CHECKIN_INTERVAL_MS', async () => {
    const t = setup()
    expect(overlay.mounted).toBeGreaterThan(0)
    t.tick(CHECKIN_INTERVAL_MS / 1000)
    expect(t.virvi.currentGiveaway).not.toHaveBeenCalled() // not connected yet
    t.connect()
    await flush()
    expect(t.virvi.currentGiveaway).toHaveBeenCalledTimes(1)
    expect(state()).toBe('consent')
    expect(view().notice).toContain('0xabcd…ef12')
    t.tick(CHECKIN_INTERVAL_MS / 2000)
    await flush()
    expect(t.virvi.currentGiveaway).toHaveBeenCalledTimes(1)
    t.tick(CHECKIN_INTERVAL_MS / 2000)
    await flush()
    expect(t.virvi.currentGiveaway).toHaveBeenCalledTimes(2)
    expect(t.virvi.giveawayCheckIn).not.toHaveBeenCalled()
  })

  it('agree, check in while present, then claim: On its way.', async () => {
    const t = setup()
    t.connect()
    await flush()
    overlay.handler!('agree')
    await flush()
    expect(t.virvi.trackGiveaway).toHaveBeenCalledWith('g1')
    expect(state()).toBe('present')
    t.tick(CHECKIN_INTERVAL_MS / 1000)
    await flush()
    expect(t.virvi.giveawayCheckIn).toHaveBeenCalledWith('g1')
    expect(t.virvi.currentGiveaway).toHaveBeenCalledTimes(1)
    expect(view().line).toBe('Stay 4:30 more to claim.')
    // Reached the minimum: back to reading, and Claim
    t.virvi.giveawayCheckIn.mockResolvedValueOnce({ giveaway: giveaway(claim('present', 300)) })
    t.tick(CHECKIN_INTERVAL_MS / 1000)
    await flush()
    expect(state()).toBe('ready')
    t.virvi.currentGiveaway.mockResolvedValue({ giveaway: giveaway(claim('present', 300)) })
    t.tick(CHECKIN_INTERVAL_MS / 1000)
    await flush()
    expect(t.virvi.giveawayCheckIn).toHaveBeenCalledTimes(2)
    expect(t.virvi.currentGiveaway).toHaveBeenCalledTimes(2)
    overlay.handler!('claim')
    await flush()
    expect(t.virvi.claimGiveaway).toHaveBeenCalledWith('g1')
    expect(view()).toMatchObject({ state: 'sending', line: 'On its way.' })
  })

  it('a claim press does nothing before it is ready', async () => {
    const t = setup()
    t.virvi.currentGiveaway.mockResolvedValue({ giveaway: giveaway(claim('present', 60)) })
    t.connect()
    await flush()
    overlay.handler!('claim')
    await flush()
    expect(t.virvi.claimGiveaway).not.toHaveBeenCalled()
  })

  it('a refused claim shows its line and reads the giveaway again', async () => {
    const t = setup()
    t.virvi.currentGiveaway.mockResolvedValue({ giveaway: giveaway(claim('present', 300)) })
    t.connect()
    await flush()
    t.virvi.claimGiveaway.mockRejectedValueOnce(httpError(409, { error: 'too_soon', secondsLeft: 20 }))
    overlay.handler!('claim')
    await flush()
    await flush()
    expect(overlay.card!.ui.note).toBe('Stay 0:20 more to claim.')
    expect(overlay.card!.ui.busy).toBe(false)
    expect(t.virvi.currentGiveaway).toHaveBeenCalledTimes(2)
  })

  it('a refused agree shows its line and stays on the consent', async () => {
    const t = setup()
    t.connect()
    await flush()
    t.virvi.trackGiveaway.mockRejectedValueOnce(httpError(403, { error: 'wallet_blocked' }))
    overlay.handler!('agree')
    await flush()
    expect(overlay.card!.ui.note).toBe("This wallet can't claim giveaways any more.")
    expect(state()).toBe('consent')
  })

  it('a check-in that says not_tracking drops the claim', async () => {
    const t = setup()
    t.virvi.currentGiveaway.mockResolvedValue({ giveaway: giveaway(claim('present', 60)) })
    t.connect()
    await flush()
    t.virvi.giveawayCheckIn.mockRejectedValueOnce(httpError(404, { error: 'not_tracking' }))
    t.tick(CHECKIN_INTERVAL_MS / 1000)
    await flush()
    expect(state()).toBe('consent')
  })

  it('Stop tracking withdraws: the card goes back to the consent', async () => {
    for (const seconds of [60, 300]) {
      const t = setup()
      t.virvi.currentGiveaway.mockResolvedValue({ giveaway: giveaway(claim('present', seconds)) })
      t.connect()
      await flush()
      expect(view().actions.map((a) => a.id)).toContain('stop')
      overlay.handler!('stop')
      expect(view().line).toBe('Working…')
      await flush()
      expect(t.virvi.stopGiveaway).toHaveBeenCalledWith('g1')
      expect(state()).toBe('consent')
      expect(overlay.card!.ui.busy).toBe(false)
      t.dispose()
    }
  })

  it('a stop refused as claimed says so and reads the giveaway again', async () => {
    const t = setup()
    t.virvi.currentGiveaway.mockResolvedValue({ giveaway: giveaway(claim('present', 300)) })
    t.connect()
    await flush()
    t.virvi.stopGiveaway.mockRejectedValueOnce(httpError(409, { error: 'claimed' }))
    t.virvi.currentGiveaway.mockResolvedValue({ giveaway: giveaway(claim('waiting', 300)) })
    overlay.handler!('stop')
    await flush()
    await flush()
    expect(overlay.card!.ui.note).toBe("You've already claimed this giveaway.")
    expect(t.virvi.currentGiveaway).toHaveBeenCalledTimes(2)
    expect(state()).toBe('sending')
  })

  it('the countdown runs on between check-ins, and Claim shows when it reaches 0', async () => {
    const t = setup()
    t.virvi.currentGiveaway.mockResolvedValue({ giveaway: giveaway(claim('present', 280)) })
    t.connect()
    await flush()
    expect(view().line).toBe('Stay 0:20 more to claim.')
    clock.ms += 5_000
    expect(view().line).toBe('Stay 0:15 more to claim.')
    clock.ms += 15_000
    expect(state()).toBe('ready')
    // Claim is offered on the estimate; the server decides (too_soon comes back as its own line)
    t.virvi.claimGiveaway.mockRejectedValueOnce(httpError(409, { error: 'too_soon', secondsLeft: 3 }))
    overlay.handler!('claim')
    await flush()
    expect(t.virvi.claimGiveaway).toHaveBeenCalledWith('g1')
    expect(overlay.card!.ui.note).toBe('Stay 0:03 more to claim.')
    // Still short on the server: the next tick checks in, and its count resets the estimate
    t.virvi.giveawayCheckIn.mockResolvedValueOnce({ giveaway: giveaway(claim('present', 300)) })
    t.tick(CHECKIN_INTERVAL_MS / 1000)
    await flush()
    expect(t.virvi.giveawayCheckIn).toHaveBeenCalledWith('g1')
    expect(state()).toBe('ready')
    overlay.handler!('claim')
    await flush()
    expect(t.virvi.claimGiveaway).toHaveBeenCalledTimes(2)
    expect(state()).toBe('sending')
  })

  it('View opens the tx', async () => {
    const t = setup()
    const tx = 'https://polygonscan.com/tx/0xabc'
    t.virvi.currentGiveaway.mockResolvedValue({ giveaway: giveaway(claim('sent', 300, tx)) })
    t.connect()
    await flush()
    expect(view().line).toBe('Sent ✓')
    overlay.handler!('view_tx')
    expect(t.openUrl).toHaveBeenCalledWith(tx)
    t.openUrl.mockImplementation(() => { throw new Error('no runtime') })
    expect(() => overlay.handler!('view_tx')).not.toThrow()
  })

  it('never has two requests in flight: a tick while one is pending is skipped', async () => {
    const t = setup()
    let release: (v: { giveaway: VisitorGiveaway | null }) => void = () => {}
    t.virvi.currentGiveaway.mockImplementationOnce(() => new Promise((r) => { release = r }))
    t.connect()
    t.tick(CHECKIN_INTERVAL_MS / 1000)
    t.connect()
    await flush()
    expect(t.virvi.currentGiveaway).toHaveBeenCalledTimes(1)
    release({ giveaway: giveaway() })
    await flush()
    t.tick(CHECKIN_INTERVAL_MS / 1000)
    await flush()
    expect(t.virvi.currentGiveaway).toHaveBeenCalledTimes(2)
  })

  it('a press while a poll is in flight waits for it, and is dropped when the poll brings another giveaway', async () => {
    const t = setup()
    t.connect()
    await flush()
    let release: (v: { giveaway: VisitorGiveaway | null }) => void = () => {}
    t.virvi.currentGiveaway.mockImplementationOnce(() => new Promise((r) => { release = r }))
    t.tick(CHECKIN_INTERVAL_MS / 1000)
    overlay.handler!('agree')
    await flush()
    expect(t.virvi.trackGiveaway).not.toHaveBeenCalled()
    expect(overlay.card!.ui.busy).toBe(true)
    release({ giveaway: giveaway({ id: 'g2' }) })
    await flush()
    await flush()
    expect(t.virvi.trackGiveaway).not.toHaveBeenCalled()
    expect(overlay.card!.ui.busy).toBe(false)
  })

  it('a guest makes no giveaway HTTP calls and sees the wallet notice from giveaway_available', async () => {
    const t = setup(true)
    t.connect()
    await flush()
    expect(state()).toBe('hidden')
    t.announce({ name: 'Winter drop', test: false })
    expect(view()).toMatchObject({ state: 'guest', line: 'Connect a wallet to claim Winter drop.', actions: [] })
    t.tick(GUEST_NOTICE_MS / 1000 - 1)
    expect(state()).toBe('guest')
    t.tick(1)
    expect(state()).toBe('hidden')
    // The same giveaway again (a reconnect): no second notice
    t.announce({ name: 'Winter drop', test: false })
    expect(state()).toBe('hidden')
    for (let i = 0; i < 4; i++) t.tick(CHECKIN_INTERVAL_MS / 1000)
    t.connect()
    await flush()
    t.announce({ name: 'Spring drop', test: false })
    expect(state()).toBe('guest')
    t.announce(null)
    expect(state()).toBe('hidden')
    expect(t.httpCalls()).toBe(0)
  })

  it('signed-in visitors ignore giveaway_available and keep using HTTP', async () => {
    const t = setup()
    t.announce({ name: 'Other', test: false })
    expect(overlay.card!.giveaway).toBeNull()
    t.connect()
    await flush()
    expect(overlay.card!.giveaway).toMatchObject({ id: 'g1' })
  })

  it('stops on dispose (and when the Virvi is destroyed): no more requests, late responses ignored', async () => {
    const t = setup()
    let release: (v: { giveaway: VisitorGiveaway | null }) => void = () => {}
    t.virvi.currentGiveaway.mockImplementationOnce(() => new Promise((r) => { release = r }))
    t.connect()
    t.dispose()
    expect(t.systems).toHaveLength(0)
    const before = overlay.card
    expect(before!.giveaway).toBeNull()
    release({ giveaway: giveaway(claim('present', 60)) })
    await flush()
    expect(overlay.card).toBe(before)
    t.tick(CHECKIN_INTERVAL_MS / 1000)
    t.connect()
    await flush()
    expect(t.virvi.currentGiveaway).toHaveBeenCalledTimes(1)
    const u = setup()
    u.emitState('idle')
    expect(u.systems).toHaveLength(0)
  })
})
