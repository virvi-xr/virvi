import type { Metadata } from 'next'
import { CitiesLanding } from './CitiesLanding'

export const metadata: Metadata = {
  title: 'Cities: worlds to visit',
  description: 'Visit Virvi City: apartments, stores and venues in a Virvi-run World.',
}

/** virvi.io/cities: the Cities Virvi runs, for anyone, signed in or not. */
export default function CitiesPage() {
  return <CitiesLanding />
}
