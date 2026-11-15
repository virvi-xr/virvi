'use client'

import { useCallback, useEffect, useState } from 'react'
import type { BeatChain } from '@virvixr/shared'
import { useAuth } from '@/lib/auth'
import { useApi } from '@/lib/api'
import { PageHeader, Skeleton } from '@/components/ui'
import { AdminBeatsView } from '@/components/beats/AdminBeats'
import { BEATS_OFF, clearPause, giveUp, loadAdminBeats, retryFailed, type AdminBeatsOverview } from '@/lib/admin-beats'

/** Admin: the BEAT minters, claims and transactions (LIV-11). */
export default function AdminBeatsPage() {
  const { user } = useAuth()
  const api = useApi()
  const [data, setData] = useState<AdminBeatsOverview | 'off' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(() => { loadAdminBeats(api).then(setData, (e) => setError(e.message)) }, [api])
  useEffect(() => { if (user?.role === 'admin') load() }, [user?.role, load])

  if (user?.role !== 'admin') return <p className="text-gray-400">Admin access required.</p>

  const run = async (act: () => Promise<string | void>) => {
    setBusy(true); setError(null); setNote(null)
    try { const msg = await act(); if (msg) setNote(msg); load() } catch (e: any) { setError(e.message) }
    setBusy(false)
  }

  return (
    <div className="mx-auto max-w-7xl space-y-4">
      <PageHeader crumbs={['System', { label: 'Admin', href: '/admin' }, 'BEATs']} title="BEATs"
        subtitle={<p className="max-w-2xl">The minter wallet on each chain, claims waiting to be minted, and the latest transactions.</p>} />
      {error && <p role="alert" className="text-sm text-red-400">{error}</p>}
      {note && <p role="status" className="text-sm text-gray-300">{note}</p>}
      {data === null ? (!error && <Skeleton rows={3} />)
        : data === 'off' ? <p className="text-sm text-gray-400">{BEATS_OFF}</p>
        : <AdminBeatsView data={data} busy={busy}
            onRetry={(beatId) => run(() => retryFailed(api, beatId))}
            onClearPause={(chain: BeatChain) => run(() => clearPause(api, chain))}
            onGiveUp={(beatId) => run(() => giveUp(api, beatId))} />}
    </div>
  )
}
