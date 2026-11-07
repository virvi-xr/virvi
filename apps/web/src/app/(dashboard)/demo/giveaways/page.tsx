'use client'
import { DemoApiProvider } from '@/components/DemoApi'
import GiveawaysPage from '../../giveaways/page'

/** The Giveaways page over a sample set-up; changes stay in this browser. */
export default function DemoGiveawaysPage() {
  return (
    <DemoApiProvider>
      <GiveawaysPage />
    </DemoApiProvider>
  )
}
