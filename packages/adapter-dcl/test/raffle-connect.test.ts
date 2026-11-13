import { describe, it, expect, vi, beforeEach } from 'vitest'
import { CHECKIN_INTERVAL_MS, type PublicDraw, type PublicRaffle } from '@virvixr/shared'
import type { RaffleCard } from '../src/raffle/card.js'

// The overlay draws with @dcl/sdk; here it only records the card and runs a fake 8 s wheel
const overlay = vi.hoisted(() => ({ card: null as RaffleCard | null, wheelLeftMs: 0, spins: [] as string[], handler: null as null | ((a: string) => void) }))
vi.mock('../src/raffle/RaffleOverlay.js', () => ({
  setRaffleCard: (c: RaffleCard) => { overlay.card = c },
  setRaffleCardHandler: (h: (a: string) => void) => { overlay.handler = h },
  startWheel: (d: PublicDraw) => { overlay.spins.push(d.drawId); overlay.wheelLeftMs = 8000 },
  advanceWheel: (ms: number) => { overlay.wheelLeftMs = Math.max(0, overlay.wheelLeftMs - ms); return overlay.wheelLeftMs > 0 },
  wheelShowing: () => overlay.wheelLeftMs > 0,
  mountRaffleOverlay: () => {},
}))

import { startSceneRaffles } from '../src/raffle/connect.js'

const raffle = (over: Partial<PublicRaffle> = {}): PublicRaffle => ({
  id: 'r1', sceneId: 's1', name: 'Party', prize: 'Hat', rules: null, status: 'open', winnersCount: 1, entryCount: 2, ...over,
})
const draw = (raffleId = 'r1'): PublicDraw => ({ drawId: 'd1', raffleId, names: ['Ana', 'Bob'], more: 0, winners: [{ entryId: 'e1', displayName: 'Ana' }] })
const httpError = (status: number, code: string) => new Error(`HTTP ${status}: ${JSON.stringify({ error: code })}`)
const flush = () => new Promise((r) => setTimeout(r, 0))

function setup(guest = false) {
  const on: Record<string, ((x: any) => void)[]> = { changed: [], draw: [], state: [] }
  const virvi = {
    onRaffleChanged: (fn: any) => { on.changed.push(fn); return () => {} },
    onRaffleDraw: (fn: any) => { on.draw.push(fn); return () => {} },
    onStateChange: (fn: any) => { on.state.push(fn); return () => {} },
    getCurrentRaffle: vi.fn(async () => ({ raffle: raffle(), myEntry: null as null | { entered: true; won: boolean }, canEnter: true })),
    raffleCheckIn: vi.fn(async () => {}),
    enterRaffle: vi.fn(async () => ({ entry: { entered: true, won: false } })),
    withdrawRaffle: vi.fn(async () => {}),
  }
  let system: (dt: number) => void = () => {}
  startSceneRaffles(virvi as any, { registerSystem: (fn) => { system = fn } }, { guest, hud: null })
  const emit = (k: string, x: unknown) => on[k].forEach((fn) => fn(x))
  return { virvi, emit, tick: (seconds: number) => system(seconds) }
}

