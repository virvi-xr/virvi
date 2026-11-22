import type { Metadata } from 'next'
import { ArLanding } from './ArLanding'

export const metadata: Metadata = {
  title: 'AR Spaces: your scene, in a real place',
  description: 'AR Spaces put your Virvi scene in a real room, life-size. Get the apps for Meta Quest, Apple Vision Pro and iPhone.',
}

/** virvi.io/ar: what AR Spaces are and where to get the apps, for anyone, signed in or not. */
export default function ArPage() {
  return <ArLanding />
}
