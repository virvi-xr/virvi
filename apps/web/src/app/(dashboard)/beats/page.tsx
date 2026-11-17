'use client'
// BEATs (LIV-11): the host's BEATs, newest first. `?id=` opens one, as `/scenes?id=` opens a scene.
import { Suspense, useEffect, useState } from 'react'
import Link from 'next/link'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { useApi } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { CREATE_CLOSED, beatCounts, beatFieldError, beatHref, beatWindow, newBeatHref, type BeatAvailability, type PublicBeat } from '@/lib/beats'
import { countLabel } from '@/lib/format'
import { EmptyState, PageHeader, Skeleton } from '@/components/ui'
import { MedalIcon, PlusIcon } from '@/components/icons'
import { BeatBadges, BeatsGate } from '@/components/beats/BeatBits'
import { CollectedBeats } from '@/components/beats/CollectedBeats'
import BeatDetailPage from './[beatId]/client'

/** PrimaryButton's look, on a link to the create page. */
const NEW_BEAT_CLASS = 'clip-corner inline-flex items-center gap-1.5 bg-accent px-4 py-2.5 text-sm font-semibold text-accent-ink transition-colors hover:bg-accent-hover'

export default function BeatsPage() {
  return (
    <Suspense fallback={<Skeleton />}>
      <BeatsContent />
    </Suspense>
  )
}

function BeatsContent() {
  const searchParams = useSearchParams()
  const router = useRouter()
  const pathname = usePathname()
  if (searchParams.get('id')) return <BeatDetailPage />
  // Collected is the default; the tab lives in the URL (?tab=hosting) so it survives a reload
  const tab = searchParams.get('tab') === 'hosting' ? 'hosting' : 'collected'
  const pick = (t: 'collected' | 'hosting') => router.replace(t === 'hosting' ? `${pathname}?tab=hosting` : pathname)
  return (
    <div className="mx-auto max-w-7xl">
      <div className="mb-4 inline-flex rounded-md border border-gray-800 p-0.5 text-sm" role="tablist" aria-label="BEATs">
        {([['Collected', 'collected'], ['Hosting', 'hosting']] as const).map(([label, value]) => (
          <button key={value} type="button" role="tab" aria-selected={tab === value} onClick={() => pick(value)}
            className={`rounded px-3 py-1.5 ${tab === value ? 'bg-white/[0.06] text-white' : 'text-gray-400 hover:text-white'}`}>
            {label}
          </button>
        ))}
      </div>
      {tab === 'collected' ? (
        <>
          <PageHeader crumbs={['Workspace', 'BEATs']} title="Collected" subtitle="The BEATs your wallets hold." />
          <CollectedBeats />
        </>
      ) : (
        <BeatsGate>{(a) => <BeatList availability={a} />}</BeatsGate>
      )}
    </div>
  )
}

function BeatList({ availability }: { availability: BeatAvailability }) {
  const { token } = useAuth()
  const api = useApi()
  const [beats, setBeats] = useState<PublicBeat[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = () => {
    setError(null)
    api.listBeats().then(setBeats).catch((err) => setError(beatFieldError(err).message))
  }
  useEffect(() => {
    if (!token) return
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token])

  const newLink = availability.canCreate ? <Link href={newBeatHref()} className={NEW_BEAT_CLASS}><PlusIcon size={16} /> New BEAT</Link> : undefined
  return (
    <>
      <PageHeader crumbs={['Workspace', 'BEATs']} title="BEATs" count={beats ? countLabel(beats.length) : undefined}
        subtitle="Attendance tokens for the people who come to your events." actions={newLink} />
      {error ? (
        // A failed load is never shown as "No BEATs yet" (plain-ux I8)
        <div role="alert" className="mb-4 flex flex-wrap items-center gap-3 rounded-md border border-red-700 bg-red-900/50 px-4 py-2 text-sm text-red-300">
          <span>{error}</span>
          <button type="button" onClick={load} className="rounded-md bg-gray-800 px-3 py-1.5 text-sm text-gray-300 hover:bg-gray-700">Try again</button>
        </div>
      ) : !beats ? <Skeleton /> : beats.length === 0 ? (
        <EmptyState icon={<MedalIcon size={28} />} title="No BEATs yet"
          body={availability.canCreate ? "Visitors who stay long enough claim one, and it's sent to their wallet." : CREATE_CLOSED} action={newLink} />
      ) : (
        <ul className="space-y-2">
          {beats.map((b) => {
            const c = beatCounts(b)
            return (
              <li key={b.id}>
                <Link href={beatHref(b.id)} className="flex items-center gap-4 rounded-lg border border-gray-800 bg-gray-900 px-4 py-3 hover:border-gray-700">
                  {b.imageUrl ? <img src={b.imageUrl} alt="" className="h-12 w-12 rounded-md object-cover" /> : <div className="h-12 w-12 rounded-md border border-dashed border-gray-700" />}
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-medium text-white">{b.name}</div>
                    <div className="truncate text-xs text-gray-400">{beatWindow(b)}</div>
                  </div>
                  <span className="hidden font-mono text-xs text-gray-400 sm:inline">{c.used} / {c.cap}</span>
                  <BeatBadges status={b.status} test={b.test} />
                </Link>
              </li>
            )
          })}
        </ul>
      )}
    </>
  )
}
