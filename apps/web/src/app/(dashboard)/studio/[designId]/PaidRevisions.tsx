'use client'
import { useState } from 'react'
import { useApi } from '@/lib/api'
import { Badge, PrimaryButton } from '@/components/ui'
import {
  formatCents, formatCredit, manaBack, paidByReader, paidSummary, REPORT_MAX, refusalMessage, reportCopy, reportOk, revisionActions,
  type FinalizedRevision, type StudioPiece, type WallState,
} from '@/lib/studio'
import { WALL_BAD_LINK, wallToggleState } from '@/lib/wall'

/** `wall`: the wall-of-fame choice, given only to the owner (the PUT is the owner's alone); without it, no wall toggle. */
type Props = { designId: string; pieces: StudioPiece[]; wall?: WallState; onChanged: () => Promise<void>; kind?: string; support?: boolean; act?: boolean }

/** Save a downloaded blob under its file name. */
export function saveBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

/**
 * Every paid piece's revisions, whichever tab is selected: download, a free retry when packaging failed, and mistake
 * reports. With two or more pieces ready, "Download all" fetches them as one zip; while pieces package, it says how many
 * are ready. A revision's payer (`paidByMe`, LIV-159) sees its mistake report and outcome, MANA back and their 3D Models
 * link; `support`: Virvi support is looking, and sees none of them. `act`: not a viewer, so a failed package can be tried again.
 */
