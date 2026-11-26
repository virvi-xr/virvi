'use client'
import { Suspense, useCallback, useEffect, useRef, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { useApi } from '@/lib/api'
import type { AnalyticsLocation } from '@/lib/analytics/types'
import { dashboardHref, resolveView } from '@/lib/analytics/view'
import { LocationList } from './LocationList'
import { Dashboard, NoAccess } from './Dashboard'
import { PageHeader, Skeleton } from '@/components/ui'

export default function AnalyticsPage() {
  return (
    <Suspense fallback={<Skeleton />}>
      <AnalyticsContent />
    </Suspense>
  )
}

function AnalyticsContent() {
  // `useApi()` returns a new object each render; read it through a ref so the load runs once.
  const apiNow = useApi()
  const api = useRef(apiNow)
  api.current = apiNow
  const router = useRouter()
  const params = useSearchParams()
  const location = params.get('location')
  const scene = params.get('scene')

  const [locations, setLocations] = useState<AnalyticsLocation[] | null>(null)
  const [failed, setFailed] = useState(false)

  const load = useCallback(() => {
    setFailed(false)
    api.current.getAnalyticsLocations()
      .then((r) => setLocations(r.scenes))
      .catch(() => setFailed(true))
  }, [])
  useEffect(load, [load])

  const view = locations ? resolveView(locations, { location, scene }) : null
  const redirectTo = view?.view === 'redirect' ? view.locationId : null
  useEffect(() => {
    if (redirectTo) router.replace(dashboardHref(redirectTo))
  }, [redirectTo, router])

  if (failed) {
    return (
      <div className="mx-auto max-w-7xl">
        <PageHeader crumbs={['Tools', 'Analytics']} title="Analytics" />
        <p className="rounded-lg border border-gray-800 bg-gray-900 p-4 text-sm text-gray-400" role="alert">
          Couldn&apos;t load your scenes —{' '}
          <button type="button" onClick={load} className="text-blue-400 hover:text-blue-300 underline underline-offset-2">Retry</button>
        </p>
      </div>
    )
  }
  if (!locations || !view || view.view === 'redirect') return <Skeleton />
  if (view.view === 'no-access') return <NoAccess />
  if (view.view === 'dashboard') {
    const id = view.location.id
    return (
      <Dashboard
        key={id}
        location={view.location}
        showAllLink={locations.length > 1}
        onWalletVisibility={(on) => setLocations((ls) => ls && ls.map((l) => (l.id === id ? { ...l, walletVisibility: on } : l)))}
      />
    )
  }
  return <LocationList locations={locations} note={view.note} />
}
