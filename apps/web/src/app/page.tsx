'use client'
import { useAuth } from '@/lib/auth'
import { landingRoute } from '@/lib/landing-route'
import { ADVERTISE_PAGE } from '@/lib/site'
import { useRouter, useSearchParams } from 'next/navigation'
import { Suspense, useCallback, useEffect, useState } from 'react'
import { Closing } from './_landing/Closing'
import { Doors } from './_landing/Doors'
import { EarlyAccessForm } from './_landing/EarlyAccessForm'
import { EarnBand } from './_landing/EarnBand'
import { Features } from './_landing/Features'
import { Footer } from './_landing/Footer'
import { Measurement } from './_landing/Measurement'
import { Nav } from './_landing/Nav'

function Landing() {
  const { user, loading, scenePass } = useAuth()
  const router = useRouter()
  const search = useSearchParams().toString()
  const route = landingRoute({ search: search ? `?${search}` : '', loading, signedIn: !!user, scenePass: !!scenePass, trial: !!user?.trial })
  const go = typeof route === 'object' ? route.go : null
  const [formOpen, setFormOpen] = useState(false)

  useEffect(() => {
    if (go) router.replace(go)
  }, [go, router])

  const onAdvertise = useCallback(() => {
    if (ADVERTISE_PAGE) router.push(ADVERTISE_PAGE)
    else setFormOpen(true)
  }, [router])
  const closeForm = useCallback(() => setFormOpen(false), [])

  if (route !== 'show') return null
  return (
    <div className="min-h-screen bg-gray-950">
      <Nav onAdvertise={onAdvertise} />
      <main>
        <Doors onAdvertise={onAdvertise} />
        <Features />
        <EarnBand />
        <Measurement onAdvertise={onAdvertise} />
        <Closing />
      </main>
      <Footer onAdvertise={onAdvertise} />
      <EarlyAccessForm open={formOpen} onClose={closeForm} />
    </div>
  )
}

export default function LandingPage() {
  return (
    <Suspense fallback={null}>
      <Landing />
    </Suspense>
  )
}
