import type { Metadata } from 'next'
import { SummitLanding } from './SummitLanding'

export const metadata: Metadata = {
  title: 'Virvi Launch Summit',
  description:
    'Wednesday 3 – Thursday 4 February 2027, at Livication Studios in Melbourne, Florida, and live in every Virvi world. Sign up to join online, in person or with a watch party.',
}

/** virvi.io/summit: the Virvi Launch Summit page and sign-up. */
export default function SummitPage() {
  return <SummitLanding />
}
