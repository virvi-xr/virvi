/**
 * Error reporting rules shared by the web app and the server (LIV-66): how an error is signed (grouped), what is
 * redacted before it leaves the browser (and again on arrival), which 4xx are expected, and the shape the ingest
 * endpoint takes. Pure functions, no I/O.
 */

export const ERROR_LIMITS = {
  /** The ingest body cap (bytes). */
  maxBodyBytes: 64 * 1024,
  /** Events per batch. */
  maxEvents: 20,
  maxBreadcrumbs: 30,
  maxMessage: 500,
  maxStack: 4000,
  /** An error body is kept as JSON up to this size; larger is cut to a string. */
  maxErrorBody: 2000,
  maxLabel: 80,
  maxPath: 300,
  maxDescription: 1000,
  /** Repeats a single event may stand for (the browser folds repeats within a few seconds; anything above is noise). */
  maxCount: 20,
  /** A client clock further off than this is replaced by the server's. */
  maxClockSkewMs: 86_400_000,
} as const

export const CLIENT_ERROR_KINDS = ['api', 'crash', 'exception', 'rejection', 'console'] as const
export type ClientErrorKind = (typeof CLIENT_ERROR_KINDS)[number]
export type ServerErrorKind = 'server_5xx' | 'server_exception' | 'job'
export type ErrorKind = ClientErrorKind | ServerErrorKind

export interface Breadcrumb {
  t: number
  type: 'nav' | 'click' | 'api'
  /** nav: the page; api: the call's path (redacted, no query). */
  path?: string
  /** click: the button or link's own label, never typed text. */
  label?: string
  method?: string
  status?: number
  ms?: number
  requestId?: string
}

/** One error as the browser sends it. The server adds the user, organization, browser and OS itself. */
export interface ClientErrorEvent {
  kind: ClientErrorKind
  t: number
  /** The page the error happened on (redacted, no query). */
  route?: string
  sceneId?: string
  /** How many times this happened since the last report (repeats are counted, not resent in full). */
  count?: number
  /** True when this signature was already sent from this page: count it, don't store it. */
  repeat?: boolean
  /** True when the error broke something the user was doing (a failed save, a crash screen). */
  userFacing?: boolean
  // API errors
  method?: string
  path?: string
  status?: number
  requestId?: string
  errorBody?: unknown
  // Client errors
  errorType?: string
  message?: string
  stack?: string
  breadcrumbs?: Breadcrumb[]
}

