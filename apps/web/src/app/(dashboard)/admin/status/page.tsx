'use client'
import { useEffect, useState } from 'react'
import { useApi } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { ConfirmAction, PageHeader } from '@/components/ui'
import { INCIDENT_STATUSES, STATUS_WORD, type StatusPage } from '@/lib/status'

const field = 'w-full rounded-md border border-gray-800 bg-gray-950 px-3 py-2 text-sm text-white outline-none focus:border-blue-400'
const button = 'rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50'

/** Post incidents and maintenance notices to the public status page (LIV-40). Site admins only. */
export default function AdminStatusPage() {
  const api = useApi()
  const { token } = useAuth()
  const [page, setPage] = useState<StatusPage | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [draft, setDraft] = useState({ title: '', body: '', status: 'investigating', kind: 'incident' as 'incident' | 'maintenance', components: [] as string[] })

  const load = async () => { try { setPage(await api.getStatus()) } catch (e: any) { setError(e?.message ?? 'Could not load the status page') } }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { load() }, [token])
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true); setError(null)
    try { await fn(); await load() } catch (e: any) { setError(e?.message ?? 'Something went wrong') } finally { setBusy(false) }
  }

  return (
    <div className="max-w-3xl">
      <PageHeader crumbs={['System', { label: 'Admin', href: '/admin' }, 'Status page']} title="Status page"
        subtitle={<>Post incidents and planned maintenance to the public <a href="/status/" className="underline underline-offset-2">status page</a>. Updates show there within 30 seconds.</>} />
      {error && <div role="alert" className="mb-4 rounded-md border border-red-700 bg-red-900/50 px-4 py-2 text-sm text-red-300">{error}</div>}

      <form className="space-y-3 rounded-lg border border-gray-800 bg-gray-900 p-5"
        onSubmit={(e) => { e.preventDefault(); run(async () => { await api.createStatusIncident(draft); setDraft({ ...draft, title: '', body: '' }) }) }}>
        <h2 className="text-sm font-medium text-white">New post</h2>
        <div className="flex gap-4 text-sm">
          {(['incident', 'maintenance'] as const).map((k) => (
            <label key={k} className="flex items-center gap-2">
              <input type="radio" name="kind" checked={draft.kind === k} onChange={() => setDraft({ ...draft, kind: k })} />
              {k === 'incident' ? 'Incident' : 'Planned maintenance'}
            </label>
          ))}
        </div>
        <label className="block text-sm">Title
          <input className={`${field} mt-1`} value={draft.title} maxLength={120} required onChange={(e) => setDraft({ ...draft, title: e.target.value })} placeholder="Deploys to Worlds are failing" />
        </label>
        <label className="block text-sm">First update
          <textarea className={`${field} mt-1`} rows={3} value={draft.body} maxLength={2000} required onChange={(e) => setDraft({ ...draft, body: e.target.value })} />
        </label>
        <div className="flex flex-wrap items-end gap-4">
          <label className="text-sm">Status
            <select className={`${field} mt-1`} value={draft.status} onChange={(e) => setDraft({ ...draft, status: e.target.value })}>
              {INCIDENT_STATUSES.map((s) => <option key={s} value={s}>{STATUS_WORD[s]}</option>)}
            </select>
          </label>
          <fieldset className="text-sm">
            <legend>Affects</legend>
            <div className="mt-1 flex flex-wrap gap-3">
              {page?.components.map((c) => (
                <label key={c.key} className="flex items-center gap-2">
                  <input type="checkbox" checked={draft.components.includes(c.key)}
                    onChange={(e) => setDraft({ ...draft, components: e.target.checked ? [...draft.components, c.key] : draft.components.filter((k) => k !== c.key) })} />
                  {c.label}
                </label>
              ))}
            </div>
          </fieldset>
        </div>
        <button type="submit" disabled={busy} className={button}>Post</button>
      </form>

      <h2 className="mb-3 mt-8 text-sm font-medium text-white">Open and recent</h2>
      {page && page.incidents.length === 0 && <p className="text-sm text-gray-400">Nothing posted in the past 14 days.</p>}
      <ul className="space-y-4">
        {page?.incidents.map((i) => <IncidentRow key={i.id} incident={i} busy={busy} run={run} />)}
      </ul>
    </div>
  )
}

function IncidentRow({ incident: i, busy, run }: { incident: StatusPage['incidents'][number]; busy: boolean; run: (fn: () => Promise<unknown>) => Promise<void> }) {
  const api = useApi()
  const [status, setStatus] = useState(i.status === 'resolved' ? 'resolved' : i.status)
  const [body, setBody] = useState('')
  return (
    <li className="rounded-lg border border-gray-800 bg-gray-900 p-5">
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="font-medium text-white">{i.kind === 'maintenance' ? 'Maintenance: ' : ''}{i.title}</h3>
        <span className="text-xs text-gray-400">{STATUS_WORD[i.status] ?? i.status}</span>
      </div>
      <ol className="mt-2 space-y-1 text-sm text-gray-300">
        {i.updates.map((u, n) => <li key={n}><span className="text-white">{STATUS_WORD[u.status]}:</span> {u.body} <span className="text-xs text-gray-400">{new Date(u.at).toLocaleString()}</span></li>)}
      </ol>
      <form className="mt-3 flex flex-wrap gap-2" onSubmit={(e) => { e.preventDefault(); run(async () => { await api.addStatusUpdate(i.id, { status, body }); setBody('') }) }}>
        <select aria-label={`Status for ${i.title}`} className={`${field} w-auto`} value={status} onChange={(e) => setStatus(e.target.value)}>
          {INCIDENT_STATUSES.map((s) => <option key={s} value={s}>{STATUS_WORD[s]}</option>)}
        </select>
        <input aria-label={`Update for ${i.title}`} className={`${field} min-w-0 flex-1`} value={body} maxLength={2000} required onChange={(e) => setBody(e.target.value)} placeholder="What's changed" />
        <button type="submit" disabled={busy} className={button}>Add update</button>
        <ConfirmAction disabled={busy} confirmLabel="Delete" prompt={`Delete "${i.title}" from the status page? Its updates go too.`}
          onConfirm={() => run(() => api.deleteStatusIncident(i.id))} className="text-xs text-red-400 hover:underline">Delete</ConfirmAction>
      </form>
    </li>
  )
}
