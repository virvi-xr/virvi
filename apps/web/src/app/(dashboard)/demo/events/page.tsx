'use client'
import { DemoApiProvider } from '@/components/DemoApi'
import EventsPage from '../../events/page'

/** The Events page over a sample schedule; changes stay in this browser. */
export default function DemoEventsPage() {
  return (
    <DemoApiProvider>
      <EventsPage />
    </DemoApiProvider>
  )
}
