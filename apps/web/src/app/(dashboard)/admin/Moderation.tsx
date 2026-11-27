'use client'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useApi, type AdminModeration } from '@/lib/api'
import { logLine } from '@/lib/moderation'

/** Owners' appeals of takedowns, and the log of every moderation decision (LIV-34). */
export default function Moderation() {
  const api = useApi()
  const apiRef = useRef(api)
  apiRef.current = api
  const [data, setData] = useState<AdminModeration | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [replies, setReplies] = useState<Record<string, string>>({})

  const load = useCallback(async () => {
    try { setData(await apiRef.current.getAdminModeration()); setError(null) } catch (e: any) { setError(e?.message ?? 'Could not load moderation') }
  }, [])
  useEffect(() => { void load() }, [load])

  const decide = async (id: string, decision: 'restore' | 'reject') => {
    setBusy(id); setError(null)
    try { await api.decideAppeal(id, decision, replies[id] ?? ''); await load() } catch (e: any) { setError(e?.message ?? 'Something went wrong') } finally { setBusy(null) }
  }

  return (
    <section className="mt-8 rounded-lg border border-gray-800 bg-gray-900 p-5" aria-labelledby="moderation-heading">
      <h2 id="moderation-heading" className="text-sm font-medium text-white">Takedown appeals</h2>
      {error && <p role="alert" className="mt-2 text-sm text-red-300">{error}</p>}
      {data && data.appeals.length === 0 && <p className="mt-2 text-sm text-gray-400">No open appeals.</p>}
      <ul className="mt-3 space-y-4">
        {data?.appeals.map((a) => (
          <li key={a.id} className="rounded-md border border-gray-800 p-4">
            <p className="text-sm text-white">{a.asset.name} <span className="text-gray-400">by {a.owner?.displayName ?? 'a deleted account'}</span></p>
            <p className="mt-1 text-xs text-gray-400">Taken down: {a.asset.takedownReason ?? 'no reason recorded'}</p>
            <p className="mt-2 whitespace-pre-wrap text-sm text-gray-200">{a.message}</p>
            <label className="mt-3 block text-xs text-gray-300">Reply to the owner (needed to turn it down)
              <input value={replies[a.id] ?? ''} maxLength={1000} onChange={(e) => setReplies({ ...replies, [a.id]: e.target.value })}
                className="mt-1 w-full rounded-md border border-gray-700 bg-gray-950 px-3 py-1.5 text-sm text-white outline-none focus:border-blue-400" />
            </label>
            <div className="mt-2 flex gap-2">
              <button type="button" disabled={busy === a.id} onClick={() => decide(a.id, 'restore')} className="rounded-md bg-blue-600 px-3 py-1 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50">Restore</button>
              <button type="button" disabled={busy === a.id || !(replies[a.id] ?? '').trim()} onClick={() => decide(a.id, 'reject')} className="rounded-md border border-gray-700 px-3 py-1 text-xs hover:border-gray-500 disabled:opacity-50">Turn down</button>
            </div>
          </li>
        ))}
      </ul>

      <h2 className="mt-8 text-sm font-medium text-white">Moderation log</h2>
      {data && data.log.length === 0 && <p className="mt-2 text-sm text-gray-400">No decisions yet.</p>}
      <ol className="mt-3 divide-y divide-gray-800 text-sm">
        {data?.log.map((l) => (
          <li key={l.id} className="flex flex-wrap justify-between gap-x-4 py-2">
            <span className="text-gray-200">{logLine(l)}{l.reason ? <span className="text-gray-400">: {l.reason}</span> : null}</span>
            <span className="text-xs text-gray-400">{l.actor ?? 'An admin'}, <time dateTime={l.createdAt}>{new Date(l.createdAt).toLocaleString()}</time></span>
          </li>
        ))}
      </ol>
    </section>
  )
}
