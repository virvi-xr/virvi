'use client'
import { useCallback, useEffect, useState } from 'react'
import { useAuth } from '@/lib/auth'
import { useApi, type NotificationGroupSetting } from '@/lib/api'
import { Skeleton } from '@/components/ui'

/**
 * Account settings card (LIV-30): which notices reach the bell. Invitations, and notices about your own models being
 * taken down or appealed, always arrive, so they aren't listed.
 */
export function NotificationSettings() {
  const { token } = useAuth()
  const api = useApi()
  const [groups, setGroups] = useState<NotificationGroupSetting[] | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      setGroups((await api.getNotificationSettings()).groups)
    } catch (err: any) {
      setError(err?.message ?? "Couldn't load your notification settings")
      setGroups([])
    }
    // useApi() returns new functions every render; reload only when the session changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token])

  useEffect(() => { load() }, [load])

  const toggle = async (g: NotificationGroupSetting) => {
    setError(null)
    setBusy(g.id)
    try {
      setGroups((await api.setNotificationGroup(g.id, !g.on)).groups)
    } catch (err: any) {
      setError(err?.message ?? "Couldn't save that setting")
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="rounded-lg border border-gray-800 bg-gray-900 p-6">
      <h3 className="text-sm font-medium text-gray-300 mb-1">Notifications</h3>
      <p className="text-xs text-gray-500 mb-3">
        What shows in the bell. Invitations, and notices about your own models being taken down or appealed, always arrive.
      </p>
      {error && <div role="alert" className="mb-3 rounded-md bg-red-900/50 border border-red-700 px-4 py-2 text-sm text-red-300">{error}</div>}
      {groups === null ? (
        <Skeleton rows={3} className="h-10" />
      ) : (
        <ul className="space-y-2">
          {groups.map((g) => (
            <li key={g.id} className="flex items-center justify-between gap-3 rounded-md bg-gray-800 px-4 py-2 text-sm">
              <label htmlFor={`notify-${g.id}`} className="min-w-0 cursor-pointer">
                <span className="block text-gray-200">{g.label}</span>
                <span className="block text-xs text-gray-400">{g.description}</span>
              </label>
              <input id={`notify-${g.id}`} type="checkbox" role="switch" checked={g.on} disabled={busy === g.id} onChange={() => toggle(g)}
                className="h-4 w-4 shrink-0 accent-blue-500" />
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
