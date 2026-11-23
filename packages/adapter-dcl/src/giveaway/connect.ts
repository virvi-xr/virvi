/**
 * Automatic giveaways in the scene (LIV-194): feeds the overlay's card from GET …/giveaway/current on every connect and
 * every CHECKIN_INTERVAL_MS, and checks in instead while I've joined and am short of the minimum (the check-in returns
 * the giveaway, so it replaces the read). Never more than one request at a time: a tick while one is still out is
 * skipped, and a button press waits for it (and is dropped if the giveaway changed meanwhile). Guests make no giveaway
 * HTTP calls (the server refuses guest tokens): the room's `giveaway_available` on join tells them of one, for the
 * one-time "Connect a wallet" notice. Stops when the Virvi is destroyed (or on the returned dispose); a late response is
 * then ignored. Mirrors beat/connect.ts. Nothing here logs a wallet or a display name.
 */
import type { Virvi } from '@virvixr/core'
import { CHECKIN_INTERVAL_MS, type VisitorGiveaway } from '@virvixr/shared'
import {
  checkInWanted, giveawayError, giveawayKey, giveawayState, GuestNotice, initialGiveawayUi,
  type CardGiveaway, type GiveawayAction, type GiveawayUi,
} from './card.js'
import { errorCodeOf } from '../raffle/card.js'
import { mountGiveawayOverlay, setGiveawayCard, setGiveawayCardHandler } from './GiveawayOverlay.js'

type Systems = { registerSystem(fn: (dt: number) => void): void; unregisterSystem?(fn: (dt: number) => void): void }
type Hud = Parameters<typeof mountGiveawayOverlay>[0]

/** How long the guest's "Connect a wallet" notice shows (engine time), like the BEAT guest notice. */
export const GUEST_NOTICE_MS = 15_000

const started = new WeakMap<Virvi, () => void>()

