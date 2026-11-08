/** The admin Errors page's data (GET /api/admin/errors…, apps/server/src/errors/queries.ts) and its pure helpers. */

export interface ErrorSignatureSummary {
  id: string
  signature: string
  source: 'web' | 'server'
  kind: string
  status: number | null
  expected: string | null
  firstSeenAt: string
  lastSeenAt: string
  firstRelease: string | null
  lastRelease: string | null
  totalCount: number
  resolvedAt: string | null
  regressedAt: string | null
  userReports: number
  linearIssueKey: string | null
  linearIssueUrl: string | null
  count: number
  users: number
}

export interface ErrorsOverview {
  release: string
  top: Record<'day' | 'week', { byUsers: ErrorSignatureSummary[]; byCount: ErrorSignatureSummary[] }>
  new: Array<ErrorSignatureSummary & { sinceDeploy: boolean }>
  spiking: Array<ErrorSignatureSummary & { usual: number; hour: string }>
  regressions: ErrorSignatureSummary[]
  expected: Array<ErrorSignatureSummary & { hourly: number[] }>
}

export interface ErrorEventView {
  id: string; occurredAt: string; source: string; kind: string; release: string | null; route: string | null; method: string | null
  path: string | null; status: number | null; requestId: string | null; browser: string | null; os: string | null; orgId: string | null
  sceneId: string | null; count: number; userFacing: boolean; errorType: string | null; message: string | null; stack: string | null
  errorBody: unknown; breadcrumbs: Array<{ t: number; type: string; path?: string; label?: string; method?: string; status?: number; ms?: number; requestId?: string }>
}

export interface ErrorDetail {
  signature: ErrorSignatureSummary & { message: string | null; route: string | null }
  totals: { day: number; week: number; usersWeek: number }
  days: number
  timeline: Array<{ hour: string; count: number; users: number }>
  hourOfDay: number[]
  breakdowns: Record<'release' | 'route' | 'browser' | 'os' | 'org', Array<{ value: string; count: number }>>
  events: ErrorEventView[]
  requestIds: string[]
  joined: Array<{ requestId: string; source: string; kind: string; occurredAt: string; signatureId: string; signature: string }>
  reports: Array<{ id: string; description: string; release: string | null; createdAt: string; from: string | null }>
}

export interface ErrorThresholds {
  newMinUsers: number; severeMinUsers: number; severeMinCount: number; spikeFactor: number; spikeMinBaseline: number
  spikeMinCount: number; spikeHistoryWeeks: number; quietDays: number; filing: boolean
}

export interface ErrorSettings { thresholds: ErrorThresholds; defaults: ErrorThresholds; linear: { configured: boolean }; release: string }

const HOUR = 3_600_000

/** `hours` hourly buckets ending with the current hour; hours with no row are zero. */
export function hourlyBuckets(rows: Array<{ hour: string; count: number }>, hours: number, now = Date.now()): Array<{ hour: string; count: number }> {
  const h0 = Math.floor(now / HOUR) * HOUR
  const byHour = new Map(rows.map((r) => [Date.parse(r.hour), r.count]))
  return Array.from({ length: hours }, (_, i) => {
    const t = h0 - (hours - 1 - i) * HOUR
    return { hour: new Date(t).toISOString(), count: byHour.get(t) ?? 0 }
  })
}

/** Bar heights in percent of the largest; a non-zero bar is never thinner than 2%. */
export function barHeights(values: number[]): number[] {
  const max = Math.max(0, ...values)
  if (!max) return values.map(() => 0)
  return values.map((v) => (v ? Math.max(2, Math.round((v / max) * 100)) : 0))
}

const KIND: Record<string, string> = {
  api: 'API error', crash: 'Crash screen', exception: 'Uncaught error', rejection: 'Unhandled rejection', console: 'console.error',
  server_5xx: 'Server 5xx', server_exception: 'Server exception', job: 'Failed job',
}
export const kindLabel = (k: string) => KIND[k] ?? k

export function sinceLabel(iso: string, now = Date.now()): string {
  const m = Math.max(0, Math.round((now - Date.parse(iso)) / 60_000))
  if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60)
  if (h < 48) return `${h}h ago`
  return `${Math.round(h / 24)}d ago`
}
