import { errorSignature, ERROR_LIMITS, type ClientErrorEvent } from '@virvixr/shared'

/** The most distinct signatures one page load reports in full; past it new ones are dropped (known ones still counted). */
export const PAGE_CAP = 50
const BATCH = 10
const FLUSH_MS = 5000
/** Each send's body stays under this: the server's 64 KB body cap and the browser's 64 KB keepalive quota. */
export const MAX_SEND_BYTES = 60_000
/** Breadcrumbs kept on the second and later events of one send (the first carries the full trail). */
const LATER_CRUMBS = 10
/** Sends tried per event before it is dropped. */
const MAX_ATTEMPTS = 3

/** What a send came to: delivered; worth trying again later (offline, 429, 5xx); or refused for good (400, 413). */
export type SendResult = 'ok' | 'retry' | 'drop'

export interface QueueOptions {
  send: (events: ClientErrorEvent[], opts: { keepalive: boolean }) => Promise<SendResult | void>
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (t: unknown) => void
}

const signatureOf = (e: ClientErrorEvent) =>
  errorSignature({ kind: e.kind, status: e.status, method: e.method, path: e.path, errorType: e.errorType, message: e.message, stack: e.stack })

const bytes = (x: unknown) => JSON.stringify(x).length
const ENVELOPE = bytes({ v: 1, release: 'x'.repeat(12), events: [] })

/** An event cut to fit one send by itself: breadcrumbs, then the stack, then the error body go. */
function fitAlone(e: ClientErrorEvent): ClientErrorEvent | null {
  let out = e
  if (bytes(out) + ENVELOPE > MAX_SEND_BYTES) out = { ...out, breadcrumbs: out.breadcrumbs?.slice(-LATER_CRUMBS) }
  if (bytes(out) + ENVELOPE > MAX_SEND_BYTES) out = { ...out, stack: out.stack?.slice(0, 2000) }
  if (bytes(out) + ENVELOPE > MAX_SEND_BYTES) out = { ...out, errorBody: undefined, breadcrumbs: undefined }
  return bytes(out) + ENVELOPE > MAX_SEND_BYTES ? null : out
}

/**
 * Batches error events (LIV-66): up to 10 per send, or whatever is waiting after 5 seconds, each send under 60 KB.
 * Within a batch one signature is one event with a count. Once a signature has been delivered from this page, later
 * ones go as repeats (count only, no breadcrumbs or error body). A failed send is tried again later, up to 3 times;
 * nothing counts as delivered until the server took it.
 */
export class ErrorQueue {
  private pending = new Map<string, ClientErrorEvent>()
  private attempts = new Map<string, number>()
  private sentSigs = new Set<string>()
  private inflight = new Set<string>()
  private timer: unknown = null
  dropped = 0

  constructor(private opts: QueueOptions) {}

  add(e: ClientErrorEvent): void {
    const sig = signatureOf(e)
    const waiting = this.pending.get(sig)
    if (waiting) {
      waiting.count = Math.min((waiting.count ?? 1) + (e.count ?? 1), ERROR_LIMITS.maxCount)
      return
    }
    if (!this.sentSigs.has(sig) && !this.inflight.has(sig) && this.sentSigs.size + this.inflight.size + this.pending.size >= PAGE_CAP) {
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
    else this.schedule(FLUSH_MS)
  }

  private schedule(ms: number) {
    if (!this.timer) this.timer = (this.opts.setTimer ?? setTimeout)(() => { this.timer = null; void this.flush() }, ms)
  }

  /** Splits events into sends of at most BATCH events and MAX_SEND_BYTES, trimming later events' breadcrumbs. */
  private batches(entries: Array<[string, ClientErrorEvent]>): Array<Array<[string, ClientErrorEvent]>> {
    const out: Array<Array<[string, ClientErrorEvent]>> = []
    let cur: Array<[string, ClientErrorEvent]> = []
    let size = ENVELOPE
    for (const [sig, raw] of entries) {
      let e = cur.length && raw.breadcrumbs && raw.breadcrumbs.length > LATER_CRUMBS ? { ...raw, breadcrumbs: raw.breadcrumbs.slice(-LATER_CRUMBS) } : raw
      let n = bytes(e) + 1
      if (cur.length && (cur.length >= BATCH || size + n > MAX_SEND_BYTES)) {
        out.push(cur)
        cur = []
        size = ENVELOPE
        e = raw
        n = bytes(e) + 1
      }
      const fit = size + n > MAX_SEND_BYTES ? fitAlone(e) : e
      if (!fit) { this.dropped++; this.inflight.delete(sig); continue }
      cur.push([sig, fit])
      size += bytes(fit) + 1
    }
    if (cur.length) out.push(cur)
    return out
  }

  /** Sends what is waiting now; `keepalive` when the page is going away (then only one send, as the browser allows). Never throws. */
  async flush(opts: { keepalive?: boolean } = {}): Promise<void> {
    if (this.timer) {
      ;(this.opts.clearTimer ?? clearTimeout)(this.timer as never)
      this.timer = null
    }
    if (!this.pending.size) return
    const entries = [...this.pending.entries()]
    this.pending.clear()
    for (const [sig] of entries) this.inflight.add(sig)
    let groups = this.batches(entries)
    if (opts.keepalive) {
      for (const g of groups.slice(1)) for (const [sig] of g) { this.inflight.delete(sig); this.dropped++ }
      groups = groups.slice(0, 1)
    }
    let retryIn = 0
    for (const group of groups) {
      let result: SendResult
      try {
        result = (await this.opts.send(group.map(([, e]) => e), { keepalive: !!opts.keepalive })) || 'ok'
      } catch {
        result = 'retry' // offline, or the browser refused the request
      }
      for (const [sig, e] of group) {
        this.inflight.delete(sig)
        if (result === 'ok') {
          this.sentSigs.add(sig)
          this.attempts.delete(sig)
          continue
        }
        const tries = (this.attempts.get(sig) ?? 0) + 1
        if (result === 'drop' || tries >= MAX_ATTEMPTS) {
          this.attempts.delete(sig)
          this.dropped++
          continue
        }
        this.attempts.set(sig, tries)
        const waiting = this.pending.get(sig)
        if (waiting) waiting.count = Math.min((waiting.count ?? 1) + (e.count ?? 1), ERROR_LIMITS.maxCount)
        else this.pending.set(sig, e)
        retryIn = Math.max(retryIn, FLUSH_MS * 2 ** tries)
      }
    }
    if (retryIn) this.schedule(retryIn)
  }

  get size() { return this.pending.size }
}
