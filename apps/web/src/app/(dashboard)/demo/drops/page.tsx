'use client'
import { DemoApiProvider } from '@/components/DemoApi'
import DropsPage from '../../drops/page'

/** The Drops page over a sample set-up; changes stay in this browser. */
export default function DemoDropsPage() {
  return (
    <DemoApiProvider>
      <DropsPage />
    </DemoApiProvider>
  )
}