// ── Redaction ───────────────────────────────────────────────────────────────

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Paths whose next segment is a credential (pairing, upload and space codes): logged as `:code`. */
const CODE_PATHS = /^((?:https?:\/\/[^/]+)?\/(?:api\/(?:hyperfy|ar)\/pair|pair\/headset|pair|u|s|api\/upload)\/)(?!headset(?:\/|$))[^/?#]+/

const SECRET_KEYS = 'token|code|key|secret|session|sig|signature|password|passwd|pwd|auth|apikey|api_key|access_token|refresh_token|client_secret'
// Every pattern is linear: each starts behind a lookbehind that admits one start per run, or has a bounded quantifier
// (an adversarial 64 KB input is timed in apps/server/test/errors-shared.test.ts).
const RE = {
  jwt: /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}(?:\.[A-Za-z0-9_-]*)?/g,
  bearer: /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi,
  virvi: /(?<![A-Za-z0-9_])virvi_[A-Za-z0-9_-]+/g,
  stripe: /(?<![A-Za-z0-9_])(?:(?:sk|pk|rk)_(?:live|test)_|whsec_)[A-Za-z0-9]+/g,
  keyValue: new RegExp(`(?<![A-Za-z0-9_])(${SECRET_KEYS})=[^\\s&"'<>,;]+`, 'gi'),
  email: /(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63}){0,8}\.[A-Za-z]{2,24}(?![A-Za-z])/g,
  hex: /(?<![0-9A-Za-z])0x[0-9a-fA-F]{64,}(?![0-9A-Za-z])/g,
  wallet: /(?<![0-9A-Za-z])0x[0-9a-fA-F]{40}(?![0-9A-Za-z])/g,
  query: /(?<=[A-Za-z0-9_/.~%-])[?#][^\s"'<>]+/g,
  card: /(?<!\d)(?:\d[ -]?){12,18}\d(?!\d)/g,
  opaque: /(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{20,}(?![A-Za-z0-9_-])/g,
}

function opaqueToken(m: string): boolean {
  if (UUID.test(m)) return false
  const digit = /\d/.test(m)
  if (m.length >= 32) return digit && /[A-Za-z]/.test(m)
  return digit && /[a-z]/.test(m) && /[A-Z]/.test(m)
}

/** Tokens, emails, wallet addresses, signatures, card numbers, secrets in key=value and query strings out of a piece of text. */
export function redactText(input: string): string {
  let s = input
    .replace(RE.jwt, '[token]')
    .replace(RE.bearer, '$1 [token]')
    .replace(RE.virvi, '[token]')
    .replace(RE.stripe, '[token]')
    .replace(RE.keyValue, '$1=[redacted]')
  if (s.includes('@')) s = s.replace(RE.email, '[email]')
  return s
    .replace(RE.hex, '[hex]')
    .replace(RE.wallet, '[wallet]')
    .replace(RE.query, '')
    .replace(RE.card, '[number]')
    .replace(RE.opaque, (m) => (opaqueToken(m) ? '[token]' : m))
}

/** A URL or path without its query or hash, with credential codes replaced. */
export function redactUrl(url: string): string {
  const bare = url.replace(/[?#].*$/, '')
  return redactText(bare.replace(CODE_PATHS, '$1:code'))
}

const SENSITIVE_KEY = /pass(word|phrase)?|secret|token|auth|signature|^sig$|card|cvc|cvv|iban|account_?number|private|mnemonic|seed|otp|cookie|session|apikey|api_key|^key$/i

/** An error body with secret-looking keys dropped and every string redacted. */
export function redactValue(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return redactText(value).slice(0, ERROR_LIMITS.maxMessage)
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return value
  if (depth >= 4) return '[…]'
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => redactValue(v, depth + 1))
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>).slice(0, 30)) {
      out[k] = SENSITIVE_KEY.test(k) ? '[redacted]' : redactValue(v, depth + 1)
    }
    return out
  }
  return undefined
}

// ── Signatures ──────────────────────────────────────────────────────────────

