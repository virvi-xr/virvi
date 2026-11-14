'use client'
// A BEAT's claimants (LIV-11): short wallet, display name as plain text, status, tx link, and "Copy wallets".
import { useState } from 'react'
import { claimantRow, claimantWallets, type BeatClaimant } from '@/lib/beats'
import { tableHeadBand } from '@/components/ui'

/** Copies every full wallet, one per line. */
export function copyWallets(list: BeatClaimant[], clipboard: Pick<Clipboard, 'writeText'> | undefined = typeof navigator === 'undefined' ? undefined : navigator.clipboard) {
  return clipboard ? clipboard.writeText(claimantWallets(list)) : Promise.reject(new Error('no_clipboard'))
}

export function Claimants({ claimants }: { claimants: BeatClaimant[] }) {
  const [copied, setCopied] = useState(false)
  const copy = () => {
    copyWallets(claimants).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500) }).catch(() => {})
  }
  return (
    <section className="rounded-lg border border-gray-800 bg-gray-900">
      <div className="flex items-center justify-between px-4 py-3">
        <h2 className="text-sm font-medium text-gray-300">Claimants ({claimants.length})</h2>
        <button type="button" onClick={copy} disabled={claimants.length === 0}
          className="rounded-md bg-gray-800 px-3 py-1.5 text-sm text-gray-300 hover:bg-gray-700 disabled:opacity-50">
          {copied ? 'Copied' : 'Copy wallets'}
        </button>
      </div>
      {claimants.length === 0 ? <p className="px-4 pb-4 text-sm text-gray-500">No claims yet.</p> : (
        <table className="w-full text-sm">
          <thead className={tableHeadBand}><tr><th className="px-4 py-2">Wallet</th><th className="px-4 py-2">Name</th><th className="px-4 py-2">Status</th><th className="px-4 py-2">Transaction</th></tr></thead>
          <tbody>
            {claimants.map((c) => {
              const r = claimantRow(c)
              return (
                <tr key={r.wallet} className="border-t border-gray-800">
                  <td className="px-4 py-2 font-mono text-xs text-gray-300" title={r.wallet}>{r.short}</td>
                  <td className={`px-4 py-2 ${r.name ? 'text-gray-100' : 'italic text-gray-500'}`}>{r.name ?? 'No name'}</td>
                  <td className="px-4 py-2 text-gray-300">{r.status}</td>
                  <td className="px-4 py-2">
                    {r.txUrl ? <a href={r.txUrl} target="_blank" rel="noopener noreferrer" className="text-blue-300 hover:underline">View</a> : <span className="text-gray-600">—</span>}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}
    </section>
  )
}
