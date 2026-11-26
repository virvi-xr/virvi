import type { ClientErrorEvent, PrivacyStatus } from '@virvixr/shared'

/**
 * Browser error reporting under the dashboard privacy notice (GDPR notice):
 * - `held`: no decision yet (or not known yet). Breadcrumbs are recorded and errors kept on the page; nothing is sent.
 * - `on`: the account accepted, or nobody is signed in to an account that's asked: reporting runs as it always has.
 * - `off`: the account declined. Nothing is recorded or sent, and what was held is discarded.
 */
export type ReportingMode = 'held' | 'on' | 'off'

/** The most errors (and crash reports) held on a page while waiting for a decision. */
export const HELD_MAX = 20

/**
 * The mode for this page. Only an account the notice asks (signed in, not a trial or a scene pass: the people the
 * Terms prompt asks) can hold or turn reporting off; everyone else reports as before.
 */
export function reportingModeFor(s: { authLoading: boolean; signedIn: boolean; asked: boolean; status: PrivacyStatus | null }): ReportingMode {
  if (s.authLoading) return 'held'
  if (!s.signedIn || !s.asked) return 'on'
  if (!s.status || !s.status.decision) return 'held'
  return s.status.decision === 'accept' ? 'on' : 'off'
}

/** Between the reporter and the network: holds, passes on or drops what the reporter would send. */
export class ReportingGate {
  private _mode: ReportingMode = 'held'
  private held: Array<{ kind: 'event' | 'crash'; e: ClientErrorEvent }> = []

  constructor(private out: { add(e: ClientErrorEvent): void; crash(e: ClientErrorEvent): void; forget(): void }) {}

  get mode(): ReportingMode {
    return this._mode
  }

  /** Breadcrumbs may be recorded. */
  get records(): boolean {
    return this._mode !== 'off'
  }

  /** Anything may be sent now (the error prompt's check included). */
  get sends(): boolean {
    return this._mode === 'on'
  }

  add(e: ClientErrorEvent): void {
    this.pass('event', e)
  }

  crash(e: ClientErrorEvent): void {
    this.pass('crash', e)
  }

  set(mode: ReportingMode): void {
    if (mode === this._mode) return
    this._mode = mode
    if (mode === 'on') {
      const held = this.held
      this.held = []
      for (const h of held) this.pass(h.kind, h.e)
    } else if (mode === 'off') {
      this.held = []
      this.out.forget()
    }
  }

  private pass(kind: 'event' | 'crash', e: ClientErrorEvent): void {
    if (this._mode === 'off') return
    if (this._mode === 'held') {
      if (this.held.length < HELD_MAX) this.held.push({ kind, e })
      return
    }
    if (kind === 'crash') this.out.crash(e)
    else this.out.add(e)
  }
}
