/**
 * BEATs in the scene (LIV-11): feeds the overlay's card from GET …/beat/current on every connect and every
 * CHECKIN_INTERVAL_MS, and checks in instead while I'm tracking (the check-in returns the BEAT, so it replaces the
 * read). Never more than one request at a time: a tick while one is still out is skipped, and a button press waits for
 * it (and is dropped if the BEAT changed meanwhile). Guests make no BEAT HTTP calls (the server refuses guest tokens):
 * the room's `beat_available` on join tells them of a BEAT, for the one-time "Connect a wallet" notice. Stops when the
 * Virvi is destroyed (or on the returned dispose); a late response is then ignored. Nothing here logs a wallet or a
 * display name.
 */
import type { Virvi } from '@virvixr/core'
import { CHECKIN_INTERVAL_MS, type VisitorBeat } from '@virvixr/shared'
import { beatError, beatKey, beatState, checkInWanted, GuestNotice, initialBeatUi, stopAllowed, type BeatAction, type BeatUi, type CardBeat } from './card.js'
import { errorCodeOf } from '../raffle/card.js'
import { mountBeatOverlay, setBeatCard, setBeatCardHandler } from './BeatOverlay.js'

type Systems = { registerSystem(fn: (dt: number) => void): void; unregisterSystem?(fn: (dt: number) => void): void }
type Hud = Parameters<typeof mountBeatOverlay>[0]

/** How long the guest's "Connect a wallet" notice shows (engine time) unless dismissed first. */
export const GUEST_NOTICE_MS = 15_000

const started = new WeakMap<Virvi, () => void>()

/** Start once per Virvi, before connecting. Returns a dispose that stops the polling and hides the card. */
export function startSceneBeats(
  virvi: Virvi,
  systems: Systems,
  opts: { guest: boolean; hud: Hud; openUrl(url: string): unknown; now?: () => number },
): () => void {
  const existing = started.get(virvi)
  if (existing) return existing
  const now = opts.now ?? Date.now
  const guest = opts.guest

  // A guest's is the room's announced BEAT (name and test flag); everyone else's comes from HTTP
  let beat: CardBeat | null = null
  let ui: BeatUi = initialBeatUi(guest)
  const notice = new GuestNotice(GUEST_NOTICE_MS)
  let disposed = false
  let connected = false
  let inFlight = false
  let queued: (() => void) | null = null
  let elapsedMs = 0

  const visitorBeat = (): VisitorBeat | null => (beat && 'id' in beat ? beat : null)
  const publish = () => {
    const key = beatKey(beat)
    ui = { ...ui, noticeDone: !!key && notice.done(key) }
    setBeatCard({ beat, ui })
  }
  const setUi = (next: Partial<BeatUi>) => {
    ui = { ...ui, ...next }
    publish()
  }
  const setBeat = (next: CardBeat | null) => {
    // Another BEAT (or none): the last one's consent view and note don't carry over
    if (beatKey(next) !== beatKey(beat)) ui = initialBeatUi(guest)
    beat = next
    publish()
  }
  const dropClaim = (beatId: string) => {
    const b = visitorBeat()
    if (b?.id === beatId) setBeat({ ...b, myClaim: null })
  }

  /**
   * Run one request; while another is out, a poll is dropped and a button press (`queue`) waits its turn, unless the
   * BEAT has changed by then.
   */
  const run = <T>(call: () => Promise<T>, ok: (r: T) => void, fail: (err: unknown) => void, queue = false): void => {
    if (disposed) return
    if (inFlight) {
      if (queue) {
        const key = beatKey(beat)
        queued = () => { if (beatKey(beat) === key) run(call, ok, fail) }
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

  const refresh = () => { if (!guest) run(() => virvi.currentBeat(), (r) => setBeat(r.beat), () => {}) }
  const checkIn = (beatId: string) => run(
    () => virvi.beatCheckIn(beatId),
    (r) => setBeat(r.beat),
    // 429 too_soon: the server already counted a recent one. not_tracking: stopped elsewhere.
    (err) => { if (errorCodeOf(err) === 'not_tracking') dropClaim(beatId) },
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
  const unsubscribeAvailable = virvi.onBeatAvailable((available) => {
    if (disposed || !guest) return
    setBeat(available)
  })

  // Engine time drives the polling and the guest notice (the platform has no timers)
  const system = (dt: number) => {
    if (disposed) return
    const key = beatKey(beat)
    if (key && guest && !notice.done(key)) {
      notice.tick(key, dt)
      if (notice.done(key)) publish()
    }
    if (!connected || guest) return
    elapsedMs += dt * 1000
    if (elapsedMs < CHECKIN_INTERVAL_MS) return
    elapsedMs = 0
    if (inFlight) return // skip this tick
    const b = visitorBeat()
    if (b && checkInWanted(b, now(), ui)) checkIn(b.id)
    else refresh()
  }
  systems.registerSystem(system)

  setBeatCardHandler((action: BeatAction) => {
    if (disposed || !beat) return
    if (action === 'dismiss') {
      notice.dismiss(beatKey(beat)!)
      return publish()
    }
    const b = visitorBeat()
    if (!b || guest) return
    const beatId = b.id
    const state = beatState(b, now(), ui)
    switch (action) {
      case 'track':
        if (state === 'offer' && !ui.busy) setUi({ view: 'consent', note: null })
        return
      case 'cancel':
        if (!ui.busy) setUi({ view: 'card' })
        return
      case 'confirm':
        if (state !== 'offer' || ui.view !== 'consent' || ui.busy) return
        setUi({ busy: true })
        return run(
          () => virvi.trackBeat(beatId),
          (r) => { elapsedMs = 0; setBeat(r.beat); setUi({ view: 'card', busy: false, note: null }) },
          (err) => setUi({ view: 'card', busy: false, note: beatError(err, 'track') }),
          true,
        )
      case 'stop':
        if (!stopAllowed(b, now(), ui) || ui.busy) return
        setUi({ busy: true, note: null })
        return run(
          () => virvi.stopTrackingBeat(beatId),
          () => { setUi({ busy: false }); dropClaim(beatId) },
          (err) => {
            if (errorCodeOf(err) === 'not_tracking') { setUi({ busy: false }); return dropClaim(beatId) }
            setUi({ busy: false, note: beatError(err, 'stop') })
          },
          true,
        )
      case 'claim':
        if (state !== 'claimable' || ui.busy) return
        setUi({ busy: true, note: null })
        return run(
          () => virvi.claimBeat(beatId),
          (r) => { setUi({ busy: false }); setBeat(r.beat) },
          (err) => { setUi({ busy: false, note: beatError(err, 'claim') }); queued = refresh },
          true,
        )
      case 'view_tx': {
        const url = b.myClaim?.txUrl
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
    setBeatCardHandler(() => {})
    setBeatCard({ beat: null, ui: initialBeatUi(guest) })
  }
  started.set(virvi, dispose)

  mountBeatOverlay(opts.hud)
  publish()
  return dispose
}
