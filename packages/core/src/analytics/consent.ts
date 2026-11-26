import { ANALYTICS_CONSENT_VERSION, isPrivacyDecision, type AnalyticsSceneRef, type PrivacyDecision } from '@virvixr/shared'
import type { TransportResult } from './transport.js'

/**
 * The scene visitor notice (GDPR notice), the decision side: what the visitor decided about Virvi's analytics, and so
 * whether the collector may send. Nothing is sent before a decision, nor after a decline:
 * - `loading`: asking the server for the visitor's decision (one covers every Virvi scene). Nothing is sent and the
 *   notice isn't up yet.
 * - `undecided`: no decision on the notice in force, or the lookup failed. The notice is up; the collector buffers.
 * - `accepted`: the collector sends (once the record is in, see `sending`).
 * - `declined`: the collector drops what it buffered and records nothing more for the visit.
 *
 * A decision is applied at once for this visit and recorded on the server in the background (a few tries); a record
 * that never lands only means the visitor is asked again on their next visit.
 */
export type ConsentState = 'loading' | 'undecided' | 'accepted' | 'declined'

/** What the collector reads each frame. */
export interface ConsentGate {
  /** Events may be sent now. */
  readonly sending: boolean
  /** The visitor declined: record nothing, keep nothing. */
  readonly declined: boolean
}

export type ConsentRequest = (url: string, init: { method: 'GET' | 'POST'; body?: string }) => Promise<TransportResult>

export interface AnalyticsConsentOptions {
  apiUrl: string
  /** The analytics transport's request (a signed fetch on Decentraland), so the decision is keyed as ingest keys it. */
  request: ConsentRequest
  visitorId: string
  scene: AnalyticsSceneRef
  platform: string
  /** Test hook for the waits between tries. */
  sleep?: (ms: number) => Promise<void>
  log?: (m: string) => void
}

const RETRY_MS = [2_000, 5_000]

const retryable = (status: number) => status === 0 || status === 429 || status >= 500

export class AnalyticsConsent implements ConsentGate {
  private _state: ConsentState = 'loading'
  private _open = false
  private saving = 0
  private chain: Promise<void> = Promise.resolve()
  private listeners = new Set<() => void>()
  private last = ''
  private readonly url: string

  constructor(private opts: AnalyticsConsentOptions) {
    this.url = `${opts.apiUrl.replace(/\/$/, '')}/api/analytics/consent`
  }

  get state(): ConsentState {
    return this._state
  }

  /** The notice is on screen. */
  get open(): boolean {
    return this._open
  }

  /** The notice can be closed without deciding: it was reopened from Privacy over a decision already made. */
  get canClose(): boolean {
    return this._state === 'accepted' || this._state === 'declined'
  }

  get sending(): boolean {
    // While a record is on its way, a decline recorded earlier would still make the server drop what's sent
    return this._state === 'accepted' && this.saving === 0
  }

  get declined(): boolean {
    return this._state === 'declined'
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn)
    return () => { this.listeners.delete(fn) }
  }

  /** Looks the visitor's decision up. Any failure counts as no decision: keep buffering, and ask. */
  async load(): Promise<void> {
    let decision: PrivacyDecision | null = null
    try {
      const res = await this.opts.request(`${this.url}?visitorId=${encodeURIComponent(this.opts.visitorId)}`, { method: 'GET' })
      const body = res.body as { version?: unknown; decision?: unknown } | undefined
      if (res.status === 200 && body && typeof body === 'object' && body.version === ANALYTICS_CONSENT_VERSION && isPrivacyDecision(body.decision)) {
        decision = body.decision
      }
    } catch {
      decision = null
    }
    // A decision made while the lookup was out wins
    if (this._state !== 'loading') return
    if (decision) this._state = decision === 'accept' ? 'accepted' : 'declined'
    else {
      this._state = 'undecided'
      this._open = true
    }
    this.changed()
  }

  /** The visitor pressed Accept or Decline. Applied at once; the server's record follows. */
  decide(decision: PrivacyDecision): Promise<void> {
    this._state = decision === 'accept' ? 'accepted' : 'declined'
    this._open = false
    this.saving++
    this.changed()
    // In order, so the last decision made is the last one stored
    this.chain = this.chain.then(() => this.record(decision)).finally(() => {
      this.saving--
      this.changed()
    })
    return this.chain
  }

  /** Privacy: show the notice again, over the decision already made. */
  reopen(): void {
    if (this._state === 'loading' || this._open) return
    this._open = true
    this.changed()
  }

  /** Close a reopened notice, keeping the decision. A notice with no decision behind it stays up. */
  close(): void {
    if (!this.canClose || !this._open) return
    this._open = false
    this.changed()
  }

  private async record(decision: PrivacyDecision): Promise<void> {
    const body = JSON.stringify({ decision, version: ANALYTICS_CONSENT_VERSION, visitorId: this.opts.visitorId, scene: this.opts.scene, platform: this.opts.platform })
    // Where the platform has no timers, the tries go back to back
    const timer = (globalThis as { setTimeout?: (fn: () => void, ms: number) => unknown }).setTimeout
    const sleep = this.opts.sleep ?? ((ms: number) => new Promise<void>((r) => (timer ? timer(r, ms) : r())))
    for (let attempt = 0; ; attempt++) {
      let status = 0
      try {
        status = (await this.opts.request(this.url, { method: 'POST', body })).status
      } catch {
        status = 0
      }
      if (status >= 200 && status < 300) return
      if (!retryable(status) || attempt >= RETRY_MS.length) {
        this.opts.log?.(`[Virvi analytics] your privacy choice wasn't saved (${status}); it applies to this visit`)
        return
      }
      await sleep(RETRY_MS[attempt])
    }
  }

  private changed(): void {
    const now = `${this._state}|${this._open}|${this.sending}`
    if (now === this.last) return
    this.last = now
    for (const fn of this.listeners) {
      try { fn() } catch { /* a listener never breaks the decision */ }
    }
  }
}
