'use client'
import { useCallback, useState } from 'react'
import { useRouter } from 'next/navigation'
import { ADVERTISE_PAGE } from '@/lib/site'
import { EarlyAccessForm } from '../_landing/EarlyAccessForm'
import { Footer } from '../_landing/Footer'
import { Nav } from '../_landing/Nav'
import { TryNowModal } from '../_landing/TryNowModal'
import { SummitForm } from './SummitForm'
import { SummitSections } from './SummitSections'

/** virvi.io/summit: the Virvi Launch Summit, in the landing page's header and footer. */
export function SummitLanding() {
  const router = useRouter()
  const [formOpen, setFormOpen] = useState(false)
  const [tryOpen, setTryOpen] = useState(false)
  const onAdvertise = useCallback(() => {
    if (ADVERTISE_PAGE) router.push(ADVERTISE_PAGE)
    else setFormOpen(true)
  }, [router])
  const closeForm = useCallback(() => setFormOpen(false), [])
  const openTry = useCallback(() => setTryOpen(true), [])
  const closeTry = useCallback(() => setTryOpen(false), [])

  return (
    <div className="min-h-screen overflow-x-hidden bg-gray-950">
      <Nav onAdvertise={onAdvertise} onTry={openTry} />
      <main>
        <SummitSections />
        <SummitForm />
      </main>
      <Footer onAdvertise={onAdvertise} />
      <EarlyAccessForm open={formOpen} onClose={closeForm} />
      <TryNowModal open={tryOpen} onClose={closeTry} />
    </div>
  )
}
