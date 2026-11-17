import type { Metadata } from 'next'
import { HowBeatsWork } from '@/components/beats/HowBeatsWork'

export const metadata: Metadata = {
  title: 'How BEATs work',
  description: 'How Virvi BEATs record event attendance on chain, protect attendees’ privacy, and recover tokens from a compromised wallet.',
}

/** virvi.io/beat/how-it-works: the technical overview (linked as the token's whitepaper in explorer listings). */
export default function HowBeatsWorkPage() {
  return <HowBeatsWork />
}
