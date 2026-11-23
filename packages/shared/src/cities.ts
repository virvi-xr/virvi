/**
 * Virvi-run Cities, in one place: virvi.io/cities and the dashboard's Cities page read these.
 * Add a city here and both pages list it. `image: null` shows a generated tile with the city's initials.
 */
export type CityPlatform = 'decentraland' | 'hyperfy' | 'ar'

export interface CityWorld {
  platform: CityPlatform
  /** The address to open, or null while the world is coming. */
  url: string | null
  status: 'live' | 'coming'
}

export interface City {
  id: string
  name: string
  description: string
  image: string | null
  worlds: CityWorld[]
  /** Where to find the city's events, once there is a page for them. */
  eventsHref?: string
}

export const CITIES: City[] = [
  {
    id: 'virvicity',
    name: 'Virvi City',
    description: 'Apartments, stores and venues in a Virvi-run World.',
    image: null,
    worlds: [
      { platform: 'decentraland', url: 'https://decentraland.org/jump/?realm=virvicity.dcl.eth', status: 'live' },
      { platform: 'hyperfy', url: null, status: 'coming' },
    ],
  },
]
