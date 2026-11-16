'use client'
// A scene's BEATs (LIV-11), on the scene page: the BEATs that include this scene, and "New BEAT" with it picked.
import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useApi } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { beatFieldError, beatHref, beatWindow, newBeatHref, type PublicBeat } from '@/lib/beats'
import { useBeatAvailability } from '@/lib/use-beats'
import { BeatBadges, BeatsNotice } from './BeatBits'

/** Renders nothing while BEATs are off. */
export function SceneBeats({ sceneId }: { sceneId: string }) {
  const availability = useBeatAvailability()
  const { token } = useAuth()
  const api = useApi()
  const [beats, setBeats] = useState<PublicBeat[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const on = !!availability?.enabled

  useEffect(() => {
    if (!on || !token) return
    api.listSceneBeats(sceneId).then((b) => { setBeats(b); setError(null) }).catch((err) => setError(beatFieldError(err).message))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [on, sceneId, token])

  if (!on) return null
  return (
    <div className="rounded-lg border border-gray-800 bg-gray-900 p-6">
      <div className="mb-4 flex items-center justify-between">
        <h3 className="text-sm font-medium text-gray-300">BEATs</h3>
        {availability.canCreate && (
          <Link href={newBeatHref(sceneId)} className="rounded-md bg-orange-600 px-3 py-1.5 text-sm text-white hover:bg-orange-500">New BEAT</Link>
        )}
      </div>
      <BeatsNotice a={availability} />
      {error && <div className="mb-3 rounded-md border border-red-700 bg-red-900/50 px-4 py-2 text-sm text-red-300">{error}</div>}
      {beats && beats.length === 0 && <p className="text-sm text-gray-400">No BEATs in this scene yet.</p>}
      <ul className="space-y-2">
        {beats?.map((b) => (
          <li key={b.id}>
            <Link href={beatHref(b.id)} className="flex items-center justify-between gap-3 rounded-md bg-gray-800 px-4 py-2 text-sm hover:bg-gray-700">
              <span className="min-w-0">
                <span className="block truncate text-gray-100">{b.name}</span>
                <span className="block truncate text-xs text-gray-400">{beatWindow(b)}</span>
              </span>
              <BeatBadges status={b.status} test={b.test} />
            </Link>
          </li>
        ))}
      </ul>
    </div>
  )
}
