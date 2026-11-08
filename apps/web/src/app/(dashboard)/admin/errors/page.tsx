'use client'

import { useCallback, useEffect, useState } from 'react'
import { useAuth } from '@/lib/auth'
import { useApi } from '@/lib/api'
import { Badge, PageHeader, Skeleton, tableHeadBand } from '@/components/ui'
import {
  barHeights, hourlyBuckets, kindLabel, sinceLabel,
  type ErrorDetail, type ErrorSettings, type ErrorSignatureSummary, type ErrorsOverview, type ErrorThresholds,
} from '@/lib/errors/admin'

/** Single-series hourly bars: one hue, thin marks with a 2px gap, a hover title on each. */
function Bars({ values, labels, height = 48, label }: { values: number[]; labels: string[]; height?: number; label: string }) {
  const h = barHeights(values)
  return (
    <div role="img" aria-label={label} className="flex items-end gap-[2px] border-b border-gray-800" style={{ height }}>
      {h.map((p, i) => (
        <div key={i} title={`${labels[i]}: ${values[i]}`} className="group relative flex h-full flex-1 items-end">
          <div className="w-full rounded-t-[2px] bg-accent/80 group-hover:bg-accent" style={{ height: `${p}%` }} />
        </div>
      ))}
    </div>
  )
}

function SigLine({ s, onOpen, extra }: { s: ErrorSignatureSummary; onOpen: (id: string) => void; extra?: React.ReactNode }) {
  return (
    <tr className="border-t border-gray-800 hover:bg-gray-900/60">
      <td className="max-w-xl p-2">
        <button onClick={() => onOpen(s.id)} className="text-left font-mono text-xs text-gray-200 hover:text-white">{s.signature}</button>
        <div className="mt-1 flex flex-wrap gap-1.5">
          <Badge>{kindLabel(s.kind)}</Badge>
          {s.expected && <Badge tone="info">expected: {s.expected}</Badge>}
          {s.linearIssueKey && <a href={s.linearIssueUrl ?? '#'} target="_blank" rel="noreferrer"><Badge tone="violet">{s.linearIssueKey}</Badge></a>}
          {s.userReports > 0 && <Badge tone="warning">{s.userReports} reports</Badge>}
          {extra}
        </div>
      </td>
      <td className="p-2 text-right tabular-nums">{s.users}</td>
      <td className="p-2 text-right tabular-nums">{s.count}</td>
      <td className="p-2 text-right text-xs text-gray-500">{sinceLabel(s.lastSeenAt)}</td>
    </tr>
  )
}

function SigTable({ title, rows, onOpen, empty, extra }: { title: string; rows: ErrorSignatureSummary[]; onOpen: (id: string) => void; empty: string; extra?: (s: any) => React.ReactNode }) {
  return (
    <section className="rounded-lg border border-gray-800">
      <h2 className="border-b border-gray-800 px-3 py-2 text-sm font-semibold">{title}</h2>
      {rows.length === 0 ? <p className="p-3 text-sm text-gray-500">{empty}</p> : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className={tableHeadBand}><tr><th className="p-2">Signature</th><th className="p-2 text-right">Users</th><th className="p-2 text-right">Count</th><th className="p-2 text-right">Last seen</th></tr></thead>
            <tbody>{rows.map((s) => <SigLine key={s.id} s={s} onOpen={onOpen} extra={extra?.(s)} />)}</tbody>
          </table>
        </div>
      )}
    </section>
  )
}

