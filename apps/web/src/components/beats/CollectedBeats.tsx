'use client'
// The Collected tab (LIV-185): the BEATs the account's linked wallets hold. Works for any signed-in user, hosting or not.
import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useApi } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { beatFieldError, datesBackwards, filterCollected, shortWallet, waitingNote, walletPageHref, type BeatCollection, type BeatKind, type CollectedFilter } from '@/lib/beats'
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
  const held = shown.filter((b) => b.status !== 'waiting')
  const waiting = shown.filter((b) => b.status === 'waiting')

  if (error) {
    return (
      <div role="alert" className="mb-4 flex flex-wrap items-center gap-3 rounded-md border border-red-700 bg-red-900/50 px-4 py-2 text-sm text-red-300">
        <span>{error}</span>
        <button type="button" onClick={load} className="rounded-md bg-gray-800 px-3 py-1.5 text-sm text-gray-300 hover:bg-gray-700">Try again</button>
      </div>
    )
  }
  if (!data) return <Skeleton />
  // BEATs saved for a wallet to be linked count as something collected, so an account with only those isn't shown as empty
  if (data.wallets.length === 0 && data.beats.length === 0) {
    return <EmptyState icon={<MedalIcon size={28} />} title="No wallet yet" body="Sign in with a wallet to collect BEATs." />
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
        {(filter.wallet !== 'all' || data.wallets.length === 1) && (
          <Link href={walletPageHref(filter.wallet !== 'all' ? filter.wallet : data.wallets[0])} className="pb-2 text-sm text-accent hover:underline">Share</Link>
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
      {datesBackwards(filter.from, filter.to) && (
        <p className="mb-3 text-sm text-amber-300" role="status">
          From is after To, so nothing can match.{' '}
          <button type="button" className="underline underline-offset-2 hover:text-white" onClick={() => set({ from: filter.to, to: filter.from })}>Swap the dates</button>
        </p>
      )}
      {shown.length === 0 ? (
        <p className="text-sm text-gray-400">No BEATs match these filters.</p>
      ) : (
        <>
          {waiting.length > 0 && (
            <section aria-labelledby="waiting-beats" className="mb-6">
              <h2 id="waiting-beats" className="mb-2 text-sm font-medium text-gray-300">Waiting for a wallet</h2>
              <ul className="grid grid-cols-[repeat(auto-fill,minmax(14rem,1fr))] items-start gap-3">
                {waiting.map((b, i) => (
                  <li key={`${b.name}-${b.startsAt}-${i}`} className="flex min-w-0 flex-col items-center gap-2 rounded-lg border border-dashed border-gray-700 bg-gray-900 p-4 text-center">
                    <span className="flex h-20 w-20 items-center justify-center overflow-hidden rounded-full border-4 border-gray-700 bg-gray-800 text-gray-600">
                      {b.imageUrl ? <img src={b.imageUrl} alt="" className="h-full w-full object-cover opacity-70" /> : <MedalIcon size={28} />}
                    </span>
                    <span className="w-full break-words font-medium text-white">{b.name}</span>
                    {b.place && <span className="w-full break-words text-xs text-gray-400">{b.place}</span>}
                    <span className="text-xs text-gray-300">{waitingNote(b)}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}
          {held.length > 0 && (
            <ul className="grid grid-cols-[repeat(auto-fill,minmax(11rem,1fr))] items-start gap-3">
              {held.map((b) => <BeatMedal key={`${b.wallet}-${b.contract}-${b.tokenId}`} beat={b} showWallet />)}
            </ul>
          )}
        </>
      )}
    </>
  )
}
