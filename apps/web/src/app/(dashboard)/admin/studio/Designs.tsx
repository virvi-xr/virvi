'use client'

import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { useApi } from '@/lib/api'
import { Badge, Skeleton } from '@/components/ui'
import { kindLabel, latestOnly } from '@/lib/studio'
import { adminDesignOwner, pieceCountLabel, type AdminDesign } from '@/lib/studio-support'

const dateFmt = new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'short' })
const inputClass = 'rounded-md border border-gray-800 bg-gray-950 px-3 py-1.5 text-sm'
const KINDS = [['', 'All kinds'], ['wearable', 'Wearables'], ['emote', 'Emotes'], ['scene', 'Scene pieces']] as const

/**
 * Everyone's designs, trial ones included, newest activity first: search by owner or design, and open one to help
 * (it opens on the design's own page, as Virvi support).
 */
export default function AdminDesigns() {
  const api = useApi()
  const apiRef = useRef(api)
  apiRef.current = api
  const [q, setQ] = useState('')
  const [search, setSearch] = useState('')
  const [kind, setKind] = useState('')
  const [rows, setRows] = useState<AdminDesign[] | null>(null)
  const [next, setNext] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loadingMore, setLoadingMore] = useState(false)
  const gate = useRef(latestOnly())

  useEffect(() => {
    const id = gate.current.next()
    setRows(null)
    setError(null)
    apiRef.current.getAdminStudioDesigns({ q: search, kind })
      .then((r) => { if (gate.current.isLatest(id)) { setRows(r.designs); setNext(r.nextCursor) } })
      .catch((e) => { if (gate.current.isLatest(id)) setError((e as Error)?.message ?? 'Something went wrong') })
  }, [search, kind])

  const more = async () => {
    if (!next) return
    setLoadingMore(true)
    try {
      const r = await api.getAdminStudioDesigns({ q: search, kind, cursor: next })
      setRows((prev) => [...(prev ?? []), ...r.designs])
      setNext(r.nextCursor)
    } catch (e) {
      setError((e as Error)?.message ?? 'Something went wrong')
    } finally {
      setLoadingMore(false)
    }
  }

  return (
    <section aria-labelledby="designs-title">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <h2 id="designs-title" className="text-lg font-semibold">Designs</h2>
        <form className="flex flex-wrap items-center gap-2" onSubmit={(e) => { e.preventDefault(); setSearch(q) }}>
          <label htmlFor="designs-q" className="sr-only">Search designs</label>
          <input id="designs-q" type="search" value={q} onChange={(e) => setQ(e.target.value)} maxLength={200}
            placeholder="Email, wallet, name, design or id" className={`${inputClass} w-64`} />
          <label htmlFor="designs-kind" className="sr-only">Kind</label>
          <select id="designs-kind" value={kind} onChange={(e) => setKind(e.target.value)} className={inputClass}>
            {KINDS.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
          </select>
          <button type="submit" className="rounded-md bg-gray-800 px-3 py-1.5 text-sm hover:bg-gray-700">Search</button>
        </form>
      </div>
      <p className="mb-3 text-sm text-gray-400">Open a design to help: your messages show in its conversation as Virvi support, and nothing you send or finalize is charged.</p>
      {error && <p className="mb-3 text-sm text-red-400" role="alert">{error}</p>}
      {!rows ? (error ? null : <Skeleton rows={3} className="h-12" />) : rows.length === 0 ? (
        <p className="text-gray-400">{search || kind ? 'No design matches.' : 'No designs yet.'}</p>
      ) : (
        <ul className="divide-y divide-gray-800 rounded-lg border border-gray-800 bg-gray-900">
          {rows.map((d) => {
            const owner = adminDesignOwner(d)
            return (
              <li key={d.id}>
                <Link href={`/studio/${d.id}`} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 hover:bg-white/[0.03]">
                  <span className="min-w-0">
                    <span className="block truncate font-medium">{d.name}</span>
                    <span className="block truncate text-sm text-gray-400">
                      {owner.name}{owner.detail ? ` · ${owner.detail}` : ''}
                    </span>
                  </span>
                  <span className="flex flex-wrap items-center gap-2 text-xs text-gray-400">
                    {d.owner.trial && <Badge tone="warning">Trial</Badge>}
                    {d.archivedAt && <Badge tone="neutral">Archived</Badge>}
                    <span>{kindLabel(d.kind)}</span>
                    <span>· {pieceCountLabel(d.pieceCount)}</span>
                    <span>· {d.lastPromptAt ? `last prompt ${dateFmt.format(new Date(d.lastPromptAt))}` : 'no prompts yet'}</span>
                  </span>
                </Link>
              </li>
            )
          })}
        </ul>
      )}
      {next && rows && (
        <button type="button" disabled={loadingMore} onClick={more} className="mt-3 rounded-md bg-gray-800 px-3 py-1.5 text-sm hover:bg-gray-700 disabled:opacity-50">
          {loadingMore ? 'Loading…' : 'Show more'}
        </button>
      )}
    </section>
  )
}
