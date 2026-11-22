'use client'
// The dashboard's AR tab: the Virvi AR apps, and the way into each scene's AR spaces (set up on the scene's own page).
import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useApi } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { PageHeader } from '@/components/ui'
import { ArAppCards } from '@/components/ar/ArAppCards'

type SceneRow = { id: string; name: string }

export default function ArAppsPage() {
  const { token } = useAuth()
  const api = useApi()
  const [scenes, setScenes] = useState<SceneRow[] | null>(null)

  useEffect(() => {
    if (!token) return
    let cancelled = false
    api.getScenes()
      .then((r) => { if (!cancelled) setScenes((r.scenes ?? []).map((s: any) => ({ id: String(s.id), name: s.name || 'Untitled scene' }))) })
      .catch(() => { if (!cancelled) setScenes([]) })
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token])

  return (
    <div className="max-w-5xl">
      <PageHeader title="AR" subtitle="Put your scene in a real place, life-size, with a ring by the door." />

      <section aria-labelledby="ar-apps">
        <h2 id="ar-apps" className="mb-3 text-lg font-semibold">The apps</h2>
        <ArAppCards />
        <p className="mt-3 text-sm text-gray-400"><a href="/ar/" className="underline underline-offset-2 hover:text-white">The AR page</a> has more, for anyone to read.</p>
      </section>

      <section aria-labelledby="ar-setup" className="mt-10">
        <h2 id="ar-setup" className="mb-1 text-lg font-semibold">Set up an AR Space</h2>
        <p className="mb-3 text-sm text-gray-400">Open a scene and go to its AR spaces tab: add a space, print its ring, then line it up and publish from a headset.</p>
        {scenes === null ? (
          <p className="text-sm text-gray-500">Loading your scenes…</p>
        ) : scenes.length === 0 ? (
          <p className="text-sm text-gray-400">You have no scenes yet. <Link href="/scenes" className="text-blue-300 underline">Make one</Link> first.</p>
        ) : (
          <ul className="divide-y divide-gray-800 rounded-lg border border-gray-800">
            {scenes.map((s) => (
              <li key={s.id}>
                <Link href={`/scenes?id=${encodeURIComponent(s.id)}`} className="flex items-center justify-between gap-3 px-4 py-3 text-sm hover:bg-white/[0.03]">
                  <span className="min-w-0 truncate text-gray-200">{s.name}</span>
                  <span className="shrink-0 text-gray-500">AR spaces →</span>
                </Link>
              </li>
            ))}
          </ul>
        )}
        <p className="mt-4 text-sm text-gray-400">
          Headsets you paired are in <Link href="/settings" className="text-blue-300 underline">Settings</Link>, under Paired headsets.
        </p>
      </section>
    </div>
  )
}