function Detail({ id, onClose }: { id: string; onClose: () => void }) {
  const api = useApi()
  const [d, setD] = useState<ErrorDetail | null>(null)
  const [days, setDays] = useState(7)
  const [error, setError] = useState<string | null>(null)
  const load = useCallback(() => { api.getAdminError(id, days).then(setD, (e) => setError(e.message)) }, [api, id, days])
  useEffect(load, [load])
  if (error) return <p className="text-sm text-red-400">{error}</p>
  if (!d) return <Skeleton rows={3} />
  const s = d.signature
  const hours = Math.min(days, 30) * 24
  const buckets = hourlyBuckets(d.timeline, hours)
  const resolve = async (resolved: boolean) => {
    try { await api.setAdminErrorResolved(id, resolved); load() } catch (e: any) { setError(e.message) }
  }
  return (
    <section className="space-y-4 rounded-lg border border-gray-700 bg-gray-900/40 p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="font-mono text-sm text-white">{s.signature}</p>
          <p className="mt-1 text-xs text-gray-400">
            {kindLabel(s.kind)} · {s.totalCount} in all · {d.totals.day} in 24h · {d.totals.week} in 7d · {d.totals.usersWeek} users in 7d ·
            first seen {sinceLabel(s.firstSeenAt)} (release {s.firstRelease ?? '?'}) · last seen {sinceLabel(s.lastSeenAt)} (release {s.lastRelease ?? '?'})
          </p>
        </div>
        <div className="flex gap-2">
          {s.resolvedAt
            ? <button onClick={() => resolve(false)} className="rounded-md border border-gray-700 px-3 py-1.5 text-xs hover:border-gray-500">Marked fixed {sinceLabel(s.resolvedAt)} · Undo</button>
            : <button onClick={() => resolve(true)} className="rounded-md border border-gray-700 px-3 py-1.5 text-xs hover:border-gray-500">Mark fixed</button>}
          <button onClick={onClose} className="rounded-md px-3 py-1.5 text-xs text-gray-400 hover:text-white">Close</button>
        </div>
      </div>
      <div>
        <div className="mb-1 flex items-center justify-between text-xs text-gray-400">
          <span>Events per hour, last {Math.min(days, 30)} days (UTC)</span>
          <select value={days} onChange={(e) => setDays(Number(e.target.value))} className="rounded border border-gray-700 bg-gray-950 px-1 py-0.5" aria-label="Range">
            {[1, 7, 30, 90, 400].map((n) => <option key={n} value={n}>{n === 1 ? '24 hours' : `${n} days`}</option>)}
          </select>
        </div>
        <Bars values={buckets.map((b) => b.count)} labels={buckets.map((b) => `${b.hour.slice(0, 13).replace('T', ' ')}:00`)} height={64} label="Events per hour" />
      </div>
      <div className="grid gap-4 md:grid-cols-3">
        <div>
          <p className="mb-1 text-xs text-gray-400">Time of day (UTC, last {d.days} days)</p>
          <Bars values={d.hourOfDay} labels={d.hourOfDay.map((_, h) => `${h}:00`)} label="Events by hour of day" />
        </div>
        {(['release', 'route', 'browser', 'os', 'org'] as const).map((dim) => (
          <div key={dim}>
            <p className="mb-1 text-xs text-gray-400">{{ release: 'Release', route: 'Route', browser: 'Browser', os: 'OS', org: 'Organization' }[dim]}</p>
            {d.breakdowns[dim].length === 0 ? <p className="text-xs text-gray-600">—</p> : (
              <ul className="space-y-0.5 text-xs">
                {d.breakdowns[dim].slice(0, 6).map((b) => (
                  <li key={b.value} className="flex justify-between gap-2"><span className="truncate font-mono text-gray-300">{b.value}{dim === 'release' && b.value === s.firstRelease ? ' (first)' : ''}</span><span className="tabular-nums text-gray-400">{b.count}</span></li>
                ))}
              </ul>
            )}
          </div>
        ))}
      </div>
      {d.joined.length > 0 && (
        <div>
          <p className="mb-1 text-xs text-gray-400">Same requests, other side</p>
          <ul className="space-y-0.5 font-mono text-xs text-gray-300">{d.joined.map((j, i) => <li key={i}><span className="text-gray-500">{j.requestId.slice(0, 8)}</span> {j.signature}</li>)}</ul>
        </div>
      )}
      {d.reports.length > 0 && (
        <div>
          <p className="mb-1 text-xs text-gray-400">What users said</p>
          <ul className="space-y-1 text-sm">{d.reports.map((r) => <li key={r.id}>“{r.description}” <span className="text-xs text-gray-500">— {r.from ?? 'signed out'}, {sinceLabel(r.createdAt)}</span></li>)}</ul>
        </div>
      )}
      <div>
        <p className="mb-1 text-xs text-gray-400">Recent events (the first of each hour are kept in full for 30 days)</p>
        <div className="space-y-2">
          {d.events.map((e) => (
            <details key={e.id} className="rounded border border-gray-800 p-2 text-xs">
              <summary className="cursor-pointer text-gray-300">
                {new Date(e.occurredAt).toLocaleString()} · {e.source} · {e.route ?? ''} · {[e.browser, e.os].filter(Boolean).join(' / ')} · release {e.release ?? '?'}
                {e.requestId && <> · <span className="font-mono">{e.requestId}</span></>}{e.count > 1 && ` · ×${e.count}`}
              </summary>
              {e.message && <pre className="mt-2 whitespace-pre-wrap break-all text-red-300">{e.errorType}: {e.message}{e.stack ? `\n${e.stack}` : ''}</pre>}
              {e.errorBody != null && <pre className="mt-2 whitespace-pre-wrap break-all text-gray-400">{JSON.stringify(e.errorBody, null, 2)}</pre>}
              {e.breadcrumbs.length > 0 && (
                <ol className="mt-2 space-y-0.5 text-gray-400">
                  {e.breadcrumbs.map((c, i) => <li key={i}><span className="text-gray-600">{c.type}</span> {c.type === 'api' ? `${c.method} ${c.path} → ${c.status} (${c.ms}ms)` : c.type === 'click' ? c.label : c.path}</li>)}
                </ol>
              )}
            </details>
          ))}
        </div>
      </div>
    </section>
  )
}

