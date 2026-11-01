'use client'
import Link from 'next/link'
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useApi } from '@/lib/api'
import type { AnalyticsLocation, AnalyticsSession, AnalyticsSummary, HeatCell, LiveData, TimeseriesPoint } from '@/lib/analytics/types'
import { rangeQuery, type RangeKey, type RangeQuery } from '@/lib/analytics/range'
import { formatDuration, visitorLabel } from '@/lib/analytics/labels'
import { isNoAccess } from '@/lib/analytics/view'
import { StatCard } from '@/components/analytics/StatCard'
import { TimeSeriesChart } from '@/components/analytics/TimeSeriesChart'
import { BarList } from '@/components/analytics/BarList'
import { ParcelMap } from '@/components/analytics/ParcelMap'
import { Section, type SectionState } from '@/components/analytics/Section'
import { full } from '@/components/analytics/format'
import { tenureLabel } from './LocationList'
import { Badge, PageHeader, tableHead } from '@/components/ui'

const LIVE_MS = 15_000
const LIVE_ERROR_MS = 60_000
const EMPTY_NOTE = 'No visits recorded yet'

type Api = ReturnType<typeof useApi>
type Series = 'uniqueVisitors' | 'sessions' | 'peakConcurrency'
type Req<T> = { status: 'loading' | 'error' | 'ready'; data?: T }

export function NoAccess() {
  return (
    <div className="mx-auto max-w-7xl">
      <PageHeader crumbs={['Tools', 'Analytics']} title="Analytics" />
      <div className="rounded-lg border border-gray-800 bg-gray-900 p-6 text-sm text-gray-300">
        <p>You don&apos;t have access to this scene&apos;s analytics.</p>
        <Link href="/analytics/" className="mt-3 inline-block text-blue-400 hover:text-blue-300 hover:underline">See the scenes you can view</Link>
      </div>
    </div>
  )
}

/** Latest-value ref: effects read the current `useApi()` object / callbacks without re-running. */
function useLatest<T>(value: T) {
  const ref = useRef(value)
  ref.current = value
  return ref
}

/** One request per `key` (null = don't request, keep the last state); `retry` re-runs it. */
function useRequest<T>(key: string | null, run: () => Promise<T>, onNoAccess: () => void): [Req<T>, () => void] {
  const [state, setState] = useState<Req<T>>({ status: 'loading' })
  const [nonce, setNonce] = useState(0)
  const runRef = useLatest(run)
  const noAccessRef = useLatest(onNoAccess)
  useEffect(() => {
    if (key === null) return
    let live = true
    setState({ status: 'loading' })
    runRef.current().then(
      (data) => { if (live) setState({ status: 'ready', data }) },
      (err) => {
        if (!live) return
        if (isNoAccess(err)) noAccessRef.current()
        setState({ status: 'error' })
      },
    )
    return () => { live = false }
  }, [key, nonce, runRef, noAccessRef])
  return [state, useCallback(() => setNonce((n) => n + 1), [])]
}

