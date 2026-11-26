import { AD_LIMITS } from '@virvixr/shared'
import type { AdEvent, AdLevel, Quat, Vec3 } from '@virvixr/shared'
import type { ConsentGate } from '../analytics/consent.js'
import { isOnScreen } from './rotation.js'

const MAX_QUEUED = 200

interface SpaceState {
  elementId: string
  adId: string | null
  onScreenSince: number | null
  /** This showing has been on screen for onScreenMinMs. */
  seen: boolean
  hover: { adId: string; since: number } | null
}

export class AdTracker {
  private readonly send: (events: AdEvent[]) => Promise<boolean>
  private readonly onSeen: (spaceKey: string, adId: string) => void
  private readonly now: () => number
  private readonly spaces = new Map<string, SpaceState>()
  private readonly emitted = new Set<string>()
  private queue: AdEvent[] = []
  private inScene = false
  private lastMoveAt: number
  private lastFlushAt: number
  private flushing = false
  /** The visitor's decision on the analytics notice (GDPR notice): ad views count only once they accept. */
  private consent: ConsentGate | null = null
  /** Waiting for that decision's gate to be attached: count, but send nothing yet. */
  private holding = false

  /** `onSeen` fires once per showing, when the visitor has had it on screen (the level-2 moment). */
  constructor(opts: { send: (events: AdEvent[]) => Promise<boolean>; now?: () => number; onSeen?: (spaceKey: string, adId: string) => void }) {
    this.send = opts.send
    this.onSeen = opts.onSeen ?? (() => {})
    this.now = opts.now ?? Date.now
    this.lastMoveAt = this.lastFlushAt = this.now()
  }

  /** Send nothing until setConsent attaches the visitor's decision (or null: there is no notice, count as before). */
  hold(): void {
    this.holding = true
  }

  /**
   * The visitor notice's decision gates ad views like the rest of Virvi's analytics: held until a decision, sent once
   * they accept, and dropped (nothing more counted this visit) when they decline.
   */
  setConsent(gate: ConsentGate | null): void {
    this.consent = gate
    this.holding = false
    this.applyDecline()
  }

  /** A new showing on this space (the same ad again counts as a new showing). */
  showing(spaceKey: string, elementId: string, adId: string | null): void {
    const prev = this.spaces.get(spaceKey)
    if (prev && prev.adId === adId && prev.elementId === elementId) {
      prev.onScreenSince = null
      prev.seen = false
      return
    }
    this.spaces.set(spaceKey, { elementId, adId, onScreenSince: null, seen: false, hover: null })
    this.emitScene(this.spaces.get(spaceKey)!)
  }

  tick(input: {
    inScene: boolean
    moved: boolean
    camera: { position: Vec3; rotation: Quat } | null
    spaces: Record<string, { position: Vec3; shortSideM: number }>
  }): void {
    const t = this.now()
    this.applyDecline()
    this.inScene = input.inScene
    if (input.moved) this.lastMoveAt = t
    const active = this.active()

    for (const [key, space] of this.spaces) {
      if (!space.adId) continue
      this.emitScene(space)
      const geometry = input.spaces[key]
      const visible = active && input.camera && geometry && isOnScreen(input.camera, geometry)
      if (!visible) {
        space.onScreenSince = null
        continue
      }
      space.onScreenSince ??= t
      if (t - space.onScreenSince < AD_LIMITS.onScreenMinMs) continue
      this.emit(space, space.adId, 'screen')
      if (!space.seen) {
        space.seen = true
        this.onSeen(key, space.adId)
      }
    }

    if (t - this.lastFlushAt >= AD_LIMITS.eventsFlushMs) void this.flush()
  }

  hoverStart(spaceKey: string): void {
    const space = this.spaces.get(spaceKey)
    if (space?.adId) space.hover = { adId: space.adId, since: this.now() }
  }

  hoverEnd(spaceKey: string): void {
    const space = this.spaces.get(spaceKey)
    if (!space?.hover) return
    const { adId, since } = space.hover
    space.hover = null
    this.emit(space, adId, 'look', Math.max(0, this.now() - since))
  }

  click(spaceKey: string): void {
    const space = this.spaces.get(spaceKey)
    if (space?.adId) this.emit(space, space.adId, 'click')
  }

  async flush(): Promise<void> {
    this.applyDecline()
    if (this.flushing || !this.maySend()) return
    this.flushing = true
    this.lastFlushAt = this.now()
    try {
      while (this.queue.length > 0) {
        const batch = this.queue.splice(0, AD_LIMITS.maxEventsPerBatch)
        let ok = false
        try {
          ok = await this.send(batch)
        } catch {
          ok = false
        }
        if (!ok) {
          this.queue = [...batch, ...this.queue]
          this.trim()
          return
        }
      }
    } finally {
      this.flushing = false
    }
  }

  private maySend(): boolean {
    return !this.holding && (!this.consent || this.consent.sending)
  }

  private applyDecline(): void {
    if (this.consent?.declined) this.queue = []
  }

  private active(): boolean {
    return this.inScene && this.now() - this.lastMoveAt < AD_LIMITS.idleMs
  }

  private emitScene(space: SpaceState): void {
    if (space.adId && this.active()) this.emit(space, space.adId, 'scene')
  }

  private emit(space: SpaceState, adId: string, level: AdLevel, dwellMs?: number): void {
    if (!this.active() || this.consent?.declined) return
    const key = `${adId}|${level}`
    if (this.emitted.has(key)) return
    this.emitted.add(key)
    this.queue.push({ adId, elementId: space.elementId, level, t: this.now(), ...(dwellMs !== undefined ? { dwellMs } : {}) })
    this.trim()
    if (this.queue.length >= AD_LIMITS.eventsFlushCount && this.maySend()) void this.flush()
  }

  private trim(): void {
    if (this.queue.length > MAX_QUEUED) this.queue = this.queue.slice(this.queue.length - MAX_QUEUED)
  }
}
