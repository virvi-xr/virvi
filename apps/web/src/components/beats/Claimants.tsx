'use client'
// A BEAT's attendees and claims (LIV-11): short wallet, display name as plain text, status, tx link, the reissued flag,
// "Copy wallets that claimed", and while claims are held for review, Remove.
import { useState } from 'react'
import type { PublicBeat } from '@virvixr/shared'
import { claimantRow, claimantsHeading, claimantWallets, hasClaimed, type BeatClaimant } from '@/lib/beats'
import { ConfirmAction, tableHeadBand } from '@/components/ui'

/** Copies the full wallet of every claim that took a BEAT, one per line (not visitors still attending). */
export function copyWallets(list: BeatClaimant[], clipboard: Pick<Clipboard, 'writeText'> | undefined = typeof navigator === 'undefined' ? undefined : navigator.clipboard) {
  return clipboard ? clipboard.writeText(claimantWallets(list)) : Promise.reject(new Error('no_clipboard'))
}

export const CLAIMANTS_LOAD_ERROR = "We couldn't load the attendee list. Try again."
export const REISSUED_TITLE = 'Sent again to this wallet in place of a lost or stolen one'

export function Claimants({ claimants, beat, error, busy, onRetry, onRemove }: {
  claimants: BeatClaimant[]
  beat?: Pick<PublicBeat, 'mintsHeldUntil' | 'mintsReleasedAt'>
  /** The list couldn't be loaded: say so, with Try again, never a false "no claims". */
  error?: boolean
  busy?: boolean
  onRetry?: () => void
  onRemove?: (c: BeatClaimant) => void
}) {
  const [copied, setCopied] = useState(false)
  const copy = () => {
    copyWallets(claimants).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500) }).catch(() => {})
  }
  const claimed = claimants.filter(hasClaimed).length
  const rows = claimants.map((c) => ({ c, r: claimantRow(c, beat) }))
  const anyHeld = !!onRemove && rows.some((x) => x.r.held)
  return (
    <section className="rounded-lg border border-gray-800 bg-gray-900">
      <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
        <h2 className="text-sm font-medium text-gray-300">{error ? 'Attendees' : claimantsHeading(claimants)}</h2>
        {!error && (
          <button type="button" onClick={copy} disabled={claimed === 0}
            className="rounded-md bg-gray-800 px-3 py-1.5 text-sm text-gray-300 hover:bg-gray-700 disabled:opacity-50">
            <span aria-live="polite">{copied ? 'Copied' : 'Copy wallets that claimed'}</span>
          </button>
        )}
      </div>
      {error ? (
        <div className="flex flex-wrap items-center gap-3 px-4 pb-4">
          <p role="alert" className="text-sm text-red-300">{CLAIMANTS_LOAD_ERROR}</p>
          {onRetry && <button type="button" onClick={onRetry} className="rounded-md bg-gray-800 px-3 py-1.5 text-sm text-gray-300 hover:bg-gray-700">Try again</button>}
        </div>
      ) : claimants.length === 0 ? <p className="px-4 pb-4 text-sm text-gray-400">No one has started tracking yet.</p> : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className={tableHeadBand}>
              <tr>
                <th className="px-4 py-2">Wallet</th><th className="px-4 py-2">Name</th><th className="px-4 py-2">Status</th><th className="px-4 py-2">Transaction</th>
                {anyHeld && <th className="px-4 py-2"><span className="sr-only">Actions</span></th>}
              </tr>
            </thead>
            <tbody>
              {rows.map(({ c, r }) => (
                <tr key={c.id ?? r.wallet} className="border-t border-gray-800">
                  <td className="px-4 py-2 font-mono text-xs text-gray-300" title={r.wallet}>
                    {r.short}
                    {r.reissued && <span title={REISSUED_TITLE} className="ml-2 rounded bg-amber-900/40 px-1.5 py-0.5 font-sans text-[11px] text-amber-200">Reissued</span>}
                  </td>
                  <td className={`px-4 py-2 ${r.name ? 'text-gray-100' : 'italic text-gray-400'}`}>{r.name ?? 'No name'}</td>
                  <td className="px-4 py-2 text-gray-300">{r.status}</td>
                  <td className="px-4 py-2">
                    {r.txUrl ? <a href={r.txUrl} target="_blank" rel="noopener noreferrer" className="text-blue-300 hover:underline">View</a>
                      : <span className="text-gray-400"><span aria-hidden="true">—</span><span className="sr-only">No transaction</span></span>}
                    {r.reissueTxUrl && <a href={r.reissueTxUrl} target="_blank" rel="noopener noreferrer" className="ml-3 text-blue-300 hover:underline">Reissue</a>}
                  </td>
                  {anyHeld && (
                    <td className="px-4 py-2 text-right">
                      {r.held && onRemove && (
                        <ConfirmAction prompt={`Remove this claim? ${r.name ?? r.short} won't get this BEAT, and that wallet can't claim it again. This frees one BEAT of the supply.`}
                          confirmLabel="Remove claim" onConfirm={() => onRemove(c)} disabled={busy}
                          className="rounded-md border border-gray-700 px-2 py-1 text-xs text-gray-300 hover:border-gray-500 disabled:opacity-50">
                          Remove
                        </ConfirmAction>
                      )}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}
