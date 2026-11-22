'use client'
import { useEffect, useState } from 'react'
import type { AssistantActionView } from '@virvixr/shared'
import { useApi } from '@/lib/api'
import { appendActivity, replaceActivity, type ActivityState } from '@/lib/assistant/state'
import { ActionRow, refusalMessage } from '@/components/assistant/ActionRow'
import { activityDate } from '@/components/assistant/copy'

/**
 * The rows, newest first: each change with its organization, date, status and Undo; "Load more" while there are older
 * ones. When the first page failed, its error and Try again.
 */
export function ActivityList({ list, loadingMore, error, onMore, onRetry, onUndo }: {
  /** null while the first page loads, or when it failed (`error`) */
  list: ActivityState | null
  loadingMore: boolean
  error: string | null
  onMore: () => void
  onRetry: () => void
  onUndo: (id: string) => Promise<void>
}) {
  return (
    <div className="rounded-lg border border-gray-800 bg-gray-900 p-6">
      <h3 className="text-sm font-medium text-gray-300">Assistant activity</h3>
      <p className="mt-1 text-sm text-gray-500">Everything the assistant has changed for you, newest first.</p>
      <div className="mt-4">
        {list === null ? (
          error ? null : <p className="text-sm text-gray-500">Loading…</p>
        ) : list.items.length === 0 ? (
          <p className="text-sm text-gray-500">Nothing yet. Changes the assistant makes show here.</p>
        ) : (
          <ul className="space-y-1.5">
            {list.items.map((a) => <ActionRow key={a.id} action={a} note={activityDate(a.createdAt)} onUndo={onUndo} />)}
          </ul>
        )}
        {error && <p className="mt-2 text-sm text-red-300" role="alert">{error}</p>}
        {list === null && error && (
          <button type="button" onClick={onRetry} disabled={loadingMore}
            className="mt-3 rounded border border-gray-700 px-3 py-1.5 text-sm text-gray-300 hover:text-white disabled:opacity-50">
            {loadingMore ? 'Loading…' : 'Try again'}
          </button>
        )}
        {list?.next && (
          <button type="button" onClick={onMore} disabled={loadingMore}
            className="mt-3 rounded border border-gray-700 px-3 py-1.5 text-sm text-gray-300 hover:text-white disabled:opacity-50">
            {loadingMore ? 'Loading…' : 'Load more'}
          </button>
        )}
      </div>
    </div>
  )
}

/** Settings' "Assistant activity" section; not shown while the assistant is hidden for this account. */
export function AssistantActivity() {
  const api = useApi()
  const [shown, setShown] = useState(false)
  const [list, setList] = useState<ActivityState | null>(null)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    api.getAssistantStatus()
      .then(async (a) => {
        if (!live || a.state === 'hidden') return
        setShown(true)
        const page = await api.getAssistantActivity()
        if (live) setList(appendActivity(null, page))
      })
      .catch((err) => { if (live) setError(refusalMessage(err)) })
    return () => { live = false }
  }, [api])

  const retry = async () => {
    setLoadingMore(true)
    setError(null)
    try {
      setList(appendActivity(null, await api.getAssistantActivity()))
    } catch (err) {
      setError(refusalMessage(err))
    } finally {
      setLoadingMore(false)
    }
  }

  const more = async () => {
    if (!list?.next) return
    setLoadingMore(true)
    setError(null)
    try {
      const page = await api.getAssistantActivity(list.next)
      setList((l) => appendActivity(l, page))
    } catch (err) {
      setError(refusalMessage(err))
    } finally {
      setLoadingMore(false)
    }
  }

  const undo = async (id: string) => {
    const view: AssistantActionView = await api.undoAssistantAction(id)
    setList((l) => (l ? replaceActivity(l, view) : l))
  }

  if (!shown) return null
  return <ActivityList list={list} loadingMore={loadingMore} error={error} onMore={more} onRetry={retry} onUndo={undo} />
}