const THRESHOLD_LABELS: Array<[Exclude<keyof ErrorThresholds, 'filing'>, string]> = [
  ['newMinUsers', 'New signature: users before filing'],
  ['severeMinUsers', '5xx or crash: users in an hour'],
  ['severeMinCount', '5xx or crash: events in an hour'],
  ['spikeFactor', 'Spike: times the usual rate'],
  ['spikeMinBaseline', 'Spike: least "usual" per hour'],
  ['spikeMinCount', 'Spike: least events in the hour'],
  ['spikeHistoryWeeks', 'Spike: weeks that make "usual"'],
  ['quietDays', 'Quiet after fix: days'],
]

function Settings() {
  const api = useApi()
  const [s, setS] = useState<ErrorSettings | null>(null)
  const [draft, setDraft] = useState<ErrorThresholds | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  useEffect(() => { api.getAdminErrorSettings().then((r) => { setS(r); setDraft(r.thresholds) }, (e) => setMsg(e.message)) }, [api])
  if (!s || !draft) return null
  const save = async () => {
    try {
      const r = await api.saveAdminErrorSettings(draft)
      setDraft(r.thresholds)
      setMsg('Saved.')
    } catch (e: any) { setMsg(e.message) }
  }
  return (
    <details className="rounded-lg border border-gray-800 p-3">
      <summary className="cursor-pointer text-sm font-semibold">Filing to Linear {s.linear.configured ? <Badge tone="success">set up</Badge> : <Badge>off: LINEAR_API_KEY and LINEAR_TEAM_ID not set</Badge>}</summary>
      <div className="mt-3 grid gap-2 sm:grid-cols-2">
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={draft.filing} onChange={(e) => setDraft({ ...draft, filing: e.target.checked })} /> File issues automatically</label>
        {THRESHOLD_LABELS.map(([k, label]) => (
          <label key={k} className="flex items-center justify-between gap-2 text-sm text-gray-300">
            {label}
            <input type="number" step="any" value={draft[k]} onChange={(e) => setDraft({ ...draft, [k]: Number(e.target.value) })} className="w-24 rounded border border-gray-700 bg-gray-950 px-2 py-1 text-right" />
          </label>
        ))}
      </div>
      <div className="mt-3 flex items-center gap-3">
        <button onClick={save} className="rounded-md border border-gray-700 px-3 py-1.5 text-sm hover:border-gray-500">Save</button>
        {msg && <span className="text-xs text-gray-400">{msg}</span>}
      </div>
    </details>
  )
}

