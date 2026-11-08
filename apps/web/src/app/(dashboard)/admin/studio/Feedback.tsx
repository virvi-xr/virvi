'use client'

import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { useApi } from '@/lib/api'
import { Badge, Skeleton } from '@/components/ui'
import { adminActionMessage, kindLabel, latestOnly } from '@/lib/studio'
import { RATING_TAGS, costLabel, draftKind, tagLabel, whoLabel, type AdminRating, type ReviewFilters } from '@/lib/studio-ratings'

const dateFmt = new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'short' })
const inputClass = 'rounded-md border border-gray-800 bg-gray-950 px-3 py-1.5 text-sm'
const smallButton = 'rounded-md bg-gray-800 px-3 py-1.5 text-sm hover:bg-gray-700 disabled:opacity-50'
const KINDS = [['', 'All kinds'], ['wearable', 'Wearables'], ['emote', 'Emotes'], ['scene', 'Scene pieces']] as const

/**
 * 👎 revisions to review (LIV-142), newest first: what the owner said, the renders, the prompt and the reply, and a link
 * to open the design as Virvi support. Tick several of one kind to have a lesson drafted from them.
 */
export default function Feedback({ drafting, onLessonDrafted }: { drafting: boolean; onLessonDrafted: () => void }) {
  const api = useApi()
  const apiRef = useRef(api)
  apiRef.current = api
  const [filters, setFilters] = useState<ReviewFilters>({ handled: 'false' })
  const [rows, setRows] = useState<AdminRating[] | null>(null)
  const [next, setNext] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [ticked, setTicked] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const gate = useRef(latestOnly())

  useEffect(() => {
    const id = gate.current.next()
    setRows(null)
    setError(null)
    apiRef.current.getAdminStudioRatings(filters)
      .then((r) => { if (gate.current.isLatest(id)) { setRows(r.ratings); setNext(r.nextCursor) } })
      .catch((e) => { if (gate.current.isLatest(id)) setError(adminActionMessage(e)) })
  }, [filters])

  const more = async () => {
    if (!next) return
    try {
      const r = await api.getAdminStudioRatings({ ...filters, cursor: next })
      setRows((prev) => [...(prev ?? []), ...r.ratings])
      setNext(r.nextCursor)
    } catch (e) {
      setError(adminActionMessage(e))
    }
  }

  const mark = async (r: AdminRating, change: { handled?: boolean; autoCheck?: boolean }) => {
    try {
      const m = await api.markAdminStudioRating(r.id, change)
      setRows((prev) => prev?.map((x) => (x.id === r.id ? { ...x, handledAt: m.handledAt, autoCheck: m.autoCheck } : x)) ?? null)
    } catch (e) {
      setError(adminActionMessage(e))
    }
  }

  const chosen = (rows ?? []).filter((r) => ticked.includes(r.id))
  const draft = draftKind(chosen)
  const draftLesson = async () => {
    if ('problem' in draft) { setNote(draft.problem); return }
    setBusy(true)
    setNote(null)
    try {
      await api.draftAdminStudioLesson(chosen.map((r) => r.id))
      setTicked([])
      setNote('Lesson drafted: edit it and approve it under Lessons. Nothing is sent to the agent until you do.')
      onLessonDrafted()
    } catch (e) {
      setNote(adminActionMessage(e))
    } finally {
      setBusy(false)
    }
  }

  const set = (k: keyof ReviewFilters, v: string) => { setTicked([]); setFilters((f) => ({ ...f, [k]: v })) }

  return (
    <section aria-labelledby="feedback-title" className="mt-10">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <h2 id="feedback-title" className="text-lg font-semibold">👎 to review</h2>
        <div className="flex flex-wrap items-center gap-2">
          <label htmlFor="fb-kind" className="sr-only">Kind</label>
          <select id="fb-kind" value={filters.kind ?? ''} onChange={(e) => set('kind', e.target.value)} className={inputClass}>
            {KINDS.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
          </select>
          <label htmlFor="fb-tag" className="sr-only">Tag</label>
          <select id="fb-tag" value={filters.tag ?? ''} onChange={(e) => set('tag', e.target.value)} className={inputClass}>
            <option value="">All tags</option>
            {RATING_TAGS.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
          </select>
          <label htmlFor="fb-agent" className="sr-only">Agent</label>
          <select id="fb-agent" value={filters.agent ?? ''} onChange={(e) => set('agent', e.target.value)} className={inputClass}>
            <option value="">All agents</option>
            <option value="claude">Claude Code</option>
            <option value="codex">Codex</option>
            <option value="grok">Grok Build</option>
          </select>
          <label htmlFor="fb-model" className="sr-only">Model</label>
          <input id="fb-model" type="search" placeholder="Model" maxLength={200} defaultValue={filters.model ?? ''}
            onKeyDown={(e) => { if (e.key === 'Enter') set('model', (e.target as HTMLInputElement).value) }} className={`${inputClass} w-36`} />
          <label htmlFor="fb-handled" className="sr-only">Handled</label>
          <select id="fb-handled" value={filters.handled ?? ''} onChange={(e) => set('handled', e.target.value)} className={inputClass}>
            <option value="false">Not handled</option>
            <option value="true">Handled</option>
            <option value="">All</option>
          </select>
        </div>
      </div>
      {drafting && (
        <div className="mb-3 flex flex-wrap items-center gap-3 text-sm">
          <button type="button" disabled={busy || !ticked.length} onClick={draftLesson} className={smallButton}>
            {busy ? 'Drafting…' : `Draft a lesson${ticked.length ? ` from ${ticked.length}` : ''}`}
          </button>
          <span className="text-gray-400">Tick 👎s of one kind and Claude drafts one lesson from them for you to edit and approve.</span>
        </div>
      )}
      {note && <p className="mb-3 text-sm text-gray-300" role="status">{note}</p>}
      {error && <p className="mb-3 text-sm text-red-400" role="alert">{error}</p>}
      {!rows ? (error ? null : <Skeleton rows={2} className="h-24" />) : rows.length === 0 ? (
        <p className="text-gray-400">No 👎 matches.</p>
      ) : (
        <ul className="space-y-3">
          {rows.map((r) => (
            <li key={r.id} className="rounded-lg border border-gray-800 bg-gray-900 p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <label className="flex min-w-0 items-start gap-2">
                  {drafting && (
                    <input type="checkbox" className="mt-1" checked={ticked.includes(r.id)} aria-label={`Use ${r.design.name} for a lesson`}
                      onChange={() => setTicked((t) => (t.includes(r.id) ? t.filter((x) => x !== r.id) : [...t, r.id]))} />
                  )}
                  <span className="min-w-0">
                    <span className="block font-medium">{r.design.name} <span className="text-sm text-gray-500">· {kindLabel(r.kind)}</span></span>
                    <span className="block text-sm text-gray-400">
                      {r.owner.trial ? 'Free-trial visitor' : r.owner.name || r.owner.email || r.owner.id} · {whoLabel(r.agent, r.model)} · {costLabel(r.costUsd)} · {dateFmt.format(new Date(r.createdAt))}
                    </span>
                  </span>
                </label>
                <div className="flex flex-wrap items-center gap-2">
                  {r.handledAt && <Badge tone="success">Handled</Badge>}
                  <Link href={`/studio/${r.design.id}`} className={smallButton}>Open as support</Link>
                  <button type="button" onClick={() => mark(r, { handled: !r.handledAt })} className={smallButton}>{r.handledAt ? 'Mark not handled' : 'Mark handled'}</button>
                  <label className="flex items-center gap-1.5 text-sm text-gray-300">
                    <input type="checkbox" checked={r.autoCheck} onChange={() => mark(r, { autoCheck: !r.autoCheck })} />
                    Could be checked automatically
                  </label>
                </div>
              </div>
              {(r.tags.length > 0 || r.note) && (
                <div className="mt-3 text-sm">
                  {r.tags.length > 0 && <p className="flex flex-wrap gap-1.5">{r.tags.map((t) => <Badge key={t} tone="warning">{tagLabel(t)}</Badge>)}</p>}
                  {r.note && <p className="mt-1 whitespace-pre-wrap break-words text-gray-200">“{r.note}”</p>}
                </div>
              )}
              <dl className="mt-3 grid gap-2 text-sm sm:grid-cols-2">
                <div>
                  <dt className="text-xs text-gray-500">The prompt</dt>
                  <dd className="whitespace-pre-wrap break-words text-gray-200">{r.prompt || '—'}</dd>
                </div>
                <div>
                  <dt className="text-xs text-gray-500">The agent’s reply</dt>
                  <dd className="line-clamp-6 whitespace-pre-wrap break-words text-gray-300">{r.reply || '—'}</dd>
                </div>
              </dl>
              {r.pieces.some((p) => p.views.length) && (
                <div className="mt-3 flex flex-wrap gap-3">
                  {r.pieces.flatMap((p) => p.views.slice(0, 3).map((v) => (
                    <figure key={`${p.category}-${v.viewKey}`} className="w-32">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={v.url} alt={`${p.name}, revision ${p.number}, ${v.viewKey}`} className="aspect-square w-full rounded-md bg-gray-950 object-contain" />
                      <figcaption className="mt-1 truncate text-xs text-gray-500">{p.name} r{p.number} · {v.viewKey}</figcaption>
                    </figure>
                  )))}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      {next && rows && <button type="button" onClick={more} className={`mt-3 ${smallButton}`}>Show more</button>}
    </section>
  )
}
