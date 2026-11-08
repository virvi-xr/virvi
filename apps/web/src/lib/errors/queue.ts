import { errorSignature, type ClientErrorEvent } from '@virvixr/shared'

/** The most distinct signatures one page load reports in full; past it new ones are dropped (known ones still counted). */
export const PAGE_CAP = 50
const BATCH = 10
const FLUSH_MS = 5000

export interface QueueOptions {
  send: (events: ClientErrorEvent[]) => Promise<unknown>
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (t: unknown) => void
}

const signatureOf = (e: ClientErrorEvent) =>
  errorSignature({ kind: e.kind, status: e.status, method: e.method, path: e.path, errorType: e.errorType, message: e.message, stack: e.stack })

/**
 * Batches error events (LIV-66): up to 10 per send, or whatever is waiting after 5 seconds. Within a batch one
 * signature is one event with a count. Once a signature has been sent from this page, later ones go as repeats (count
 * only, no breadcrumbs, stack details or error body), so heavy repeats are counted, not stored in full.
 */
export class ErrorQueue {
  private pending = new Map<string, ClientErrorEvent>()
  private sentSigs = new Set<string>()
  private timer: unknown = null
  dropped = 0

  constructor(private opts: QueueOptions) {}

  add(e: ClientErrorEvent): void {
    const sig = signatureOf(e)
    const waiting = this.pending.get(sig)
    if (waiting) {
      waiting.count = (waiting.count ?? 1) + (e.count ?? 1)
      return
    }
    if (!this.sentSigs.has(sig) && this.sentSigs.size + this.pending.size >= PAGE_CAP) {
      this.dropped++
      return
    }
    if (this.sentSigs.has(sig)) {
      const { breadcrumbs: _b, errorBody: _e, ...rest } = e
      this.pending.set(sig, { ...rest, count: e.count ?? 1, repeat: true })
    } else {
      this.pending.set(sig, { ...e, count: e.count ?? 1 })
    }
    if (this.pending.size >= BATCH) void this.flush()
    else if (!this.timer) this.timer = (this.opts.setTimer ?? setTimeout)(() => { this.timer = null; void this.flush() }, FLUSH_MS)
  }

  /** Sends what is waiting now. Never throws. */
  async flush(): Promise<void> {
    if (this.timer) {
      ;(this.opts.clearTimer ?? clearTimeout)(this.timer as never)
      this.timer = null
    }
    if (!this.pending.size) return
    const batch = [...this.pending.entries()]
    this.pending.clear()
    for (const [sig] of batch) this.sentSigs.add(sig)
    try {
      await this.opts.send(batch.map(([, e]) => e))
    } catch {
      // Reporting is best-effort: a failed send is dropped, never retried in a loop or reported itself
    }
  }

  get size() { return this.pending.size }
}
