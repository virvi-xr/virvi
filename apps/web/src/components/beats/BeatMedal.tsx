'use client'
// A collected BEAT as a round medal (LIV-185). Round is only for BEATs you hold, so they never look like hosted ones.
// The signed-in Collected tab and the public wallet page both use it.
import { useState } from 'react'
import type { CollectedBeat } from '@/lib/beats'
import { medalDate, shortWallet } from '@/lib/beats'
import { Badge } from '@/components/ui'
import { MedalIcon } from '@/components/icons'

export function BeatMedal({ beat, showWallet }: { beat: CollectedBeat; showWallet: boolean }) {
  const [open, setOpen] = useState(false)
  const sub = [beat.place, medalDate(beat.startsAt)].filter(Boolean).join(' · ')
  return (
    <li className="min-w-0">
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open}
        className="flex w-full flex-col items-center gap-2 rounded-lg border border-gray-800 bg-gray-900 p-4 text-center hover:border-gray-700">
        <span className="flex h-28 w-28 items-center justify-center overflow-hidden rounded-full border-4 border-accent bg-gray-800 text-gray-600">
          {beat.imageUrl ? <img src={beat.imageUrl} alt="" className="h-full w-full object-cover" /> : <MedalIcon size={36} />}
        </span>
        <span className="w-full break-words font-medium text-white">{beat.name}</span>
        <span className="w-full break-words text-xs text-gray-400">{sub}</span>
        <span className="flex flex-wrap items-center justify-center gap-1.5">
          {beat.earned
            ? <span className="inline-flex items-center rounded-full bg-accent px-2.5 py-0.5 text-xs font-medium text-accent-ink">Earned</span>
            : <Badge>Held</Badge>}
          {beat.quantity > 1 && <Badge>×{beat.quantity}</Badge>}
          {beat.tradeable && <Badge>Tradeable</Badge>}
        </span>
        {showWallet && <span className="font-mono text-xs text-gray-500" title={beat.wallet}>{shortWallet(beat.wallet)}</span>}
      </button>
      {open && (
        <dl className="mt-1 space-y-1 rounded-lg border border-gray-800 bg-gray-950 p-3 text-xs text-gray-300">
          <Row label="Starts">{new Date(beat.startsAt).toUTCString()}</Row>
          <Row label="Ends">{new Date(beat.endsAt).toUTCString()}</Row>
          {beat.place && <Row label="Place">{beat.place}</Row>}
          <Row label="Held by"><span className="font-mono" title={beat.wallet}>{shortWallet(beat.wallet)}</span></Row>
          <Row label="Network">{beat.chain === 'polygon' ? 'Polygon' : 'Polygon Amoy (test)'}</Row>
          {beat.claimedAt && <Row label="Claimed">{new Date(beat.claimedAt).toUTCString()}</Row>}
          <div className="flex flex-wrap gap-x-4 gap-y-1 pt-1">
            <a href={beat.tokenUrl} target="_blank" rel="noopener noreferrer" className="text-accent hover:underline">View token on Polygonscan</a>
            {beat.mintTxUrl && <a href={beat.mintTxUrl} target="_blank" rel="noopener noreferrer" className="text-accent hover:underline">View mint transaction</a>}
          </div>
        </dl>
      )}
    </li>
  )
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return <div className="flex flex-wrap gap-x-2"><dt className="text-gray-500">{label}</dt><dd className="min-w-0 break-words">{children}</dd></div>
}
