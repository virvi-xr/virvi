'use client'

import { useEffect, useRef, useState } from 'react'
import { useApi } from '@/lib/api'
import { Badge, PrimaryButton, Skeleton } from '@/components/ui'
import { adminActionMessage, kindLabel } from '@/lib/studio'
import { lessonFits, lessonState, skillLesson, type AdminLesson, type LessonsList } from '@/lib/studio-ratings'

const smallButton = 'rounded-md bg-gray-800 px-3 py-1.5 text-sm hover:bg-gray-700 disabled:opacity-50'
const inputClass = 'rounded-md border border-gray-800 bg-gray-950 px-3 py-1.5 text-sm'
const KINDS = ['wearable', 'emote', 'scene'] as const

/**
 * Lessons for the agent per design kind (LIV-142). A draft (yours, or Claude's from 👎s) does nothing until approved;
 * approved and on, it goes with every new prompt of its kind. `version` changes when a lesson was drafted elsewhere.
 */
export default function Lessons({ version, onList }: { version: number; onList: (l: LessonsList) => void }) {
  const api = useApi()
  const apiRef = useRef(api)
  apiRef.current = api
  const [list, setList] = useState<LessonsList | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [kind, setKind] = useState<string>('wearable')
  const [text, setText] = useState('')

  const load = async () => {
    try {
      const l = await apiRef.current.getAdminStudioLessons()
      setList(l)
      onList(l)
    } catch (e) {
      setError(adminActionMessage(e))
    }
  }
  useEffect(() => { load() }, [version]) // eslint-disable-line react-hooks/exhaustive-deps

  const act = async (fn: () => Promise<unknown>) => {
    setError(null)
    try { await fn(); await load() } catch (e) { setError(adminActionMessage(e)) }
  }
  const add = (e: React.FormEvent) => {
    e.preventDefault()
    if (!text.trim()) return
    act(async () => { await api.createAdminStudioLesson({ kind, text }); setText('') })
  }

  return (
    <section aria-labelledby="lessons-title" className="mt-10">
      <h2 id="lessons-title" className="mb-1 text-lg font-semibold">Lessons for the agent</h2>
      <p className="mb-3 text-sm text-gray-400">Approved lessons that are on go with every new prompt of their kind, as extra instructions. Nothing goes to the agent until you approve it.</p>
      {list && (
        <p className="mb-3 text-xs text-gray-500">
          {KINDS.map((k) => `${kindLabel(k)}: ${list.used[k] ?? 0} of ${list.limit} characters live`).join(' · ')}
        </p>
      )}
      <form onSubmit={add} className="mb-4 flex flex-wrap items-start gap-2">
        <label htmlFor="lesson-kind" className="sr-only">Kind</label>
        <select id="lesson-kind" value={kind} onChange={(e) => setKind(e.target.value)} className={inputClass}>
          {KINDS.map((k) => <option key={k} value={k}>{kindLabel(k)}</option>)}
        </select>
        <label htmlFor="lesson-text" className="sr-only">Lesson</label>
        <textarea id="lesson-text" rows={2} value={text} maxLength={list?.lessonMax ?? 500} onChange={(e) => setText(e.target.value)}
          placeholder="Write a lesson by hand" className={`${inputClass} min-w-64 flex-1`} />
        <PrimaryButton type="submit" disabled={!text.trim()}>Add draft</PrimaryButton>
      </form>
      {error && <p className="mb-3 text-sm text-red-400" role="alert">{error}</p>}
      {!list ? (error ? null : <Skeleton rows={2} className="h-16" />) : list.lessons.length === 0 ? (
        <p className="text-gray-400">No lessons yet.</p>
      ) : (
        <ul className="space-y-3">
          {list.lessons.map((l) => <LessonRow key={l.id} l={l} list={list} onAct={act} />)}
        </ul>
      )}
    </section>
  )
}

function LessonRow({ l, list, onAct }: { l: AdminLesson; list: LessonsList; onAct: (fn: () => Promise<unknown>) => Promise<void> }) {
  const api = useApi()
  const [text, setText] = useState(l.text)
  const [copied, setCopied] = useState(false)
  useEffect(() => setText(l.text), [l.text])
  const edited = text.trim() !== l.text
  const fits = lessonFits(list, l, text)
  const copy = async () => {
    try { await navigator.clipboard.writeText(skillLesson(l.kind, l.text)); setCopied(true) } catch { /* no clipboard */ }
  }
  return (
    <li className="rounded-lg border border-gray-800 bg-gray-900 p-4">
      <div className="mb-2 flex flex-wrap items-center gap-2 text-xs text-gray-400">
        <Badge tone={l.live ? 'success' : l.status === 'draft' ? 'warning' : 'neutral'}>{lessonState(l)}</Badge>
        <span>{kindLabel(l.kind)}</span>
        {l.drafted === 'claude' && <span>· drafted by Claude from {l.sourceRatingIds.length} 👎</span>}
      </div>
      <label htmlFor={`lesson-${l.id}`} className="sr-only">Lesson text</label>
      <textarea id={`lesson-${l.id}`} rows={2} value={text} maxLength={list.lessonMax} onChange={(e) => setText(e.target.value)}
        className="w-full rounded-md border border-gray-800 bg-gray-950 px-3 py-2 text-sm text-white" />
      {!fits && (l.live || l.status === 'draft') && <p className="mt-1 text-xs text-amber-300">This would put {kindLabel(l.kind).toLowerCase()} lessons past {list.limit} characters: switch another off or shorten it.</p>}
      <div className="mt-2 flex flex-wrap gap-2">
        {edited && <button type="button" onClick={() => onAct(() => api.updateAdminStudioLesson(l.id, { text }))} className={smallButton}>Save</button>}
        {l.status === 'draft' ? (
          <>
            <PrimaryButton type="button" disabled={!fits} onClick={() => onAct(() => api.updateAdminStudioLesson(l.id, { ...(edited ? { text } : {}), status: 'approved' }))}>Approve</PrimaryButton>
            <button type="button" onClick={() => onAct(() => api.deleteAdminStudioLesson(l.id))} className={smallButton}>Discard</button>
          </>
        ) : (
          <>
            <button type="button" onClick={() => onAct(() => api.updateAdminStudioLesson(l.id, { enabled: !l.enabled }))} className={smallButton}>{l.enabled ? 'Switch off' : 'Switch on'}</button>
            <button type="button" onClick={copy} className={smallButton}>{copied ? 'Copied' : 'Copy as skill lesson'}</button>
            <button type="button" onClick={() => onAct(() => api.deleteAdminStudioLesson(l.id))} className={smallButton}>Delete</button>
          </>
        )}
      </div>
    </li>
  )
}