/** A path as a route: ids, numbers, hex and credential codes replaced, no query. */
export function routeTemplate(path: string): string {
  let p = path.slice(0, 2000).replace(/[?#].*$/, '').replace(/^https?:\/\/[^/]+/, '')
  p = p.replace(CODE_PATHS, '$1:code')
  return p
    .split('/')
    .map((seg) => {
      if (!seg || seg.startsWith(':')) return seg
      if (UUID.test(seg)) return ':id'
      if (/^\d+$/.test(seg)) return ':n'
      if (/^0x[0-9a-f]+$/i.test(seg)) return ':hex'
      if (seg.length >= 20 && /\d/.test(seg) && /[a-z]/i.test(seg)) return ':id'
      return seg
    })
    .join('/')
    .slice(0, ERROR_LIMITS.maxPath)
}

/** A message with ids and numbers stripped (and redacted), so errors that differ only in them read the same. */
export function normalizeMessage(message: string): string {
  return redactText(message.slice(0, 2000))
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<id>')
    .replace(/\b0x[0-9a-f]+\b/gi, '<hex>')
    .replace(/\d+(?:\.\d+)?/g, '<n>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200)
}

const FRAME_LOC = /^(?:(?:https?|file|webpack|blob):\/\/|\/)/

/** A frame's file without origin, query, line and column, and without a build's chunk hash or numeric chunk id. */
function frameFile(loc: string): string {
  const file = loc
    .replace(/:\d+(?::\d+)?$/, '')
    .replace(/^[a-z]+:\/\/[^/]*/i, '')
    .replace(/[?#].*$/, '')
  const slash = file.lastIndexOf('/')
  const dir = file.slice(0, slash + 1)
  const base = file.slice(slash + 1)
  if (/^[0-9a-f]+(?:-[0-9a-f]+)*\.js$/i.test(base)) return `${dir}<chunk>.js` // webpack's numbered and hashed shared chunks
  return dir + base.replace(/[-.][0-9a-f]{8,}(?=\.js$)/i, '')
}

/** A frame's function as a stable name: an `[as alias]` (property names survive minifying), else a name longer than a mangled one. */
function frameName(fn: string | null): string {
  if (!fn) return '<anonymous>'
  const alias = /\[as ([^\]]{1,80})\]/.exec(fn)?.[1]
  if (alias) return alias
  const name = fn.replace(/^(?:async|new) /, '').split(' ')[0].split('.').pop() ?? ''
  return name.length > 3 && name !== 'Object' && name !== '<anonymous>' ? name.slice(0, 80) : '<anonymous>'
}

/**
 * The top stack frame of our code as `function (file)`: no origin, line, column, chunk hash or mangled name, so the
 * same bug keeps one signature across deploys. Reads Chrome (`at fn (url:l:c)`) and Firefox/Safari (`fn@url:l:c`)
 * frames, including Next's route-group paths with parentheses.
 */
export function topFrame(stack: string | undefined): string | null {
  if (!stack) return null
  for (const raw of stack.slice(0, ERROR_LIMITS.maxStack).split('\n').slice(0, 30)) {
    const line = raw.trim().slice(0, 1000)
    let fn: string | null = null
    let loc: string
    if (line.startsWith('at ')) {
      const body = line.slice(3)
      const open = body.indexOf(' (')
      if (open >= 0 && body.endsWith(')')) { fn = body.slice(0, open); loc = body.slice(open + 2, -1) } else loc = body
    } else {
      const at = line.indexOf('@')
      if (at < 0) continue
      fn = line.slice(0, at) || null
      loc = line.slice(at + 1)
    }
    if (!FRAME_LOC.test(loc)) continue
    return `${frameName(fn)} (${frameFile(loc)})`
  }
  return null
}

export interface SignatureInput {
  kind: ErrorKind
  status?: number
  method?: string
  /** API and server events: the path or route template. */
  path?: string
  errorType?: string
  message?: string
  stack?: string
  /** Job failures: which job. */
  job?: string
}

/**
 * The group an error belongs to: status + route template for API and server responses; error type + stripped message
 * + top stack frame for client errors and exceptions; the job's name + error for failed background jobs.
 */
export function errorSignature(e: SignatureInput): string {
  const type = (e.errorType || 'Error').slice(0, 60)
  const msg = normalizeMessage(e.message ?? '')
  switch (e.kind) {
    case 'api':
    case 'server_5xx':
      return `${e.kind} ${e.status ?? 0} ${(e.method ?? 'GET').toUpperCase()} ${routeTemplate(e.path ?? '')}`
    case 'job':
      return `job ${e.job ?? 'unknown'} ${type}: ${msg}`
    default: {
      const frame = topFrame(e.stack)
      return `${e.kind} ${type}: ${msg}${frame ? ` @ ${frame}` : ''}`
    }
  }
}

// ── Expected 4xx ────────────────────────────────────────────────────────────

export type ExpectedReason = 'session' | 'permission' | 'validation' | 'upload_too_large' | 'upload_type'

/**
 * The 4xx the app handles on its own: recorded and charted (a sudden jump still shows as a spike), never filed as a
 * bug and never a reason to ask the user. The only list; change it here.
 */
export const EXPECTED_4XX: Readonly<Record<number, ExpectedReason>> = {
  400: 'validation', // a validation error shown on the field
  401: 'session', // fixed by renewing the token, or a dead session sent to sign-in
  403: 'permission', // a refusal the page explains (account_required, scene passes, roles)
  413: 'upload_too_large',
  415: 'upload_type',
  422: 'validation',
}

export function expectedReason(status: number, _body?: unknown): ExpectedReason | null {
  return EXPECTED_4XX[status] ?? null
}

// ── Browser and OS ──────────────────────────────────────────────────────────

/** A coarse browser (with major version) and OS from a User-Agent header. */
export function parseUserAgent(ua: string | undefined): { browser: string; os: string } {
  if (!ua) return { browser: 'Other', os: 'Other' }
  const v = (re: RegExp) => re.exec(ua)?.[1]
  let browser = 'Other'
  let m: string | undefined
  if ((m = v(/OculusBrowser\/(\d+)/))) browser = `Quest Browser ${m}`
  else if ((m = v(/Edg(?:A|iOS)?\/(\d+)/))) browser = `Edge ${m}`
  else if ((m = v(/OPR\/(\d+)/))) browser = `Opera ${m}`
  else if ((m = v(/(?:Firefox|FxiOS)\/(\d+)/))) browser = `Firefox ${m}`
  else if ((m = v(/(?:Chrome|CriOS)\/(\d+)/))) browser = `Chrome ${m}`
  else if ((m = v(/Version\/(\d+)[^ ]* (?:Mobile\/\S+ )?Safari/))) browser = `Safari ${m}`
  let os = 'Other'
  if (/Quest|OculusBrowser/.test(ua)) os = 'Quest'
  else if (/Windows/.test(ua)) os = 'Windows'
  else if (/iPhone|iPad|iPod/.test(ua)) os = 'iOS'
  else if (/Mac OS X|Macintosh/.test(ua)) os = 'macOS'
  else if (/Android/.test(ua)) os = 'Android'
  else if (/CrOS/.test(ua)) os = 'ChromeOS'
  else if (/Linux/.test(ua)) os = 'Linux'
  return { browser, os }
}

// ── Validation ──────────────────────────────────────────────────────────────

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const optStr = (v: unknown, max: number): string | undefined | false =>
  v === undefined || v === null ? undefined : typeof v === 'string' ? v.slice(0, max) : false
const optInt = (v: unknown, min: number, max: number): number | undefined | false =>
  v === undefined || v === null ? undefined : Number.isInteger(v) && (v as number) >= min && (v as number) <= max ? (v as number) : false
/** A release is a commit SHA (lowercase hex) or `dev`; it is kept to 12 characters, as the server's. */
const RELEASE = /^(?:dev|[0-9a-f]{7,40})$/
const releaseOf = (v: unknown) => (typeof v === 'string' && RELEASE.test(v) ? v.slice(0, 12) : null)

function errorBodyOf(v: unknown): unknown {
  if (v === undefined) return undefined
  const red = redactValue(v)
  let json: string
  try { json = JSON.stringify(red) } catch { return undefined }
  return json.length <= ERROR_LIMITS.maxErrorBody ? red : json.slice(0, ERROR_LIMITS.maxErrorBody)
}

function checkCrumb(c: unknown, nowMs: number): Breadcrumb | string {
  if (!isObj(c)) return 'breadcrumb must be an object'
  if (c.type !== 'nav' && c.type !== 'click' && c.type !== 'api') return 'breadcrumb.type must be nav, click or api'
  const path = optStr(c.path, ERROR_LIMITS.maxPath)
  const label = optStr(c.label, ERROR_LIMITS.maxLabel)
  const method = optStr(c.method, 10)
  const requestId = optStr(c.requestId, 64)
  const status = optInt(c.status, 0, 999)
  const ms = optInt(c.ms, 0, 3_600_000)
  if ([path, label, method, requestId, status, ms].includes(false)) return 'breadcrumb has a bad field'
  const t = typeof c.t === 'number' && Number.isFinite(c.t) ? c.t : nowMs
  const out: Breadcrumb = { t, type: c.type }
  if (path !== undefined) out.path = redactUrl(path as string)
  if (label !== undefined) out.label = redactText(label as string)
  if (method !== undefined) out.method = (method as string).toUpperCase()
  if (status !== undefined) out.status = status as number
  if (ms !== undefined) out.ms = ms as number
  if (requestId !== undefined && UUID.test(requestId as string)) out.requestId = requestId as string
  return out
}

function checkEvent(e: unknown, nowMs: number): ClientErrorEvent | string {
  if (!isObj(e)) return 'event must be an object'
  if (typeof e.kind !== 'string' || !(CLIENT_ERROR_KINDS as readonly string[]).includes(e.kind)) return `unknown kind: ${String(e.kind)}`
  const fields = {
    route: optStr(e.route, ERROR_LIMITS.maxPath),
    sceneId: optStr(e.sceneId, 64),
    method: optStr(e.method, 10),
    path: optStr(e.path, ERROR_LIMITS.maxPath),
    requestId: optStr(e.requestId, 64),
    errorType: optStr(e.errorType, 60),
    message: optStr(e.message, ERROR_LIMITS.maxMessage),
    stack: optStr(e.stack, ERROR_LIMITS.maxStack),
  }
  for (const [k, v] of Object.entries(fields)) if (v === false) return `${k} must be a string`
  const status = optInt(e.status, 0, 999)
  if (status === false) return 'status must be a whole number'
  const count = e.count === undefined ? 1 : Number.isInteger(e.count) && (e.count as number) >= 1 ? Math.min(e.count as number, ERROR_LIMITS.maxCount) : false
  if (count === false) return 'count must be a positive whole number'
  if (e.kind === 'api' && (status === undefined || !fields.path)) return 'api events need status and path'
  if (e.breadcrumbs !== undefined && (!Array.isArray(e.breadcrumbs) || e.breadcrumbs.length > ERROR_LIMITS.maxBreadcrumbs)) {
    return `breadcrumbs must be at most ${ERROR_LIMITS.maxBreadcrumbs} items`
  }
  const crumbs: Breadcrumb[] = []
  for (const c of (e.breadcrumbs as unknown[] | undefined) ?? []) {
    const r = checkCrumb(c, nowMs)
    if (typeof r === 'string') return r
    crumbs.push(r)
  }
  const t = typeof e.t === 'number' && Number.isFinite(e.t) && Math.abs(e.t - nowMs) <= ERROR_LIMITS.maxClockSkewMs ? e.t : nowMs
  const out: ClientErrorEvent = { kind: e.kind as ClientErrorKind, t, count }
  if (fields.route) out.route = redactUrl(fields.route)
  if (fields.sceneId && UUID.test(fields.sceneId)) out.sceneId = fields.sceneId
  if (fields.method) out.method = fields.method.toUpperCase()
  if (fields.path) out.path = redactUrl(fields.path)
  if (fields.requestId && UUID.test(fields.requestId)) out.requestId = fields.requestId
  if (fields.errorType) out.errorType = redactText(fields.errorType)
  if (fields.message) out.message = redactText(fields.message)
  if (fields.stack) out.stack = redactText(fields.stack)
  if (status !== undefined) out.status = status
  if (e.repeat === true) out.repeat = true
  if (e.userFacing === true) out.userFacing = true
  const body = errorBodyOf(e.errorBody)
  if (body !== undefined) out.errorBody = body
  if (crumbs.length) out.breadcrumbs = crumbs
  return out
}

export type ErrorBatchCheck = { ok: true; release: string | null; events: ClientErrorEvent[] } | { ok: false; error: string }

/** The ingest body: `{ v: 1, release?, events: [...] }`, validated, capped and redacted again. */
export function checkErrorBatch(input: unknown, nowMs: number): ErrorBatchCheck {
  if (!isObj(input)) return { ok: false, error: 'batch must be an object' }
  if (input.v !== 1) return { ok: false, error: 'v must be 1' }
  const release = releaseOf(input.release)
  if (!Array.isArray(input.events) || input.events.length < 1 || input.events.length > ERROR_LIMITS.maxEvents) {
    return { ok: false, error: `events must contain 1-${ERROR_LIMITS.maxEvents} items` }
  }
  const events: ClientErrorEvent[] = []
  for (const e of input.events) {
    const r = checkEvent(e, nowMs)
    if (typeof r === 'string') return { ok: false, error: r }
    events.push(r)
  }
  return { ok: true, release, events }
}

export type ErrorReportCheck =
  | { ok: true; release: string | null; description: string; event: ClientErrorEvent }
  | { ok: false; error: string }

/** A user's report from a crash screen: `{ v: 1, release?, description, event }`. */
export function checkErrorReport(input: unknown, nowMs: number): ErrorReportCheck {
  if (!isObj(input)) return { ok: false, error: 'report must be an object' }
  if (input.v !== 1) return { ok: false, error: 'v must be 1' }
  const description = typeof input.description === 'string' ? input.description.trim() : ''
  if (!description) return { ok: false, error: 'description is required' }
  if (description.length > ERROR_LIMITS.maxDescription) return { ok: false, error: `description must be at most ${ERROR_LIMITS.maxDescription} characters` }
  const event = checkEvent(input.event, nowMs)
  if (typeof event === 'string') return { ok: false, error: event }
  const release = releaseOf(input.release)
  return { ok: true, release, description, event }
}
