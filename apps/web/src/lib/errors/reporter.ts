import type { ClientErrorEvent } from '@virvixr/shared'
import { API_URL } from '../config'
import { requestHeaders } from '../request-headers'
import { Breadcrumbs, clickLabel, type LabelledElement } from './breadcrumbs'
import { ErrorQueue, type SendResult } from './queue'
import { apiErrorEvent, consoleMessage, errorEvent, isOwnSource, shouldReportApi, type ReportResult } from './capture'
import { decideFromAnswer, promptKey, promptRequestBody, readLocal, shouldCheckPrompt, writeLocal, type PromptAnswer } from './prompt'

/** A toast to show after an error that broke what the user was doing (LIV-66 §4). */
export interface PromptEvent { kind: 'ask' | 'known'; event: ClientErrorEvent }

const storage = (): Storage | null => {
  try { return typeof localStorage === 'undefined' ? null : localStorage } catch { return null }
}

/** The build this page is (NEXT_PUBLIC_RELEASE, set from the commit SHA at build time; see next.config.ts). */
export const RELEASE = (process.env.NEXT_PUBLIC_RELEASE || 'dev').slice(0, 12)

const SCENE_IN_PATH = /\/scenes\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i

/**
 * The browser side of error reporting (LIV-66): records what the user did (breadcrumbs), catches uncaught errors,
 * unhandled rejections, console.error from our own scripts and apiFetch failures, and sends them in batches. Every
 * failure of its own is swallowed; it never reports itself.
 */
class Reporter {
  readonly crumbs = new Breadcrumbs()
  private readonly queue = new ErrorQueue({ send: (events, o) => this.post(events, { keepalive: o.keepalive, bearer: true }) })
  private token: () => string | null = () => null
  private installed = false
  private captured = new WeakSet<object>()
  private last: ClientErrorEvent | null = null
  private checked = new Set<string>()
  private promptListeners = new Set<(p: PromptEvent) => void>()
  private reportListeners = new Set<(lastError: ClientErrorEvent | null) => void>()

  setToken(get: () => string | null) {
    this.token = get
  }

  private ctx(userFacing = false) {
    const route = typeof location !== 'undefined' ? location.pathname : '/'
    return { route, breadcrumbs: this.crumbs.list(), sceneId: SCENE_IN_PATH.exec(route)?.[1] ?? null, userFacing }
  }

  /** One send. `bearer: false` sends without the session, so the server counts it against no one. */
  private async post(events: ClientErrorEvent[], o: { keepalive: boolean; bearer: boolean }): Promise<SendResult> {
    const body = JSON.stringify({ v: 1, release: RELEASE, events })
    const res = await fetch(`${API_URL}/api/errors`, { method: 'POST', keepalive: o.keepalive, headers: requestHeaders(o.bearer ? this.token() : null, { body }), body })
    if (res.ok) return 'ok'
    return res.status === 429 || res.status >= 500 ? 'retry' : 'drop'
  }

  private add(e: ClientErrorEvent) {
    try {
      this.last = e
      this.queue.add(e)
    } catch { /* never let reporting throw */ }
  }

  /** The last error on this page (for the help menu's Report a bug), or null. */
  lastError(): ClientErrorEvent | null {
    return this.last ? { ...this.last, breadcrumbs: this.crumbs.list() } : null
  }

  /** The breadcrumbs and page now, for a report with no error. */
  context() {
    return this.ctx()
  }

  onPrompt(fn: (p: PromptEvent) => void): () => void {
    this.promptListeners.add(fn)
    return () => { this.promptListeners.delete(fn) }
  }

  /** Opens the Report form (the help menu, a prompt toast). Rendered by <ErrorPrompts/>. */
  openReport(lastError: ClientErrorEvent | null = this.lastError()) {
    for (const fn of this.reportListeners) fn(lastError)
  }

  onOpenReport(fn: (lastError: ClientErrorEvent | null) => void): () => void {
    this.reportListeners.add(fn)
    return () => { this.reportListeners.delete(fn) }
  }

  /** A guest's or trial's "Don't ask me about errors" (an account's is saved on the server). */
  optOutHere() {
    const s = storage()
    writeLocal(s, { ...readLocal(s), optedOut: true })
  }

  /**
   * After an error that broke a user action: asks the server whether to ask (once per signature per page), applies a
   * guest's own 24-hour and opt-out state, and tells the toasts. Background errors never get here.
   */
  private async checkPrompt(e: ClientErrorEvent) {
    try {
      if (!shouldCheckPrompt(e) || !this.promptListeners.size) return
      const key = promptKey(e)
      if (this.checked.has(key) || this.checked.size >= 50) return
      this.checked.add(key)
      const body = promptRequestBody(e)
      const res = await fetch(`${API_URL}/api/errors/prompt`, { method: 'POST', headers: requestHeaders(this.token(), { body }), body })
      if (!res.ok) return
      const answer = (await res.json()) as PromptAnswer
      const s = storage()
      const { prompt, local } = decideFromAnswer(answer, readLocal(s), Date.now())
      if (!answer.saved) writeLocal(s, local)
      if (prompt !== 'none') for (const fn of this.promptListeners) fn({ kind: prompt, event: e })
    } catch { /* never let reporting throw */ }
  }

