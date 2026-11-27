'use client'
import { useEffect, useState } from 'react'
import { API_URL } from '@/lib/config'
import { dayBar, formatUptime, headline, STATE_LABEL, STATUS_WORD, type ComponentState, type StatusPage } from '@/lib/status'

const DOT: Record<ComponentState, string> = { up: 'bg-emerald-400', degraded: 'bg-amber-400', down: 'bg-red-500', unknown: 'bg-gray-500' }
const BAR = { none: 'bg-gray-800', up: 'bg-emerald-500/80', degraded: 'bg-amber-400/90', down: 'bg-red-500/90' } as const
const when = (iso: string) => new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' })

export default function StatusPageView() {
  const [page, setPage] = useState<StatusPage | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    const load = () => fetch(`${API_URL}/api/status`).then((r) => (r.ok ? r.json() : Promise.reject())).then((p) => { setPage(p); setFailed(false) }, () => setFailed(true))
    load()
    const t = setInterval(load, 60_000)
    return () => clearInterval(t)
  }, [])

  const state: ComponentState = failed ? 'down' : page?.state ?? 'unknown'
  return (
    <main className="min-h-screen bg-gray-950 px-4 py-12 sm:px-6">
      <div className="mx-auto max-w-3xl text-gray-300">
        <a href="/" className="text-sm text-gray-400 hover:text-white">← Back to Virvi</a>
        <h1 className="mt-6 text-3xl font-semibold tracking-tight text-white">Virvi status</h1>

        <section aria-live="polite" className="mt-6 flex items-center gap-3 rounded-lg border border-gray-800 bg-gray-900 p-5">
          <span aria-hidden className={`h-3 w-3 shrink-0 rounded-full ${DOT[state]}`} />
          <p className="text-lg font-medium text-white">
            {failed ? "Virvi's servers aren't answering. If this lasts more than a few minutes, we're on it." : page ? headline(page) : 'Checking…'}
          </p>
        </section>

        {page?.incidents.filter((i) => !i.resolvedAt).map((i) => <Incident key={i.id} incident={i} open />)}

        {page && (
          <section className="mt-10" aria-labelledby="components">
            <div className="flex items-baseline justify-between">
              <h2 id="components" className="text-xl font-semibold text-white">The last 90 days</h2>
              <span className="text-xs text-gray-400">Checked every minute</span>
            </div>
            <ul className="mt-4 space-y-6">
              {page.components.map((c) => (
                <li key={c.key} className="rounded-lg border border-gray-800 bg-gray-900 p-5">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <h3 className="font-medium text-white">{c.label}</h3>
                    <span className="flex items-center gap-2 text-sm">
                      <span aria-hidden className={`h-2 w-2 rounded-full ${DOT[c.state]}`} />
                      {STATE_LABEL[c.state]}
                    </span>
                  </div>
                  {c.note && <p className="mt-1 text-xs text-gray-400">{c.note}</p>}
                  {c.detail && <p className="mt-1 text-sm text-amber-300">{c.detail}</p>}
                  <div role="img" aria-label={`${c.label}: ${formatUptime(c.uptime)} up over the last 90 days`} className="mt-4 flex h-8 gap-[2px]">
                    {c.days.map((d) => {
                      const b = dayBar(d)
                      return <span key={d.day} title={b.label} className={`flex-1 rounded-[1px] ${BAR[b.tone]}`} />
                    })}
                  </div>
                  <div className="mt-2 flex justify-between text-xs text-gray-400">
                    <span>90 days ago</span>
                    <span>{formatUptime(c.uptime)} up</span>
                    <span>Today</span>
                  </div>
                </li>
              ))}
            </ul>
            <p className="mt-4 text-xs text-gray-400">
              Virvi's server checks itself once a minute. A minute with no check counts as down, so an outage shows here once the
              server is back, even if it couldn't report while down.{page.since && ` Tracking began ${new Date(page.since).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}.`}
            </p>
          </section>
        )}

        {page && page.incidents.some((i) => i.resolvedAt) && (
          <section className="mt-10" aria-labelledby="past">
            <h2 id="past" className="text-xl font-semibold text-white">Past 14 days</h2>
            {page.incidents.filter((i) => i.resolvedAt).map((i) => <Incident key={i.id} incident={i} />)}
          </section>
        )}
        {page && !page.incidents.some((i) => i.resolvedAt) && <p className="mt-10 text-sm text-gray-400">No incidents in the past 14 days.</p>}
      </div>
    </main>
  )
}

function Incident({ incident: i, open = false }: { incident: StatusPage['incidents'][number]; open?: boolean }) {
  return (
    <article className={`mt-4 rounded-lg border p-5 ${open ? (i.kind === 'maintenance' ? 'border-blue-800 bg-blue-950/30' : 'border-amber-700 bg-amber-950/30') : 'border-gray-800 bg-gray-900'}`}>
      <h3 className="font-medium text-white">{i.kind === 'maintenance' ? 'Maintenance: ' : ''}{i.title}</h3>
      <ol className="mt-3 space-y-3">
        {i.updates.map((u, n) => (
          <li key={n} className="text-sm">
            <p><span className="font-medium text-white">{STATUS_WORD[u.status] ?? u.status}.</span> {u.body}</p>
            <p className="mt-0.5 text-xs text-gray-400"><time dateTime={u.at}>{when(u.at)}</time></p>
          </li>
        ))}
      </ol>
    </article>
  )
}
