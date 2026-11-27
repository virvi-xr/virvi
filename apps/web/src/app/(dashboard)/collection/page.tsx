'use client'
// Collection (LIV-160): what the account's linked wallets hold in Decentraland.
import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useApi } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { filterCollection, itemSubtitle, KIND_FILTERS, kindCounts, shortWallet, type Collection, type KindFilter } from '@/lib/collection'
import { EmptyState, PageHeader, SelectField, Skeleton } from '@/components/ui'
import { HangerIcon } from '@/components/icons'

export default function CollectionPage() {
  const { token } = useAuth()
  const api = useApi()
  const [data, setData] = useState<Collection | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [kind, setKind] = useState<KindFilter>('all')
  const [wallet, setWallet] = useState<string>('all')
  const [query, setQuery] = useState('')

  useEffect(() => {
    if (!token) return
    api.getCollection().then(setData, (e: any) => setError(e?.message ?? 'Could not load your collection'))
    // useApi() returns new functions every render; load once per session
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token])

  const counts = useMemo(() => (data ? kindCounts(data.items) : null), [data])
  const shown = useMemo(() => (data ? filterCollection(data.items, { kind, wallet, query }) : []), [data, kind, wallet, query])

  return (
    <div className="mx-auto max-w-7xl">
      <PageHeader crumbs={['Tools', 'Collection']} title="Collection" count={data ? String(data.items.length) : undefined}
        subtitle="The wearables, emotes, names and land your linked wallets hold in Decentraland." />
      {error && <p role="alert" className="text-red-400">{error}</p>}
      {!data && !error && <Skeleton />}
      {data && data.wallets.length === 0 && (
        <EmptyState icon={<HangerIcon size={40} />} title="No wallet linked yet"
          body="Link a wallet in Settings to see what it holds in Decentraland." action={<Link href="/settings" className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700">Open Settings</Link>} />
      )}
      {data && data.wallets.length > 0 && (
        <>
          {data.unavailable.length > 0 && (
            <p role="status" className="mb-4 rounded-md border border-amber-700/60 bg-amber-900/20 px-4 py-2 text-sm text-amber-200">
              The Decentraland Marketplace didn&apos;t answer for {data.unavailable.map(shortWallet).join(', ')}, so its items aren&apos;t shown. Try again in a minute.
            </p>
          )}
          {data.truncated.length > 0 && (
            <p role="status" className="mb-4 text-sm text-gray-400">Showing the newest 2,000 items for {data.truncated.map(shortWallet).join(', ')}.</p>
          )}
          <div className="mb-6 flex flex-wrap items-center gap-3">
            <div role="group" aria-label="Kind" className="flex flex-wrap gap-1">
              {KIND_FILTERS.map(([k, label]) => (
                <button key={k} type="button" aria-pressed={kind === k} onClick={() => setKind(k)}
                  className={`rounded-full px-3 py-1 text-sm ${kind === k ? 'bg-gray-100 text-gray-900' : 'bg-gray-800 text-gray-300 hover:bg-gray-700'}`}>
                  {label} <span className="tabular-nums opacity-70">{counts?.[k] ?? 0}</span>
                </button>
              ))}
            </div>
            {data.wallets.length > 1 && (
              <SelectField label="Wallet" value={wallet} onChange={setWallet}>
                <option value="all">All wallets</option>
                {data.wallets.map((w) => <option key={w} value={w}>{shortWallet(w)}</option>)}
              </SelectField>
            )}
            <input aria-label="Search by name" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search by name"
              className="min-w-[12rem] flex-1 rounded-md border border-gray-800 bg-gray-950 px-3 py-1.5 text-sm text-white outline-none focus:border-blue-400 sm:flex-none" />
          </div>
          {shown.length === 0 ? (
            <p className="text-sm text-gray-400">{data.items.length === 0 ? 'Your wallets don’t hold anything on Decentraland yet.' : 'Nothing matches these filters.'}</p>
          ) : (
            <ul className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
              {shown.map((i) => (
                <li key={i.id}>
                  <a href={i.url} target="_blank" rel="noopener noreferrer" className="block rounded-lg border border-gray-800 bg-gray-900 p-3 hover:border-gray-600">
                    <div className="mb-3 flex aspect-square items-center justify-center overflow-hidden rounded-md bg-gray-950">
                      {i.image
                        // eslint-disable-next-line @next/next/no-img-element
                        ? <img src={i.image} alt="" loading="lazy" className="h-full w-full object-contain" />
                        : <span aria-hidden className="px-2 text-center text-sm font-medium text-gray-400 break-all">{i.name}</span>}
                    </div>
                    <p className="truncate text-sm font-medium text-white" title={i.name}>{i.name}</p>
                    <p className="truncate text-xs text-gray-400">{itemSubtitle(i)}</p>
                    {data.wallets.length > 1 && <p className="mt-1 font-mono text-xs text-gray-500">{shortWallet(i.wallet)}</p>}
                    <span className="sr-only">(opens on the Decentraland Marketplace)</span>
                  </a>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  )
}
