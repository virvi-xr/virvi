import type { Metadata } from 'next'
import { BeatsExplainer } from '@/components/beats/BeatsExplainer'

export const metadata: Metadata = {
  title: 'BEATs',
  description: 'Proof you were there: BEATs are attendance tokens for events in virtual worlds. Check any wallet’s BEATs.',
}

/** /w: the BEAT page with its wallet lookup, for anyone, signed in or not. */
export default function BeatLookupPage() {
  return <BeatsExplainer />
}