/** Polls live presence every 15 s while the tab is visible; 60 s after an error. */
function useLive(apiRef: { current: Api }, id: string, enabled: boolean, onNoAccess: () => void) {
  const [data, setData] = useState<LiveData | null>(null)
  const [failed, setFailed] = useState(false)
  const [nonce, setNonce] = useState(0)
  const noAccessRef = useLatest(onNoAccess)
  useEffect(() => {
    if (!enabled) return
    let timer: ReturnType<typeof setTimeout> | null = null
    let inFlight = false
    let stopped = false
    const schedule = (ms: number) => {
      timer = setTimeout(() => { timer = null; void tick() }, ms)
    }
    const tick = async () => {
      // Hidden: stop here; `visibilitychange` restarts the chain.
      if (stopped || inFlight || document.visibilityState === 'hidden') return
      inFlight = true
      try {
        const d = await apiRef.current.getAnalyticsLive(id)
        if (stopped) return
        setData(d)
        setFailed(false)
        schedule(LIVE_MS)
      } catch (err) {
        if (stopped) return
        if (isNoAccess(err)) return noAccessRef.current()
        setFailed(true)
        schedule(LIVE_ERROR_MS)
      } finally {
        inFlight = false
      }
    }
    const onVisibility = () => { if (document.visibilityState === 'visible' && !timer) void tick() }
    document.addEventListener('visibilitychange', onVisibility)
    void tick()
    return () => {
      stopped = true
      if (timer) clearTimeout(timer)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [apiRef, id, enabled, nonce, noAccessRef])
  const state: SectionState = data ? 'ready' : failed ? 'error' : 'loading'
  return { data, failed, state, retry: useCallback(() => setNonce((n) => n + 1), []) }
}

const toLocalDate = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

function Toggle<T extends string>({ label, value, options, onChange }: {
  label: string; value: T; options: Array<[T, string]>; onChange: (v: T) => void
}) {
  return (
    <div role="group" aria-label={label} className="inline-flex flex-wrap rounded-lg bg-gray-800 p-1">
      {options.map(([v, text]) => (
        <button
          key={v}
          type="button"
          aria-pressed={value === v}
          onClick={() => onChange(v)}
          className={`rounded-md px-3 py-1 text-sm transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 ${
            value === v ? 'bg-blue-600 text-white' : 'text-gray-300 hover:text-white'
          }`}
        >
          {text}
        </button>
      ))}
    </div>
  )
}

const Note = ({ children }: { children: ReactNode }) => <p className="mb-3 text-sm text-gray-400">{children}</p>

export function Dashboard({ location, showAllLink, onWalletVisibility }: {
  location: AnalyticsLocation
  showAllLink: boolean
  onWalletVisibility?: (on: boolean) => void
}) {
  const apiRef = useLatest(useApi())
  const id = location.id
  const [noAccess, setNoAccess] = useState(false)
  const denied = useCallback(() => setNoAccess(true), [])

  // Range: default 7 d. A preset's `now` is taken when it's picked.
  const [rangeKey, setRangeKey] = useState<RangeKey>('7d')
  const [custom, setCustom] = useState(() => {
    const now = new Date()
    return { from: toLocalDate(new Date(now.getTime() - 6 * 86_400_000)), to: toLocalDate(now) }
  })
  const range = useMemo(() => rangeQuery(rangeKey, new Date(), custom), [rangeKey, custom])
  const q: RangeQuery | null = 'error' in range ? null : range
  const qKey = q ? `${q.from}|${q.to}|${q.bucket}` : null

  const [summary, retrySummary] = useRequest<AnalyticsSummary>(qKey, () => apiRef.current.getAnalyticsSummary(id, { from: q!.from, to: q!.to }), denied)
  const [series, retrySeries] = useRequest<{ points: TimeseriesPoint[]; q: RangeQuery }>(
    qKey,
    async () => ({ points: (await apiRef.current.getAnalyticsTimeseries(id, q!)).points, q: q! }),
    denied,
  )
  const [heat, retryHeat] = useRequest<HeatCell[]>(
    qKey,
    async () => (await apiRef.current.getAnalyticsHeatmap(id, { from: q!.from, to: q!.to })).cells,
    denied,
  )
  const ended = !!location.until
  const live = useLive(apiRef, id, !ended, denied)

  const [chartSeries, setChartSeries] = useState<Series>('uniqueVisitors')
  const [heatMetric, setHeatMetric] = useState<'dwell' | 'visits'>('dwell')

  if (noAccess) return <NoAccess />

  const s = summary.data
  const tenure = tenureLabel(location)
  const title = location.title || location.locationKey
  const sumState: SectionState = summary.status === 'ready' ? (s && s.sessions > 0 ? 'ready' : 'empty') : summary.status

  return (
    <div className="mx-auto max-w-7xl space-y-4">
      {/* 1. Header */}
      <PageHeader
        crumbs={['Tools', showAllLink ? { label: 'Analytics', href: '/analytics/' } : 'Analytics', title]}
        title={title}
        subtitle={
          <>
            <p className="break-all text-sm">{location.locationKey}</p>
            {tenure && <p className="mt-1 text-xs text-gray-500">{tenure}</p>}
            <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
              <span>Data updates hourly</span>
              {s && <Badge>{Math.round(s.verifiedShare * 100)}% verified wallets</Badge>}
            </div>
          </>
        }
        actions={
          <div className="flex flex-col items-start gap-2 sm:items-end">
            <Toggle
              label="Date range"
              value={rangeKey}
              onChange={setRangeKey}
              options={[['24h', '24 h'], ['7d', '7 d'], ['30d', '30 d'], ['custom', 'Custom']]}
            />
            {rangeKey === 'custom' && (
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <label className="sr-only" htmlFor="range-from">Start date</label>
                <input
                  id="range-from" type="date" value={custom.from} max={custom.to || undefined}
                  onChange={(e) => setCustom((c) => ({ ...c, from: e.target.value }))}
                  className="rounded-md border border-gray-700 bg-gray-950 px-3 py-1.5 text-white outline-none [color-scheme:dark] focus:border-blue-400"
                />
                <span className="text-gray-500" aria-hidden="true">to</span>
                <label className="sr-only" htmlFor="range-to">End date</label>
                <input
                  id="range-to" type="date" value={custom.to} min={custom.from || undefined}
                  onChange={(e) => setCustom((c) => ({ ...c, to: e.target.value }))}
                  className="rounded-md border border-gray-700 bg-gray-950 px-3 py-1.5 text-white outline-none [color-scheme:dark] focus:border-blue-400"
                />
              </div>
            )}
            {'error' in range && <p className="text-sm text-red-400" role="alert">{range.error}</p>}
          </div>
        }
      />

      {/* 2. Summary cards */}
      {summary.status === 'error' ? (
        <div className="rounded-lg border border-gray-800 bg-gray-900 p-4 text-sm text-gray-400" role="alert">
          Couldn&apos;t load the summary —{' '}
          <button type="button" onClick={retrySummary} className="text-blue-400 hover:text-blue-300 hover:underline">Retry</button>
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-5" aria-busy={summary.status === 'loading'}>
          <StatCard label="Visitors" value={s ? full(s.uniqueVisitors) : '…'} />
          <StatCard label="New / returning" value={s ? `${full(s.newVisitors)} / ${full(s.returningVisitors)}` : '…'} />
          <StatCard label="Sessions" value={s ? full(s.sessions) : '…'} />
          <StatCard label="Peak at once" value={s ? full(s.peakConcurrency) : '…'} />
          <StatCard label="Avg. time" value={s ? formatDuration(s.dwellAvgSec) : '…'} />
        </div>
      )}

      {/* 3. Visitors over time */}
      <Section
        title="Visitors over time"
        state={series.status}
        onRetry={retrySeries}
        action={
          <Toggle
            label="Series"
            value={chartSeries}
            onChange={setChartSeries}
            options={[['uniqueVisitors', 'Visitors'], ['sessions', 'Sessions'], ['peakConcurrency', 'Peak at once']]}
          />
        }
      >
        {series.data && (
          <>
            {series.data.points.length === 0 && <Note>{EMPTY_NOTE}</Note>}
            <TimeSeriesChart
              points={series.data.points}
              series={chartSeries}
              bucket={series.data.q.bucket}
              from={series.data.q.from}
              to={series.data.q.to}
            />
          </>
        )}
      </Section>

      {/* 4. Here now (current tenure only) */}
      {!ended && (
        <Section title="Here now" state={live.state} onRetry={live.retry}>
          {live.data && (
            <>
              <p className="mb-3 text-sm text-gray-300">
                <span className="text-2xl font-semibold text-white tabular-nums">{full(live.data.count)}</span> here now
                {live.failed && <span className="ml-2 text-xs text-gray-500">(couldn&apos;t refresh — retrying in a minute)</span>}
              </p>
              <div className="mx-auto max-w-xl">
                <ParcelMap parcels={location.parcels} baseParcel={location.baseParcel} live={live.data.positions} />
              </div>
            </>
          )}
        </Section>
      )}

      {/* 5. Heatmap */}
      <Section
        title="Heatmap"
        state={heat.status}
        onRetry={retryHeat}
        action={<Toggle label="Heatmap metric" value={heatMetric} onChange={setHeatMetric} options={[['dwell', 'Dwell'], ['visits', 'Visits']]} />}
      >
        {heat.data && (
          <>
            {heat.data.length === 0 && <Note>{EMPTY_NOTE}</Note>}
            <div className="mx-auto max-w-xl">
              <ParcelMap parcels={location.parcels} baseParcel={location.baseParcel} cells={heat.data} metric={heatMetric} />
            </div>
          </>
        )}
      </Section>

      {/* 6. Breakdowns */}
      <Section title="Breakdowns" state={sumState} onRetry={retrySummary}>
        {s && (
          <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-4">
            <BarList title="Interactions" counts={s.interactions} />
            <BarList title="Emotes" counts={s.emotes} labels={s.emoteLabels} />
            <BarList title="Countries" counts={s.countries} />
            <BarList title="Platforms" counts={s.platforms} />
          </div>
        )}
      </Section>

      {/* 7. Sessions (most recent first; not range-bound) */}
      <Sessions apiRef={apiRef} id={id} onNoAccess={denied} />

      {/* 8. Settings (hosts / co-hosts) */}
      {location.canManage && (
        <WalletSetting apiRef={apiRef} id={id} initial={location.walletVisibility} onSaved={onWalletVisibility} />
      )}
    </div>
  )
}

function Sessions({ apiRef, id, onNoAccess }: { apiRef: { current: Api }; id: string; onNoAccess: () => void }) {
  const [first, retry] = useRequest(id, () => apiRef.current.getAnalyticsSessions(id), onNoAccess)
  const [more, setMore] = useState<AnalyticsSession[]>([])
  const [cursor, setCursor] = useState<string | null>(null)
  const [loadingMore, setLoadingMore] = useState(false)
  const [moreFailed, setMoreFailed] = useState(false)

  useEffect(() => {
    setMore([])
    setCursor(first.data?.nextCursor ?? null)
  }, [first.data])

  const loadMore = async () => {
    if (!cursor) return
    setLoadingMore(true)
    setMoreFailed(false)
    try {
      const r = await apiRef.current.getAnalyticsSessions(id, cursor)
      setMore((m) => [...m, ...r.sessions])
      setCursor(r.nextCursor)
    } catch (err) {
      if (isNoAccess(err)) onNoAccess()
      else setMoreFailed(true)
    } finally {
      setLoadingMore(false)
    }
  }

  const rows = first.data ? [...first.data.sessions, ...more] : []
  const state: SectionState = first.status === 'ready' ? (rows.length ? 'ready' : 'empty') : first.status

  return (
    <Section title="Recent visits" state={state} onRetry={retry}>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[640px] text-left text-sm">
          <thead className={tableHead}>
            <tr className="border-b border-gray-800">
              <th scope="col" className="py-2 pr-4">Started (local)</th>
              <th scope="col" className="py-2 pr-4">Duration</th>
              <th scope="col" className="py-2 pr-4">Visitor</th>
              <th scope="col" className="py-2 pr-4">Platform</th>
              <th scope="col" className="py-2 pr-4">Country</th>
              <th scope="col" className="py-2">Returning</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className="border-b border-gray-800/60 last:border-0">
                <td className="whitespace-nowrap py-2 pr-4 text-gray-300">
                  {new Date(r.startedAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}
                </td>
                <td className="whitespace-nowrap py-2 pr-4 tabular-nums text-gray-300">{formatDuration(r.durationSec)}</td>
                <td className="py-2 pr-4 text-gray-100">
                  <span className={r.walletAddress && !r.displayName ? 'font-mono text-xs' : undefined} title={r.walletAddress ?? undefined}>
                    {visitorLabel(r)}
                  </span>
                  {r.verified && <span className="ml-2 rounded bg-gray-800 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-gray-400">verified</span>}
                </td>
                <td className="py-2 pr-4 text-gray-300">{r.platform ?? '—'}</td>
                <td className="py-2 pr-4 text-gray-300">{r.country ?? '—'}</td>
                <td className="py-2 text-gray-300">{r.isReturning ? 'Yes' : 'No'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {cursor && (
        <div className="mt-3 flex items-center gap-3">
          <button
            type="button"
            onClick={loadMore}
            disabled={loadingMore}
            className="rounded-md bg-gray-800 px-3 py-1.5 text-sm text-white hover:bg-gray-700 disabled:opacity-50"
          >
            {loadingMore ? 'Loading…' : 'Load more'}
          </button>
          {moreFailed && <span className="text-sm text-gray-400" role="alert">Couldn&apos;t load more — try again</span>}
        </div>
      )}
    </Section>
  )
}

function WalletSetting({ apiRef, id, initial, onSaved }: {
  apiRef: { current: Api }; id: string; initial: boolean; onSaved?: (on: boolean) => void
}) {
  const [on, setOn] = useState(initial)
  const [saving, setSaving] = useState(false)
  const [failed, setFailed] = useState(false)

  const change = async (next: boolean) => {
    setOn(next) // optimistic
    setSaving(true)
    setFailed(false)
    try {
      const r = await apiRef.current.setAnalyticsWalletVisibility(id, next)
      setOn(r.scene.walletVisibility)
      onSaved?.(r.scene.walletVisibility)
    } catch {
      setOn(!next)
      setFailed(true)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Section title="Settings" state="ready" onRetry={() => {}}>
      <label className="flex items-start gap-3">
        <input
          type="checkbox"
          checked={on}
          disabled={saving}
          onChange={(e) => change(e.target.checked)}
          className="mt-0.5 h-4 w-4 shrink-0 accent-blue-600"
        />
        <span>
          <span className="block text-sm text-white">Record visitor wallets and names</span>
          <span className="mt-1 block text-sm text-gray-400">
            Applies to new visits. Visitors see a notice while this is on. Turning it off removes stored wallets and names.
          </span>
        </span>
      </label>
      {failed && <p className="mt-2 text-sm text-red-400" role="alert">Couldn&apos;t save the setting — try again</p>}
    </Section>
  )
}