/** Start once per Virvi, before connecting. Returns a dispose that stops the polling and hides the card. */
export function startSceneGiveaways(
  virvi: Virvi,
  systems: Systems,
  opts: { guest: boolean; wallet: string | null | undefined; hud: Hud; openUrl(url: string): unknown; now?: () => number },
): () => void {
  const existing = started.get(virvi)
  if (existing) return existing
  const now = opts.now ?? Date.now
  const guest = opts.guest
  const wallet = opts.wallet || null

  let giveaway: CardGiveaway | null = null
  let ui: GiveawayUi = initialGiveawayUi(guest, wallet)
  const notice = new GuestNotice(GUEST_NOTICE_MS)
  let disposed = false
  let connected = false
  let inFlight = false
  let queued: (() => void) | null = null
  let elapsedMs = 0

  const visitorGiveaway = (): VisitorGiveaway | null => (giveaway && 'id' in giveaway ? giveaway : null)
  const publish = () => {
    const key = giveawayKey(giveaway)
    ui = { ...ui, noticeDone: !!key && notice.done(key) }
    setGiveawayCard({ giveaway, ui })
  }
  const setUi = (next: Partial<GiveawayUi>) => {
    ui = { ...ui, ...next }
    publish()
  }
  const setGiveaway = (next: CardGiveaway | null) => {
    // Another giveaway (or none): the last one's note and busy flag don't carry over
    if (giveawayKey(next) !== giveawayKey(giveaway)) ui = initialGiveawayUi(guest, wallet)
    giveaway = next
    // The card's countdown runs on from the server's count as of now
    ui = { ...ui, seenAt: now() }
    publish()
  }
  const dropClaim = (giveawayId: string) => {
    const g = visitorGiveaway()
    if (g?.id === giveawayId) setGiveaway({ ...g, claim: null })
  }

  /** Run one request; while another is out, a poll is dropped and a press (`queue`) waits its turn, unless the giveaway changed. */
  const run = <T>(call: () => Promise<T>, ok: (r: T) => void, fail: (err: unknown) => void, queue = false): void => {
    if (disposed) return
    if (inFlight) {
      if (queue) {
        const key = giveawayKey(giveaway)
        queued = () => { if (giveawayKey(giveaway) === key) run(call, ok, fail) }
      }
      return
    }
    inFlight = true
    call().then(
      (r) => { if (!disposed) ok(r) },
      (err) => { if (!disposed) fail(err) },
    ).finally(() => {
      inFlight = false
      const next = queued
      queued = null
      next?.()
    })
  }

  const refresh = () => { if (!guest) run(() => virvi.currentGiveaway(), (r) => setGiveaway(r.giveaway), () => {}) }
  const checkIn = (giveawayId: string) => run(
    () => virvi.giveawayCheckIn(giveawayId),
    (r) => setGiveaway(r.giveaway),
    // not_tracking: stopped elsewhere
    (err) => { if (errorCodeOf(err) === 'not_tracking') dropClaim(giveawayId) },
  )

  const unsubscribeState = virvi.onStateChange((state) => {
    if (disposed) return
    if (state === 'idle') return dispose() // only destroy() sets idle, connected or not
    connected = state === 'connected'
    if (!connected || guest) return
    elapsedMs = 0
    refresh()
  })
  // Sent once on join; signed-in visitors use HTTP instead
  const unsubscribeAvailable = virvi.onGiveawayAvailable((available) => {
    if (disposed || !guest) return
    setGiveaway(available)
  })

  // Engine time drives the polling and the guest notice (the platform has no timers)
  const system = (dt: number) => {
    if (disposed) return
    const key = giveawayKey(giveaway)
    if (key && guest && !notice.done(key)) {
      notice.tick(key, dt)
      if (notice.done(key)) publish()
    }
    if (!connected || guest) return
    elapsedMs += dt * 1000
    if (elapsedMs < CHECKIN_INTERVAL_MS) return
    elapsedMs = 0
    if (inFlight) return // skip this tick
    const g = visitorGiveaway()
    if (g && checkInWanted(g, ui)) checkIn(g.id)
    else refresh()
  }
  systems.registerSystem(system)

  setGiveawayCardHandler((action: GiveawayAction) => {
    const g = visitorGiveaway()
    if (disposed || guest || !g || ui.busy) return
    const id = g.id
    const state = giveawayState(g, ui, now())
    switch (action) {
      case 'agree':
        if (state !== 'consent') return
        setUi({ busy: true, note: null })
        return run(
          () => virvi.trackGiveaway(id),
          (r) => { elapsedMs = 0; setGiveaway(r.giveaway); setUi({ busy: false, note: null }) },
          (err) => setUi({ busy: false, note: giveawayError(err) }),
          true,
        )
      case 'claim':
        if (state !== 'ready') return
        setUi({ busy: true, note: null })
        return run(
          () => virvi.claimGiveaway(id),
          (r) => { setGiveaway(r.giveaway); setUi({ busy: false }) },
          (err) => { setUi({ busy: false, note: giveawayError(err) }); queued = refresh },
          true,
        )
      case 'stop':
        if (g.claim?.status !== 'present') return
        setUi({ busy: true, note: null })
        return run(
          () => virvi.stopGiveaway(id),
          () => { setUi({ busy: false }); dropClaim(id) },
          (err) => {
            // Already gone (stopped elsewhere): the card goes back to the consent all the same
            if (errorCodeOf(err) === 'not_tracking') { setUi({ busy: false }); return dropClaim(id) }
            setUi({ busy: false, note: giveawayError(err) })
            if (errorCodeOf(err) === 'claimed') queued = refresh
          },
          true,
        )
      case 'view_tx': {
        const url = g.claim?.txUrl
        if (!url) return
        try {
          void Promise.resolve(opts.openUrl(url)).catch(() => {})
        } catch {
          // Not available outside the Decentraland runtime
        }
        return
      }
    }
  })

  function dispose(): void {
    if (disposed) return
    disposed = true
    queued = null
    unsubscribeState()
    unsubscribeAvailable()
    systems.unregisterSystem?.(system)
    started.delete(virvi)
    setGiveawayCardHandler(() => {})
    setGiveawayCard({ giveaway: null, ui: initialGiveawayUi(guest, wallet) })
  }
  started.set(virvi, dispose)

  mountGiveawayOverlay(opts.hud)
  publish()
  return dispose
}
