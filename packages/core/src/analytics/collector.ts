import {
  ANALYTICS_LIMITS as L,
  NOTICE_TEXT,
  type AnalyticsEvent,
  type AnalyticsProbe,
  type AnalyticsSceneRef,
  type IngestResponse,
  type Vec3,
} from '@virvixr/shared'
import { EventQueue } from './queue.js'
import { Uploader } from './uploader.js'
import type { AnalyticsTransport } from './transport.js'
import type { ConsentGate } from './consent.js'

export interface CollectorOptions {
  apiUrl: string
  probe: AnalyticsProbe
  transport: AnalyticsTransport
  scene: AnalyticsSceneRef
  visitor: { visitorId: string; isGuest: boolean; displayName?: string }
  /**
   * The visitor's decision on the analytics notice (GDPR notice; AnalyticsConsent): nothing is sent until `sending`, and
   * after `declined` nothing is kept or sent.
   */
  consent: ConsentGate
  context: { platform: string; device?: string; realm: string; sdkVersion: string }
  now?: () => number
  uuid?: () => string
  random?: () => number
  log?: (m: string) => void
}

function fallbackUuid(random: () => number): string {
  const hex = (n: number) => Array.from({ length: n }, () => Math.floor(random() * 16).toString(16)).join('')
  const variant = '89ab'[Math.floor(random() * 4)]
  return `${hex(8)}-${hex(4)}-4${hex(3)}-${variant}${hex(3)}-${hex(12)}`
}

const round = (n: number, step: number) => Math.round(n / step) * step
const round1 = (n: number) => Math.round(n * 10) / 10
const dist = (a: Vec3, b: Vec3) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)

export class Collector {
  private queue = new EventQueue()
  private uploader: Uploader
  private now: () => number
  private uuid: () => string
  private _sessionId: string | null = null
  private _inside = false
  private seq = 0
  private leftAt = -Infinity
  private lastHeartbeatAt = 0
  private lastPosAt = -Infinity
  private lastPos: Vec3 | null = null
  private hoverSeen = new Map<string, number>()
  private noticeRequested = false
  private noticeShown = false
  private destroyed = false
  private wasSending = false

  constructor(private opts: CollectorOptions) {
    this.now = opts.now ?? (() => Date.now())
    const random = opts.random ?? Math.random
    const webCrypto = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto
    const cryptoUuid = webCrypto?.randomUUID
    this.uuid = opts.uuid ?? (cryptoUuid ? () => cryptoUuid.call(webCrypto) : () => fallbackUuid(random))
    this.uploader = new Uploader({
      url: `${opts.apiUrl.replace(/\/$/, '')}/api/ingest`,
      queue: this.queue,
      transport: opts.transport,
      now: this.now,
      random: opts.random,
      log: opts.log,
      envelope: (sessionId) => ({
        v: 1,
        sessionId,
        visitorId: opts.visitor.visitorId,
        isGuest: opts.visitor.isGuest,
        noticeShown: this.noticeShown,
        displayName: this.noticeShown ? opts.visitor.displayName : undefined,
        scene: opts.scene,
      }),
      onResponse: (r: IngestResponse) => {
        if (r.notice) this.noticeRequested = true
      },
    })
  }

  get sessionId(): string | null {
    return this._sessionId
  }

  get inside(): boolean {
    return this._inside
  }

  /** Call once per frame (the adapter's registerSystem). */
  tick(): void {
    if (this.destroyed) return
    const { probe } = this.opts
    const t = this.now()
    const pose = probe.getPlayerPose()
    const inside = !!pose && probe.isInsideScene(pose.position)
    let leaving = false

    if (inside && !this._inside) this.enter(t)
    else if (!inside && this._inside) {
      this.emit('session.leave', { reason: 'left_parcels' })
      this._inside = false
      this.leftAt = t
      leaving = true
    }

    if (this._inside && pose) {
      if (t - this.lastHeartbeatAt >= L.heartbeatMs) {
        this.emit('session.heartbeat', { cameraMode: probe.getCameraMode() })
        this.lastHeartbeatAt = t
      }
      const moved = !this.lastPos || dist(pose.position, this.lastPos) > L.posMinMoveM
      const interval = moved ? L.posMovingMs : L.posIdleMs
      if (t - this.lastPosAt >= interval) {
        this.emit('pos', {
          x: round1(pose.position.x),
          y: round1(pose.position.y),
          z: round1(pose.position.z),
          ry: ((round(pose.headingDeg, 5) % 360) + 360) % 360,
          m: moved,
        })
        this.lastPos = pose.position
        this.lastPosAt = t
      }
      for (const i of probe.pollInteractions()) {
        if (i.kind === 'hover') {
          const seen = this.hoverSeen.get(i.target)
          if (seen !== undefined && t - seen < L.hoverDedupeMs) continue
          this.hoverSeen.set(i.target, t)
        }
        this.emit('interact', { kind: i.kind, target: i.target })
      }
      for (const v of probe.pollVideoEvents()) this.emit('video', { target: v.target, state: v.state })
      for (const e of probe.pollEmotes()) this.emit('emote', { emote: e })
    } else {
      // Drain probe buffers so stale events aren't attributed later.
      probe.pollInteractions()
      probe.pollVideoEvents()
      probe.pollEmotes()
    }

    const { consent } = this.opts
    if (consent.declined) {
      // Declined: what was buffered goes, and nothing (the wallet notice included) follows
      this.queue.clear()
      return
    }
    if (!consent.sending) return // no decision yet: keep buffering

    if (this.noticeRequested && !this.noticeShown) {
      probe.showNotice(NOTICE_TEXT)
      this.noticeShown = true
    }

    // The first frame allowed to send sends what was buffered
    this.uploader.maybeFlush(leaving || !this.wasSending)
    this.wasSending = true
  }

  track(name: string, props?: Record<string, unknown>): void {
    if (this.destroyed || !this._inside) return
    this.emit('custom', props === undefined ? { name } : { name, props })
  }

  giveaway(giveawayId: string, result: string): void {
    if (this.destroyed || !this._inside) return
    this.emit('giveaway', { giveawayId, result })
  }

  async destroy(): Promise<void> {
    if (this.destroyed) return
    if (this._inside) {
      this.emit('session.leave', { reason: 'destroy' })
      this._inside = false
    }
    this.destroyed = true
    if (this.opts.consent.declined) this.queue.clear()
    if (this.opts.consent.sending) await this.uploader.maybeFlush(true)
  }

  private enter(t: number): void {
    this._inside = true
    if (this._sessionId && t - this.leftAt <= L.sessionResumeMs) return
    this._sessionId = this.uuid()
    this.seq = 0
    this.lastHeartbeatAt = t
    this.lastPosAt = -Infinity
    this.lastPos = null
    this.hoverSeen.clear()
    const { context, visitor, probe } = this.opts
    this.emit('session.start', {
      platform: context.platform,
      device: context.device,
      realm: context.realm,
      isGuest: visitor.isGuest,
      cameraMode: probe.getCameraMode(),
      sdkVersion: context.sdkVersion,
    })
  }

  private emit(type: AnalyticsEvent['type'], data?: Record<string, unknown>): void {
    if (!this._sessionId || this.opts.consent.declined) return
    this.queue.push(this._sessionId, { t: this.now(), type, seq: this.seq++, data })
  }
}
