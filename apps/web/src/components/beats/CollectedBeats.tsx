'use client'
// The Collected tab (LIV-185): the BEATs the account's linked wallets hold. Works for any signed-in user, hosting or not.
import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useApi } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { beatFieldError, filterCollected, shortWallet, walletPageHref, type BeatCollection, type BeatKind, type CollectedFilter } from '@/lib/beats'
import { EmptyState, Skeleton } from '@/components/ui'
import { MedalIcon } from '@/components/icons'
import { BeatMedal } from './BeatMedal'

const FIELD = 'rounded-md border border-gray-700 bg-gray-900 px-2 py-1.5 text-sm text-gray-200'

export function CollectedBeats() {
  const { token } = useAuth()
  const api = useApi()
  const [data, setData] = useState<BeatCollection | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState<CollectedFilter>({ wallet: 'all', from: null, to: null, kind: 'all', earnedOnly: false })

  const load = () => {
    setError(null)
    api.getBeatCollection().then(setData).catch((err) => setError(beatFieldError(err).message))
  }
  useEffect(() => {
    if (!token) return
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token])

  const shown = useMemo(() => (data ? filterCollected(data.beats, filter) : []), [data, filter])

  if (error) {
    return (
      <div role="alert" className="mb-4 flex flex-wrap items-center gap-3 rounded-md border border-red-700 bg-red-900/50 px-4 py-2 text-sm text-red-300">
        <span>{error}</span>
        <button type="button" onClick={load} className="rounded-md bg-gray-800 px-3 py-1.5 text-sm text-gray-300 hover:bg-gray-700">Try again</button>
      </div>
    )
  }
  if (!data) return <Skeleton />
  if (data.wallets.length === 0) {
    return <EmptyState icon={<MedalIcon size={28} />} title="No wallet yet" body="Sign in with a wallet to collect BEATs" />
  }
  if (data.beats.length === 0) {
    return <EmptyState icon={<MedalIcon size={28} />} title="Nothing collected" body="No BEATs yet. Go to an event with a BEAT and claim it." />
  }
  const set = (p: Partial<CollectedFilter>) => setFilter((f) => ({ ...f, ...p }))
  return (
    <>
      <div className="mb-4 flex flex-wrap items-end gap-x-4 gap-y-3">
        <label className="flex flex-col gap-1 text-xs text-gray-400">Wallet
          <select className={FIELD} value={filter.wallet} onChange={(e) => set({ wallet: e.target.value })}>
            <option value="all">All wallets</option>
            {data.wallets.map((w) => <option key={w} value={w}>{shortWallet(w)}</option>)}
          </select>
        </label>
        {filter.wallet !== 'all' && (
          <Link href={walletPageHref(filter.wallet)} className="pb-2 text-sm text-accent hover:underline">Share</Link>
        )}
        <label className="flex flex-col gap-1 text-xs text-gray-400">From
          <input type="date" className={FIELD} value={filter.from ?? ''} onChange={(e) => set({ from: e.target.value || null })} />
        </label>
        <label className="flex flex-col gap-1 text-xs text-gray-400">To
          <input type="date" className={FIELD} value={filter.to ?? ''} onChange={(e) => set({ to: e.target.value || null })} />
        </label>
        <label className="flex flex-col gap-1 text-xs text-gray-400">Kind
          <select className={FIELD} value={filter.kind} onChange={(e) => set({ kind: e.target.value as BeatKind | 'all' })}>
            <option value="all">All</option><option value="basic">Basic</option><option value="custom">Custom</option>
          </select>
        </label>
        <label className="flex items-center gap-2 pb-2 text-sm text-gray-300">
          <input type="checkbox" checked={filter.earnedOnly} onChange={(e) => set({ earnedOnly: e.target.checked })} /> Earned only
        </label>
      </div>
      {shown.length === 0 ? (
        <p className="text-sm text-gray-400">No BEATs match these filters.</p>
      ) : (
        <ul className="grid grid-cols-[repeat(auto-fill,minmax(11rem,1fr))] items-start gap-3">
          {shown.map((b) => <BeatMedal key={`${b.wallet}-${b.contract}-${b.tokenId}`} beat={b} showWallet={data.wallets.length > 1} />)}
        </ul>
      )}
    </>
  )
}