describe('startSceneRaffles', () => {
  beforeEach(() => { overlay.card = null; overlay.wheelLeftMs = 0; overlay.spins = [] })

  it('re-reads my entry on every reconnect, so a winner who missed the draw sees "You won!"', async () => {
    const t = setup()
    t.emit('state', 'connected')
    await flush()
    t.virvi.getCurrentRaffle.mockResolvedValue({ raffle: raffle(), myEntry: { entered: true, won: false }, canEnter: false })
    t.emit('state', 'connected')
    await flush()
    expect(overlay.card).toMatchObject({ entered: true, won: false })
    // Dropped; the draw happened while away; back again
    t.emit('state', 'connecting')
    t.virvi.getCurrentRaffle.mockResolvedValue({ raffle: raffle({ status: 'drawn' }), myEntry: { entered: true, won: true }, canEnter: false })
    t.emit('changed', raffle({ status: 'drawn' }))
    t.emit('state', 'connected')
    await flush()
    t.tick(0.016)
    expect(overlay.card).toMatchObject({ entered: true, won: true })
    expect(t.virvi.getCurrentRaffle).toHaveBeenCalledTimes(3)
  })

  it("a verified visitor the server won't let enter sees no Enter button", async () => {
    const t = setup()
    t.virvi.getCurrentRaffle.mockResolvedValue({ raffle: raffle(), myEntry: null, canEnter: false, reason: undefined } as any)
    t.emit('state', 'connected')
    await flush()
    expect(overlay.card).toMatchObject({ entered: false, entryBlocked: "Raffle entry isn't available in this scene right now." })
    // The pass is refused for this scene
    t.virvi.getCurrentRaffle.mockRejectedValue(httpError(403, 'scene_pass_not_allowed'))
    t.emit('changed', raffle({ id: 'r2' }))
    t.emit('state', 'connected')
    await flush()
    expect(overlay.card).toMatchObject({ raffle: { id: 'r2' }, entryBlocked: "Raffle entry isn't available in this scene right now." })
    // Allowed
    t.virvi.getCurrentRaffle.mockResolvedValue({ raffle: raffle({ id: 'r2' }), myEntry: null, canEnter: true })
    t.emit('state', 'connected')
    await flush()
    expect(overlay.card!.entryBlocked).toBeNull()
  })

  it('withdrawing after the raffle ended says so', async () => {
    const t = setup()
    t.emit('changed', raffle())
    t.virvi.getCurrentRaffle.mockResolvedValue({ raffle: raffle(), myEntry: { entered: true, won: false }, canEnter: false })
    t.emit('state', 'connected')
    await flush()
    t.virvi.withdrawRaffle.mockRejectedValueOnce(httpError(409, 'entry_closed'))
    overlay.handler!('withdraw')
    await flush()
    expect(overlay.card!.note).toBe('This raffle has ended.')
  })

  it('guests never call REST', async () => {
    const t = setup(true)
    t.emit('state', 'connected')
    t.emit('changed', raffle())
    await flush()
    expect(t.virvi.getCurrentRaffle).not.toHaveBeenCalled()
    expect(overlay.card).toMatchObject({ guest: true, raffle: { id: 'r1' } })
  })

  it('checks in every CHECKIN_INTERVAL_MS; 429 is ignored, 404 not_entered stops it', async () => {
    const t = setup()
    t.emit('changed', raffle())
    overlay.handler!('enter')
    overlay.handler!('confirm')
    await flush()
    expect(overlay.card!.entered).toBe(true)
    t.virvi.raffleCheckIn.mockRejectedValueOnce(httpError(429, 'too_soon'))
    t.tick(CHECKIN_INTERVAL_MS / 1000)
    await flush()
    expect(t.virvi.raffleCheckIn).toHaveBeenCalledTimes(1)
    expect(overlay.card!.entered).toBe(true)
    t.virvi.raffleCheckIn.mockRejectedValueOnce(httpError(404, 'not_entered'))
    t.tick(CHECKIN_INTERVAL_MS / 1000)
    await flush()
    expect(overlay.card!.entered).toBe(false)
    t.tick(CHECKIN_INTERVAL_MS / 1000)
    expect(t.virvi.raffleCheckIn).toHaveBeenCalledTimes(2)
  })

  it('reveals a win only after the wheel has landed', async () => {
    const t = setup()
    t.emit('changed', raffle())
    t.virvi.getCurrentRaffle.mockResolvedValue({ raffle: raffle(), myEntry: { entered: true, won: false }, canEnter: false })
    t.emit('state', 'connected')
    await flush()
    t.virvi.getCurrentRaffle.mockResolvedValue({ raffle: raffle({ status: 'drawn' }), myEntry: { entered: true, won: true }, canEnter: false })
    t.emit('draw', draw())
    await flush()
    t.tick(4)
    expect(overlay.card).toMatchObject({ won: false, raffle: { status: 'drawn' } })
    t.tick(4.1)
    expect(overlay.card!.won).toBe(true)
  })

  it('spins a draw that arrives before the card knows the raffle (join race)', async () => {
    const t = setup()
    t.emit('draw', draw())
    expect(overlay.spins).toEqual(['d1'])
    await flush()
    expect(overlay.card!.raffle?.id).toBe('r1')
  })
})
