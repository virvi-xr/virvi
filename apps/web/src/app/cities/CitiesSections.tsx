import { CityList } from '@/components/cities/CityList'

/** virvi.io/cities's content: the Cities Virvi runs, and where to visit them. */
export function CitiesSections() {
  return (
    <section className="mx-auto max-w-6xl px-4 pb-16 pt-14 sm:px-6 sm:pt-20">
      <p className="text-sm font-medium uppercase tracking-[0.2em] text-accent">Virvi Cities</p>
      <h1 className="mt-3 max-w-3xl text-4xl font-semibold tracking-tight text-white sm:text-5xl">Cities you can visit</h1>
      <p className="mt-6 max-w-2xl text-lg leading-relaxed text-gray-300">Worlds run by Virvi, with apartments, stores and venues to look around.</p>
      <div className="mt-10"><CityList /></div>
    </section>
  )
}
