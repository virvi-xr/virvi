'use client'
import { useState } from 'react'
import { useApi } from '@/lib/api'
import { Badge, PrimaryButton } from '@/components/ui'
import {
  formatCents, REPORT_MAX, refusalMessage, reportCopy, reportOk, revisionActions,
  type FinalizedRevision, type StudioPiece,
} from '@/lib/studio'

type Props = { designId: string; piece: StudioPiece | undefined; onChanged: () => Promise<void>; kind?: string }

/** The selected piece's paid revisions: download, a free retry when packaging failed, and mistake reports. */
export default function PaidRevisions({ designId, piece, onChanged, kind }: Props) {
  if (!piece || piece.finalized.length === 0) return null
  return (
    <div className="rounded-lg border border-gray-800 bg-gray-900">
      <h3 className="border-b border-gray-800 px-4 py-3 text-sm font-medium">Paid revisions · {piece.name}</h3>
      <ul className="divide-y divide-gray-800">
        {piece.finalized.map((f) => <PaidRevision key={f.revision} designId={designId} category={piece.category} f={f} onChanged={onChanged} scene={kind === 'scene'} />)}
      </ul>
    </div>
  )
}

function PaidRevision({ designId, category, f, onChanged, scene }: { designId: string; category: string; f: FinalizedRevision; onChanged: () => Promise<void>; scene?: boolean }) {
  const api = useApi()
  const actions = revisionActions(f, new Date())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [reporting, setReporting] = useState(false)
  const [text, setText] = useState('')
  const [refunded, setRefunded] = useState<number | null>(null)

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
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    a.click()
    setTimeout(() => URL.revokeObjectURL(url), 10_000)
  })

  const retry = () => run(async () => {
    await api.retryStudioPackage(designId, category, f.revision)
    await onChanged()
  })

  const report = () => run(async () => {
    const r = await api.reportStudioMistake(designId, category, f.revision, text.trim())
    if (r.status === 'refunded') setRefunded(r.refundCents)
    setReporting(false)
    await onChanged()
  })

  return (
    <li className="px-4 py-3 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="font-medium">Revision {f.revision}</p>
          <p className="text-xs text-gray-500">
            {f.kind === 'first' ? 'First finalize' : 'Revision'} · {formatCents(f.amountCents)}
            {f.paidAt && ` · paid ${new Date(f.paidAt).toLocaleDateString()}`}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {f.report && (f.report.status === 'waived' || f.report.status === 'refunded') && (
            <Badge tone="success">{f.report.status === 'waived' ? 'Waived' : 'Refunded'}</Badge>
          )}
          {actions.packaging && <span className="text-gray-400">Packaging…</span>}
          {actions.download && scene && <a href="/assets" className="text-blue-300 underline">In your asset library</a>}
          {actions.download && <PrimaryButton type="button" disabled={busy} onClick={download}>Download</PrimaryButton>}
          {actions.retry && <PrimaryButton type="button" disabled={busy} onClick={retry}>Try again</PrimaryButton>}
          {actions.report === 'open' && !reporting && refunded === null && (
            <button type="button" onClick={() => setReporting(true)} className="text-gray-400 underline hover:text-white">Report a mistake</button>
          )}
        </div>
      </div>
      {actions.retry && <p className="mt-1 text-xs text-gray-500">Packaging didn’t finish. Trying again is free.</p>}
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
      {refunded !== null && <p className="mt-2 text-emerald-300" role="status">Refunded {formatCents(refunded)}.</p>}
      {f.report && reportCopy(f.report.status) && <p className="mt-2 text-gray-300" role="status">{reportCopy(f.report.status)}</p>}
      {error && <p className="mt-2 text-amber-300" role="alert">{error}</p>}
    </li>
  )
}