export default function PaidRevisions({ designId, pieces, wall, onChanged, kind, support = false, act = true }: Props) {
  const api = useApi()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const paid = pieces.filter((p) => p.finalized.length > 0)
  if (paid.length === 0) return null
  const summary = paidSummary(pieces)
  const several = paid.length > 1

  const downloadAll = async () => {
    setBusy(true)
    setError(null)
    try {
      const { blob, filename } = await api.downloadStudioPackages(designId)
      saveBlob(blob, filename)
    } catch (err) {
      setError(refusalMessage(err as never, new Date()).text)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="rounded-lg border border-gray-800 bg-gray-900">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-gray-800 px-4 py-3">
        <div>
          <h3 className="text-sm font-medium">{several ? `Paid pieces · ${summary.ready} of ${summary.paid} ready` : `Paid revisions · ${paid[0].name}`}</h3>
          {summary.progress && several && <p className="text-xs text-gray-400" role="status">{summary.progress}</p>}
        </div>
        {summary.downloadAll && <PrimaryButton type="button" disabled={busy} onClick={downloadAll}>Download all</PrimaryButton>}
      </div>
      {error && <p className="px-4 pt-3 text-sm text-amber-300" role="alert">{error}</p>}
      {wall && <WallChoice designId={designId} pieces={pieces} wall={wall} onChanged={onChanged} />}
      {paid.map((piece) => (
        <section key={piece.category} aria-label={piece.name}>
          {several && <h4 className="px-4 pt-3 text-xs font-medium uppercase tracking-wide text-gray-400">{piece.name}</h4>}
          <ul className="divide-y divide-gray-800">
            {piece.finalized.map((f) => <PaidRevision key={f.revision} designId={designId} category={piece.category} f={f} onChanged={onChanged} scene={kind === 'scene'} mine={paidByReader(f, support)} act={act} />)}
          </ul>
        </section>
      ))}
    </div>
  )
}

/** Opt in to the Made with Virvi Design Studio wall, with an optional Marketplace link saved when the field loses focus. */
function WallChoice({ designId, pieces, wall, onChanged }: { designId: string; pieces: StudioPiece[]; wall: WallState; onChanged: () => Promise<void> }) {
  const api = useApi()
  const toggle = wallToggleState({ pieces })
  const saved = wall.marketplaceUrl ?? ''
  const [link, setLink] = useState(saved)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const save = async (body: { shown: boolean; marketplaceUrl?: string | null }) => {
    setBusy(true)
    setError(null)
    try {
      await api.setStudioWall(designId, body)
      await onChanged()
    } catch (err) {
      const e = err as { body?: { code?: string } }
      setError(e.body?.code === 'bad_marketplace_url' ? WALL_BAD_LINK : refusalMessage(err as never, new Date()).text)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-2 border-b border-gray-800 px-4 py-3 text-sm">
      <label className="flex items-center gap-2">
        <input type="checkbox" checked={wall.shown} disabled={busy || (!wall.shown && !toggle.canShow)}
          onChange={(e) => save({ shown: e.target.checked })} />
        <span>Show on the Made with Virvi Design Studio wall</span>
      </label>
      {toggle.reason && !wall.shown && <p className="text-xs text-gray-500">{toggle.reason}</p>}
      {wall.shown && wall.hidden && <p className="text-xs text-gray-500">Virvi has taken this design off the wall.</p>}
      {wall.shown && (
        <label className="block">
          <span className="mb-1 block text-xs text-gray-400">Marketplace link (optional)</span>
          <input type="url" value={link} maxLength={300} onChange={(e) => setLink(e.target.value)} disabled={busy}
            onBlur={() => { const next = link.trim(); if (next !== saved) save({ shown: true, marketplaceUrl: next === '' ? null : next }) }}
            className="w-full rounded-md border border-gray-800 bg-gray-950 px-3 py-1.5 text-white outline-none focus:border-blue-400" />
        </label>
      )}
      {error && <p className="text-amber-300" role="alert">{error}</p>}
    </div>
  )
}

function PaidRevision({ designId, category, f, onChanged, scene, mine, act }: { designId: string; category: string; f: FinalizedRevision; onChanged: () => Promise<void>; scene?: boolean; mine: boolean; act: boolean }) {
  const api = useApi()
  const actions = revisionActions(f, new Date())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [reporting, setReporting] = useState(false)
  const [text, setText] = useState('')
  const [refunded, setRefunded] = useState<{ refundCents: number; creditedCents: number } | null>(null)
  const mana = manaBack(f.report)

  const run = async (fn: () => Promise<void>) => {
    setBusy(true)
    setError(null)
    try {
      await fn()
    } catch (err) {
      setError(refusalMessage(err as never, new Date()).text)
    } finally {
      setBusy(false)
    }
  }

  const download = () => run(async () => {
    const { blob, filename } = await api.downloadStudioPackage(designId, category, f.revision)
    saveBlob(blob, filename)
  })

  const retry = () => run(async () => {
    await api.retryStudioPackage(designId, category, f.revision)
    await onChanged()
  })

  const report = () => run(async () => {
    const r = await api.reportStudioMistake(designId, category, f.revision, text.trim())
    if (r.status === 'refunded') setRefunded({ refundCents: r.refundCents, creditedCents: r.creditedCents ?? 0 })
    setReporting(false)
    await onChanged()
  })

  // The MANA share of a refund went back as Virvi credit: it can go back to the wallet as MANA instead
  const manaInstead = () => run(async () => {
    await api.requestStudioManaRefund(f.report!.id!)
    await onChanged()
  })

  return (
    <li className="px-4 py-3 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="font-medium">Revision {f.revision}</p>
          <p className="text-xs text-gray-500">
            {f.kind === 'first' ? 'First finalize' : 'Revision'}{f.amountCents !== null && ` · ${formatCents(f.amountCents)}`}
            {f.paidAt && ` · paid ${new Date(f.paidAt).toLocaleDateString()}`}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {f.report && (f.report.status === 'waived' || f.report.status === 'refunded') && (
            <Badge tone="success">{f.report.status === 'waived' ? 'Waived' : 'Refunded'}</Badge>
          )}
          {actions.packaging && <span className="text-gray-400">Packaging…</span>}
          {actions.download && scene && mine && <a href="/assets" className="text-blue-300 underline">In your 3D Models</a>}
          {actions.download && <PrimaryButton type="button" disabled={busy} onClick={download}>Download</PrimaryButton>}
          {actions.retry && act && <PrimaryButton type="button" disabled={busy} onClick={retry}>Try again</PrimaryButton>}
          {mine && actions.report === 'open' && !reporting && refunded === null && (
            <button type="button" onClick={() => setReporting(true)} className="text-gray-400 underline hover:text-white">Report a mistake</button>
          )}
        </div>
      </div>
      {actions.retry && <p className="mt-1 text-xs text-gray-500">{act ? 'Packaging didn’t finish. Trying again is free.' : 'Packaging didn’t finish.'}</p>}
      {reporting && (
        <form className="mt-3 space-y-2" onSubmit={(e) => { e.preventDefault(); if (reportOk(text)) report() }}>
          <label className="block">
            <span className="mb-1 block text-xs text-gray-400">What did the agent get wrong?</span>
            <textarea rows={3} maxLength={REPORT_MAX} value={text} onChange={(e) => setText(e.target.value)} autoFocus
              className="w-full rounded-md border border-gray-800 bg-gray-950 px-3 py-2 text-white outline-none focus:border-blue-400" />
          </label>
          <div className="flex gap-2">
            <PrimaryButton type="submit" disabled={busy || !reportOk(text)}>Refund this revision</PrimaryButton>
            <button type="button" onClick={() => setReporting(false)} className="rounded-md bg-gray-800 px-4 py-2 text-sm hover:bg-gray-700">Cancel</button>
          </div>
        </form>
      )}
      {refunded !== null && (
        <p className="mt-2 text-emerald-300" role="status">
          Refunded {formatCents(refunded.refundCents)}.
          {refunded.creditedCents > 0 && ` ${formatCredit(refunded.creditedCents)} went to your Virvi credit, for your next checkout.`}
        </p>
      )}
      {mine && mana.offer && (
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <p className="text-gray-300">You paid {formatCredit(f.report!.manaCents!)} of this in MANA.</p>
          <button type="button" disabled={busy} onClick={manaInstead} className="rounded-md bg-gray-800 px-3 py-1.5 text-sm hover:bg-gray-700 disabled:opacity-50">
            Send it back as MANA instead
          </button>
        </div>
      )}
      {mine && mana.note && <p className="mt-2 text-gray-300" role="status">{mana.note}</p>}
      {mine && f.report && reportCopy(f.report.status) && <p className="mt-2 text-gray-300" role="status">{reportCopy(f.report.status)}</p>}
      {error && <p className="mt-2 text-amber-300" role="alert">{error}</p>}
    </li>
  )
}
