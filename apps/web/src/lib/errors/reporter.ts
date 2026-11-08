import type { ClientErrorEvent } from '@virvixr/shared'
import { API_URL } from '../config'
import { requestHeaders } from '../request-headers'
import { Breadcrumbs, clickLabel, type LabelledElement } from './breadcrumbs'
import { ErrorQueue, type SendResult } from './queue'
import { apiErrorEvent, consoleMessage, errorEvent, isOwnSource, reportPreview, shouldReportApi, type ReportPayload } from './capture'

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
    try { this.queue.add(e) } catch { /* never let reporting throw */ }
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

  /** Every apiFetch call ends here: a breadcrumb always, an event when it failed. */
  apiDone(r: { method: string; path: string; status: number; ms: number; requestId: string | null; ok: boolean; body?: unknown }) {
    try {
      if (!shouldReportApi(r.path)) return
      this.crumbs.api(r.method, r.path, r.status, r.ms, r.requestId)
      // A failed write (save, deploy, upload, payment) broke something the user was doing; a failed read may be background
      if (!r.ok) this.add(apiErrorEvent({ ...r, body: r.body }, this.ctx(r.method.toUpperCase() !== 'GET')))
    } catch { /* ignore */ }
  }

  /**
   * A crash screen: recorded at once, without the session (nothing about the user goes until they press Submit on
   * the Report form), and returned for that form.
   */
  crash(error: unknown): ClientErrorEvent {
    if (error && typeof error === 'object') this.captured.add(error)
    const e = errorEvent('crash', error, this.ctx(true))
    void this.post([e], { keepalive: false, bearer: false }).catch(() => {})
    return e
  }

  /** Sends a crash screen's report: exactly the payload its preview showed. Throws on failure, for the form to say so. */
  async report(payload: ReportPayload): Promise<void> {
    const body = reportPreview(payload)
    const res = await fetch(`${API_URL}/api/errors/reports`, { method: 'POST', headers: requestHeaders(this.token(), { body }), body })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
  }
}

export const reporter = new Reporter()
