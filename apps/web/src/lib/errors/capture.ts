import { ERROR_LIMITS, redactText, redactUrl, redactValue, type Breadcrumb, type ClientErrorEvent, type ClientErrorKind } from '@virvixr/shared'

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
export function errorEvent(kind: Exclude<ClientErrorKind, 'api'>, thrown: unknown, ctx: EventContext): ClientErrorEvent {
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
}

/** What a crash screen's Report sends. */
export function buildReport(description: string, event: ClientErrorEvent, release: string): ReportPayload {
  return { v: 1, release, description: description.trim().slice(0, ERROR_LIMITS.maxDescription), event }
}

/** The form's read-only "What we'll send": the exact JSON that Submit posts. */
export const reportPreview = (p: ReportPayload) => JSON.stringify(p, null, 2)
