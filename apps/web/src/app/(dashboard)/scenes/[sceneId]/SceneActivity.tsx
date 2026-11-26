'use client'
import { useEffect, useState } from 'react'
import { useApi } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { relativeTime } from '@/lib/studio'
import { activityActor, describeActivity, nextCursor, VIA_LABEL, type SceneActivityEntry } from '@/lib/scene-activity'

const friendly = (err: any): string =>
  err?.message === 'Forbidden' ? 'Only the host and co-hosts can see who changed what.' : err?.message ?? 'Something went wrong'

/** Who changed what in this scene, and when (LIV-32). Host and co-hosts only. */
export function SceneActivity({ sceneId }: { sceneId: string }) {
  const { token } = useAuth()
  const api = useApi()
  const [entries, setEntries] = useState<SceneActivityEntry[] | null>(null)
  const [more, setMore] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const now = new Date()

  const load = async (before?: string) => {
    setBusy(true)
    try {
      const page = await api.getSceneActivity(sceneId, before)
      setEntries((prev) => (before && prev ? [...prev, ...page.entries] : page.entries))
      setMore(page.more)
      setError(null)
    } catch (err: any) {
      setError(friendly(err))
    } finally {
      setBusy(false)
    }
  }
  // useApi() returns new functions every render; reload when the scene or session changes
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { load() }, [sceneId, token])

  return (
    <div className="rounded-lg border border-gray-800 bg-gray-900 p-6">
      <div className="mb-1 flex items-center justify-between">
        <h2 className="text-sm font-medium text-gray-300">Activity</h2>
        <button type="button" disabled={busy} onClick={() => load()} className="text-xs text-gray-400 hover:text-gray-200 disabled:opacity-50">Refresh</button>
      </div>
      <p className="mb-4 text-xs text-gray-400">Who changed what in this scene, in the dashboard and in-world. Repeat edits of one thing within a minute show as one line.</p>
      {error && <div className="mb-3 rounded-md border border-red-700 bg-red-900/50 px-4 py-2 text-sm text-red-300">{error}</div>}
      {entries && entries.length === 0 && <p className="text-sm text-gray-400">Nothing yet. Changes to this scene will show up here.</p>}
      {entries && entries.length > 0 && (
        <ol className="divide-y divide-gray-800">
          {entries.map((e) => (
            <li key={e.id} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 py-2 text-sm">
              <span className="text-gray-200">
                <span className="font-medium text-white" title={e.actor.wallet ?? undefined}>{activityActor(e)}</span> {describeActivity(e)}
              </span>
              <span className="flex items-baseline gap-2 text-xs text-gray-400">
                <span>{VIA_LABEL[e.via] ?? e.via}</span>
                <time dateTime={e.at} title={new Date(e.at).toLocaleString()}>{relativeTime(e.at, now)}</time>
              </span>
            </li>
          ))}
        </ol>
      )}
      {more && (
        <button type="button" disabled={busy} onClick={() => load(nextCursor(entries ?? []))}
          className="mt-3 rounded-md bg-gray-800 px-3 py-1.5 text-xs text-gray-200 hover:bg-gray-700 disabled:opacity-50">
          {busy ? 'Loading…' : 'Show older'}
        </button>
      )}
    </div>
  )
}
