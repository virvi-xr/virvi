import type { Metadata } from 'next'
import { BeatLanding } from '@/components/beats/BeatLanding'

export const metadata: Metadata = {
  title: 'BEATs: proof you were there',
  description: 'BEATs are tokens you earn by showing up to events in virtual worlds. Paste your wallet to see yours.',
}

/** virvi.io/beat: the BEAT landing page, for anyone, signed in or not. */
export default function BeatPage() {
  return <BeatLanding />
}
