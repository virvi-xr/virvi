import { ERROR_LIMITS, SCREENSHOT_TYPES, redactText, redactUrl, redactValue, type Breadcrumb, type ClientErrorEvent, type ClientErrorKind, type ScreenshotType } from '@virvixr/shared'

/**
 * Turning what the browser saw into error events (LIV-66). Pure: reporter.ts wires these to window, console and
 * apiFetch. Everything leaving here is redacted (tokens, emails, wallet addresses, query strings).
 */

const URL_IN_FRAME = /((?:[a-z][a-z0-9+.-]*-extension|https?|blob|file|webpack):\/\/[^\s):]+)/i

/** True for errors from our own scripts; false for browser extensions, third-party scripts and opaque cross-origin errors. */
export function isOwnSource(e: { filename?: string; stack?: string; message?: string }, origin: string): boolean {
  if (e.message === 'Script error.' || e.message === 'Script error') return false
  const own = (url: string) => {
    try {
      return new URL(url).origin === origin
    } catch {
      return false
    }
  }
  if (e.filename) return own(e.filename)
  const first = e.stack?.split('\n').map((l) => URL_IN_FRAME.exec(l)?.[1]).find(Boolean)
  return first ? own(first) : true
}

export interface EventContext {
  route: string
  breadcrumbs: Breadcrumb[]
  sceneId?: string | null
  userFacing?: boolean
  now?: number
}

function base(kind: ClientErrorKind, ctx: EventContext): ClientErrorEvent {
  const e: ClientErrorEvent = { kind, t: ctx.now ?? Date.now(), route: redactUrl(ctx.route).slice(0, ERROR_LIMITS.maxPath) }
  if (ctx.sceneId) e.sceneId = ctx.sceneId
  return e
}

/**
 * A value as text without serialising it: strings, numbers and booleans as they are, anything else only as a type tag
 * (`[object]`, `[array]`, `[null]`), so form values or payloads inside an object never leave the browser.
 */
function valueText(v: unknown): string {
  if (typeof v === 'string') return v
  if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint') return String(v)
  if (v === null) return '[null]'
  if (v === undefined) return '[undefined]'
  if (Array.isArray(v)) return '[array]'
  return `[${typeof v}]`
}

/** console.error's arguments as one message: strings and Errors (as `Name: message`), everything else a type tag. */
export function consoleMessage(args: unknown[]): string {
  return args.slice(0, 10).map((a) => (a instanceof Error ? `${a.name || 'Error'}: ${a.message}` : valueText(a))).join(' ').slice(0, ERROR_LIMITS.maxMessage)
}

/** A thrown value (crash screen, uncaught exception, unhandled rejection, console.error). */
export function errorEvent(kind: Exclude<ClientErrorKind, 'api' | 'report'>, thrown: unknown, ctx: EventContext): ClientErrorEvent {
  const e = base(kind, ctx)
  if (thrown instanceof Error) {
    e.errorType = (thrown.name || 'Error').slice(0, 60)
    e.message = redactText(thrown.message ?? '').slice(0, ERROR_LIMITS.maxMessage)
    if (thrown.stack) e.stack = redactText(thrown.stack).slice(0, ERROR_LIMITS.maxStack)
  } else {
    e.errorType = 'Error'
    e.message = redactText(valueText(thrown).slice(0, ERROR_LIMITS.maxMessage))
  }
  e.breadcrumbs = ctx.breadcrumbs
  if (ctx.userFacing) e.userFacing = true
  return e
}