/** Admin: errors from the web app and server, grouped by signature (LIV-66). */
export default function ErrorsPage() {
  const { user } = useAuth()
  const api = useApi()
  const [data, setData] = useState<ErrorsOverview | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [range, setRange] = useState<'day' | 'week'>('day')
  const [by, setBy] = useState<'byUsers' | 'byCount'>('byUsers')
  const [open, setOpen] = useState<string | null>(null)

  useEffect(() => {
    if (user?.role !== 'admin') return
    api.getAdminErrors().then(setData, (e) => setError(e.message))
    const id = new URLSearchParams(window.location.search).get('id')
    if (id) setOpen(id)
  }, [user?.role, api])

  if (user?.role !== 'admin') return <p className="text-gray-400">Admin access required.</p>

  return (
    <div className="mx-auto max-w-7xl space-y-4">
      <PageHeader
        crumbs={['System', { label: 'Admin', href: '/admin' }, 'Errors']}
        title="Errors"
        subtitle={<p className="max-w-2xl">Errors from the web app and the server, grouped by signature. Expected 4xx are charted below and never filed. Current release: <span className="font-mono">{data?.release ?? '…'}</span></p>}
      />
      {error && <p className="text-sm text-red-400">{error}</p>}
      <Settings />
      {open && <Detail id={open} onClose={() => setOpen(null)} />}
      {!data ? <Skeleton rows={3} /> : (
        <>
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="text-gray-400">Top errors</span>
            {(['day', 'week'] as const).map((r) => <button key={r} onClick={() => setRange(r)} aria-pressed={range === r} className={`rounded px-2 py-1 ${range === r ? 'bg-gray-800 text-white' : 'text-gray-400'}`}>{r === 'day' ? '24 hours' : '7 days'}</button>)}
            <span className="text-gray-600">·</span>
            {(['byUsers', 'byCount'] as const).map((b) => <button key={b} onClick={() => setBy(b)} aria-pressed={by === b} className={`rounded px-2 py-1 ${by === b ? 'bg-gray-800 text-white' : 'text-gray-400'}`}>{b === 'byUsers' ? 'by users' : 'by count'}</button>)}
          </div>
          <SigTable title={`Top errors, ${range === 'day' ? 'last 24 hours' : 'last 7 days'}`} rows={data.top[range][by]} onOpen={setOpen} empty="No errors in this window." />
          <div className="grid gap-4 lg:grid-cols-2">
            <SigTable title="Spiking (3× usual for this hour of the week)" rows={data.spiking} onOpen={setOpen} empty="Nothing spiking."
              extra={(s) => <Badge tone="danger">{s.count} this hour, usually {Number(s.usual).toFixed(1)}</Badge>} />
            <SigTable title="Regressions (back after marked fixed)" rows={data.regressions} onOpen={setOpen} empty="No regressions."
              extra={(s) => s.regressedAt && <Badge tone="danger">back {sinceLabel(s.regressedAt)}</Badge>} />
          </div>
          <SigTable title="New in the last 7 days" rows={data.new} onOpen={setOpen} empty="No new signatures."
            extra={(s) => s.sinceDeploy ? <Badge tone="warning">since deploy {data.release}</Badge> : <span className="text-xs text-gray-500">first in {s.firstRelease ?? '?'}</span>} />
          <section className="rounded-lg border border-gray-800">
            <h2 className="border-b border-gray-800 px-3 py-2 text-sm font-semibold">Expected 4xx (charted, never filed), last 7 days</h2>
            {data.expected.length === 0 ? <p className="p-3 text-sm text-gray-500">None.</p> : (
              <ul className="divide-y divide-gray-800">
                {data.expected.map((s) => {
                  const labels = s.hourly.map((_, i) => `${s.hourly.length - 1 - i}h ago`)
                  return (
                    <li key={s.id} className="grid gap-2 p-3 md:grid-cols-[1fr_16rem]">
                      <div>
                        <button onClick={() => setOpen(s.id)} className="text-left font-mono text-xs text-gray-200 hover:text-white">{s.signature}</button>
                        <p className="text-xs text-gray-500">{s.expected} · {s.count} events · {s.users} users</p>
                      </div>
                      <Bars values={s.hourly} labels={labels} height={32} label={`${s.signature}: events per hour, last 7 days`} />
                    </li>
                  )
                })}
              </ul>
            )}
          </section>
        </>
      )}
    </div>
  )
}