  /** Called once from <ErrorReporting/>. */
  install() {
    if (this.installed || typeof window === 'undefined') return
    this.installed = true
    const origin = window.location.origin
    window.addEventListener('error', (ev) => {
      const err = ev.error as unknown
      if (!isOwnSource({ filename: ev.filename, stack: err instanceof Error ? err.stack : undefined, message: ev.message }, origin)) return
      if (err && typeof err === 'object') {
        if (this.captured.has(err)) return
        this.captured.add(err)
      }
      this.add(errorEvent('exception', err ?? ev.message, this.ctx()))
    })
    window.addEventListener('unhandledrejection', (ev) => {
      const reason = ev.reason as unknown
      if (reason instanceof Error && !isOwnSource({ stack: reason.stack }, origin)) return
      if (reason && typeof reason === 'object') {
        if (this.captured.has(reason)) return
        this.captured.add(reason)
      }
      this.add(errorEvent('rejection', reason, this.ctx()))
    })
    // console.error from our own code. Deferred a second, so an error a crash screen (whose effect runs after React logs
    // it) or the handlers above report isn't counted twice
    const original = console.error.bind(console)
    console.error = (...args: unknown[]) => {
      original(...args)
      try {
        const caller = (new Error().stack ?? '').split('\n').slice(2).join('\n')
        if (!isOwnSource({ stack: caller }, origin)) return
        const err = args.find((a) => a instanceof Error) as Error | undefined
        // Never the objects themselves: strings and Errors only, anything else as a type tag (consoleMessage)
        const thrown = Object.assign(new Error(consoleMessage(args)), err ? { name: err.name, stack: err.stack } : {})
        const ctx = this.ctx()
        setTimeout(() => {
          if (err && this.captured.has(err)) return
          this.add(errorEvent('console', thrown, ctx))
        }, 1000)
      } catch { /* ignore */ }
    }
    document.addEventListener('click', (ev) => {
      try {
        const el = (ev.target as Element | null)?.closest?.('button, a, [role="button"], [role="link"], [role="tab"], [role="menuitem"]')
        this.crumbs.click(clickLabel(el as unknown as LabelledElement | null))
      } catch { /* ignore */ }
    }, { capture: true })
    const flush = () => { void this.queue.flush({ keepalive: true }) }
    window.addEventListener('pagehide', flush)
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flush() })
  }

  nav(path: string) {
    this.crumbs.nav(path)
  }

  /**
   * Every apiFetch call ends here: a breadcrumb always, an event when it failed. Calls are background unless the call
   * site marks them a user action (a save, deploy, upload or payment the user asked for): only those may prompt.
   */
  apiDone(r: { method: string; path: string; status: number; ms: number; requestId: string | null; ok: boolean; body?: unknown; userAction?: boolean }) {
    try {
      if (!shouldReportApi(r.path)) return
      this.crumbs.api(r.method, r.path, r.status, r.ms, r.requestId)
      if (r.ok) return
      const e = apiErrorEvent({ ...r, body: r.body }, this.ctx(!!r.userAction))
      this.add(e)
      if (r.userAction) void this.checkPrompt(e)
    } catch { /* ignore */ }
  }

  /**
   * A crash screen: recorded at once, without the session (nothing about the user goes until they press Submit on
   * the Report form), and returned for that form.
   */
  crash(error: unknown): ClientErrorEvent {
    if (error && typeof error === 'object') this.captured.add(error)
    const e = errorEvent('crash', error, this.ctx(true))
    this.last = e
    void this.post([e], { keepalive: false, bearer: false }).catch(() => {})
    return e
  }

  /**
   * Sends a report: exactly the payload its preview showed (ReportDraft), with the session only now. Throws on failure,
   * for the form to say so (with the server's reason for a refused screenshot).
   */
  async report(body: string): Promise<ReportResult> {
    const res = await fetch(`${API_URL}/api/errors/reports`, { method: 'POST', headers: requestHeaders(this.token(), { body }), body })
    const json = await res.json().catch(() => ({})) as Partial<ReportResult> & { error?: string }
    if (!res.ok) throw Object.assign(new Error(json.error ?? `HTTP ${res.status}`), { status: res.status, code: json.error })
    return { emailed: !!json.emailed, screenshot: json.screenshot ?? null }
  }
}

export const reporter = new Reporter()
