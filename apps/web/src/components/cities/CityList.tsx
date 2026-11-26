// Virvi's Cities, as cards, from CITIES (packages/shared/src/cities.ts): virvi.io/cities and the dashboard's Cities page.
import { CITIES, type City, type CityPlatform, type CityWorld } from '@virvixr/shared'

const PLATFORM: Record<CityPlatform, string> = { decentraland: 'Decentraland', hyperfy: 'Hyperfy', ar: 'AR' }

function initials(name: string): string {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join('')
}

function WorldAction({ world }: { world: CityWorld }) {
  const name = PLATFORM[world.platform]
  if (world.status === 'live' && world.url) {
    return (
      <a href={world.url} target="_blank" rel="noopener" className="inline-block rounded-lg border border-gray-700 px-4 py-2 text-sm font-medium text-white hover:border-accent hover:text-accent">
        Visit in {name}
      </a>
    )
  }
  return <span className="inline-block px-1 py-2 text-sm text-gray-500">Coming to {name}</span>
}

export function CityCard({ city }: { city: City }) {
  const live = city.worlds.some((w) => w.status === 'live')
  return (
    <li className="flex min-w-0 flex-col overflow-hidden rounded-lg border border-gray-800 bg-gray-900">
      {city.image ? (
        <img src={city.image} alt="" className="h-36 w-full object-cover" />
      ) : (
        <div aria-hidden="true" className="flex h-36 items-center justify-center bg-gradient-to-br from-blue-900 via-indigo-900 to-gray-900 text-4xl font-semibold tracking-wide text-white/80">
          {initials(city.name)}
        </div>
      )}
      <div className="flex flex-1 flex-col p-5">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <h2 className="text-lg font-semibold text-white">{city.name}</h2>
          {live && <span className="shrink-0 rounded-full border border-accent/60 px-2.5 py-0.5 text-xs font-medium text-accent">Live</span>}
        </div>
        <p className="mt-2 flex-1 text-gray-300">{city.description}</p>
        <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-1">
          {city.worlds.map((w) => <WorldAction key={w.platform} world={w} />)}
        </div>
        {city.eventsHref && <p className="mt-2 text-sm"><a href={city.eventsHref} className="text-blue-300 underline underline-offset-2 hover:text-white">Events in {city.name}</a></p>}
      </div>
    </li>
  )
}

export function CityList({ cities = CITIES }: { cities?: readonly City[] }) {
  return (
    <ul className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
      {cities.map((c) => <CityCard key={c.id} city={c} />)}
    </ul>
  )
}
