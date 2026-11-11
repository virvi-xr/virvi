'use client'
import { useEffect, useState } from 'react'
import { useApi } from '@/lib/api'
import type { AnalyticsLocation } from '@/lib/analytics/types'
import { DemoApiProvider } from '@/components/DemoApi'
import { Skeleton } from '@/components/ui'
import { Dashboard } from '../../analytics/Dashboard'

/** The Analytics dashboard over the sample World's week, for guests (and anyone curious). Nothing here calls the server. */
export default function DemoAnalyticsPage() {
  return (
    <DemoApiProvider>
      <SampleDashboard />
    </DemoApiProvider>
  )
}

function SampleDashboard() {
  const api = useApi()
  const [location, setLocation] = useState<AnalyticsLocation | null>(null)
  useEffect(() => {
    api.getAnalyticsLocations().then((r) => setLocation(r.scenes[0] ?? null)).catch(() => {})
  }, [api])
  if (!location) return <Skeleton />
  return <Dashboard location={location} showAllLink={false} />
}
