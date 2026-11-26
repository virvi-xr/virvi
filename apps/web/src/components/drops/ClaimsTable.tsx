'use client'
import { useEffect, useState } from 'react'
import { GIVEAWAY_CLAIM_STATUSES } from '@virvixr/shared'
import { useApi } from '@/lib/api'
import { CLAIM_STATUS_LABELS, dropsError, type GiveawayClaimRow, type HostGiveaway } from '@/lib/drops'
import { Badge, Skeleton, tableHead, type Tone, TableScroll } from '@/components/ui'

const TONES: Record<GiveawayClaimRow['status'], Tone> = { present: 'neutral', waiting: 'info', minting: 'warning', sent: 'success', failed: 'danger' }

/** The giveaway's claims, newest first, with totals by status. */
export function ClaimsTable({ giveaway: g }: { giveaway: HostGiveaway }) {
  const api = useApi()
  const [claims, setClaims] = useState<GiveawayClaimRow[] | null>(null)
  const [cursor, setCursor] = useState<string | null>(null)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    api.getGiveawayClaims(g.id)
      .then((d) => { setClaims(d.claims); setCursor(d.nextCursor) })
      .catch((err) => { setClaims([]); setError(dropsError(err)) })
  }, [api, g.id])

  const more = async () => {
    if (!cursor) return
    setLoadingMore(true)
    try {
      const d = await api.getGiveawayClaims(g.id, cursor)
      setClaims((c) => [...(c ?? []), ...d.claims])
      setCursor(d.nextCursor)
    } catch (err) {
      setError(dropsError(err))
    }
    setLoadingMore(false)
  }

  const total = GIVEAWAY_CLAIM_STATUSES.reduce((n, s) => n + (g.counts[s] ?? 0), 0)

  return (
    <section className="rounded-lg border border-gray-800 bg-gray-900 p-4">
      <h2 className="mb-1 text-lg font-semibold">Claims</h2>
      <p className="mb-3 text-sm text-gray-400">
        {total.toLocaleString('en-US')} in all
        {GIVEAWAY_CLAIM_STATUSES.filter((s) => g.counts[s]).map((s) => ` · ${CLAIM_STATUS_LABELS[s]} ${g.counts[s].toLocaleString('en-US')}`).join('')}
      </p>
      {error && <p role="alert" className="mb-2 text-sm text-red-400">{error}</p>}
      {!claims ? <Skeleton rows={2} className="h-12" /> : claims.length === 0 ? (
        <p className="text-sm text-gray-500">No claims yet.</p>
      ) : (
        <TableScroll label="Claims">
          <table className="w-full text-sm">
            <thead className={tableHead}>
              <tr className="border-b border-gray-800">
                <th className="pb-2 pr-4">Wallet</th>
                <th className="pb-2 pr-4">Status</th>
                <th className="pb-2 pr-4">Time</th>
                <th className="pb-2"><span className="sr-only">Transaction</span></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-800/50">
              {claims.map((c) => {
                const at = c.sentAt ?? c.claimedAt
                return (
                  <tr key={c.id}>
                    <td className="py-2 pr-4 font-mono text-xs text-gray-300">{c.wallet ?? '—'}</td>
                    <td className="py-2 pr-4"><Badge tone={TONES[c.status] ?? 'neutral'}>{CLAIM_STATUS_LABELS[c.status] ?? c.status}</Badge></td>
                    <td className="py-2 pr-4 text-gray-400">{at ? new Date(at).toLocaleString() : '—'}</td>
                    <td className="py-2">
                      {c.txUrl && <a href={c.txUrl} target="_blank" rel="noopener noreferrer" className="text-blue-400 underline underline-offset-2 hover:text-blue-300">View</a>}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </TableScroll>
      )}
      {cursor && (
        <button type="button" onClick={more} disabled={loadingMore} className="mt-3 rounded-md bg-gray-800 px-3 py-1.5 text-sm hover:bg-gray-700 disabled:opacity-50">
          {loadingMore ? 'Loading…' : 'Show more'}
        </button>
      )}
    </section>
  )
}
