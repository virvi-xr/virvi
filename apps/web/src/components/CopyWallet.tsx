'use client'
import { useState } from 'react'

/** A shortened wallet address (full on hover) with a Copy button. */
export function CopyWallet({ wallet }: { wallet: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <span className="inline-flex items-center gap-2">
      <span className="font-mono text-xs text-gray-400" title={wallet}>{`${wallet.slice(0, 6)}…${wallet.slice(-4)}`}</span>
      <button type="button" aria-label={`Copy wallet ${wallet}`} className="text-xs text-orange-400 hover:underline"
        onClick={() => { navigator.clipboard?.writeText(wallet).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500) }).catch(() => {}) }}>
        {copied ? 'Copied' : 'Copy'}
      </button>
    </span>
  )
}
