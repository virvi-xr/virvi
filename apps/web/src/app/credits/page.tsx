'use client'

import { useEffect, useState } from 'react'
import type { CatalogPack } from '@virvixr/shared'
import { useApi } from '@/lib/api'
import { licenseLabel } from '@/lib/catalog'

/** Public credits for the open-source model catalog: every pack with models, its artists, license and source. */
export default function CreditsPage() {
  const api = useApi()
  const [packs, setPacks] = useState<CatalogPack[] | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    api.getCatalogPacks().then((d) => setPacks(d.packs), () => setFailed(true))
  }, [])

  return (
    <main className="mx-auto max-w-3xl px-4 py-10 space-y-6">
      <h1 className="text-3xl font-bold">Credits</h1>
      <p className="text-gray-400">
        The 3D models in Virvi&apos;s catalog come from these open-source collections. Thank you to every artist who shared their work.
      </p>
      {failed && <p className="text-red-400">Couldn&apos;t load the credits. Try again in a moment.</p>}
      {!packs && !failed && <p className="text-gray-500">Loading…</p>}
      {packs?.map((p) => (
        <section key={p.id} className="rounded-xl border border-gray-800 bg-gray-900 p-4 space-y-2">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="text-lg font-semibold">{p.name}</h2>
            <span className="text-xs text-gray-500">{p.modelCount} models · {licenseLabel(p.license)}</span>
          </div>
          <a href={p.sourceUrl} target="_blank" rel="noreferrer" className="text-sm text-blue-400 underline underline-offset-2 hover:text-blue-300 break-all">{p.sourceUrl}</a>
          {p.attribution.length > 120 ? (
            <pre className="whitespace-pre-wrap rounded-lg bg-gray-950 p-3 text-xs text-gray-400">{p.attribution}</pre>
          ) : (
            <p className="text-sm text-gray-400">{p.attribution}</p>
          )}
        </section>
      ))}
    </main>
  )
}