/** The error endpoint never reports itself. */
export const shouldReportApi = (path: string) => !/^\/api\/errors(?:[/?#]|$)/.test(path)

/** A non-OK apiFetch response: the error body is the only body kept (redacted); the request's own body never is. */
export function apiErrorEvent(r: { method: string; path: string; status: number; requestId: string | null; body: unknown }, ctx: EventContext): ClientErrorEvent {
  const e = base('api', ctx)
  e.method = r.method.toUpperCase()
  e.path = redactUrl(r.path).slice(0, ERROR_LIMITS.maxPath)
  e.status = r.status
  if (r.requestId) e.requestId = r.requestId
  if (r.body !== undefined) e.errorBody = redactValue(r.body)
  e.breadcrumbs = ctx.breadcrumbs
  if (ctx.userFacing) e.userFacing = true
  return e
}

export interface ReportPayload {
  v: 1
  release: string
  description: string
  event: ClientErrorEvent
  /** Optional, chosen by the user (never captured on its own): base64. */
  screenshot?: { type: ScreenshotType; data: string }
}

/** What a Report sends: what the user said, the error (or the page's report event) and an optional screenshot. */
export function buildReport(description: string, event: ClientErrorEvent, release: string, screenshot?: { type: ScreenshotType; data: string } | null): ReportPayload {
  const p: ReportPayload = { v: 1, release, description: description.trim().slice(0, ERROR_LIMITS.maxDescription), event }
  if (screenshot) p.screenshot = { type: screenshot.type, data: screenshot.data }
  return p
}

const sizeText = (n: number) => (n < 1024 ? `${n} bytes` : n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / (1024 * 1024)).toFixed(1)} MB`)
const base64Bytes = (b64: string) => Math.floor((b64.length * 3) / 4) - (b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0)

/**
 * The form's read-only "What we'll send": the exact JSON that Submit posts, except that a screenshot's bytes are
 * summarised (the picture itself is shown above the preview).
 */
export function reportPreview(p: ReportPayload): string {
  if (!p.screenshot) return JSON.stringify(p, null, 2)
  return JSON.stringify({ ...p, screenshot: { type: p.screenshot.type, data: `[the image above, ${sizeText(base64Bytes(p.screenshot.data))}]` } }, null, 2)
}

/** A report with no error (the help menu's Report a bug): the page and what the user did before. */
export function reportEvent(route: string, breadcrumbs: Breadcrumb[], now = Date.now()): ClientErrorEvent {
  return { kind: 'report', t: now, route: redactUrl(route).slice(0, ERROR_LIMITS.maxPath), breadcrumbs }
}

/** Why a chosen screenshot can't be sent, or null. */
export function checkScreenshotFile(f: { type: string; size: number }): string | null {
  if (!(SCREENSHOT_TYPES as readonly string[]).includes(f.type)) return 'Use a PNG, JPEG or WebP image.'
  if (f.size > ERROR_LIMITS.maxScreenshotBytes) return 'The image is over 2 MB. Use a smaller one.'
  return null
}

/** The help menu's form is pre-filled with the last error only if it happened in the last half hour. */
export const LAST_ERROR_MS = 30 * 60_000

export interface ReportResult { screenshot: 'kept' | 'not_kept' | null }

/**
 * One Report form's state. Nothing is sent until submit(): typing, attaching a screenshot and reading the preview
 * stay in the page. `send` posts the body (reporter.report, which adds the session only then).
 */
export class ReportDraft {
  description = ''
  /** Leave the last error out (the report is about something else). */
  includeError = true
  private shot: { type: ScreenshotType; data: string } | null = null
  private readonly lastError: ClientErrorEvent | null
  /** A report event with no error is made once, so the preview and what Submit sends are the same (its time too). */
  private readonly pageEvent: ClientErrorEvent

  constructor(private readonly o: {
    lastError: ClientErrorEvent | null; route: string; breadcrumbs: Breadcrumb[]; release: string
    send: (body: string) => Promise<ReportResult>; now?: () => number
  }) {
    const now = (o.now ?? Date.now)()
    this.lastError = o.lastError && now - o.lastError.t <= LAST_ERROR_MS ? o.lastError : null
    this.pageEvent = reportEvent(o.route, o.breadcrumbs, now)
  }

  get hasError(): boolean { return !!this.lastError }
  get ready(): boolean { return !!this.description.trim() }
  get screenshot() { return this.shot }

  setDescription(d: string) { this.description = d }

  /** Attaches a chosen image (base64); returns why not, or null. */
  attach(file: { type: string; size: number }, base64: string): string | null {
    const why = checkScreenshotFile(file)
    if (why) return why
    this.shot = { type: file.type as ScreenshotType, data: base64 }
    return null
  }

  removeScreenshot() { this.shot = null }

  payload(): ReportPayload {
    const event = this.lastError && this.includeError ? this.lastError : this.pageEvent
    return buildReport(this.description, event, this.o.release, this.shot)
  }

  preview(): string { return reportPreview(this.payload()) }

  async submit(): Promise<ReportResult> {
    if (!this.ready) throw new Error('Say what you were trying to do first.')
    return this.o.send(JSON.stringify(this.payload()))
  }
}
