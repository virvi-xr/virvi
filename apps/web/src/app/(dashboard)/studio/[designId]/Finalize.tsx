'use client'
import { useEffect, useState } from 'react'
import { useApi } from '@/lib/api'
import { Badge, PrimaryButton } from '@/components/ui'
import {
  checkoutBody, dialogTotal, emoteChecklist, finalizeStrip, formatCents, HELD_REPORT_COPY, REPORT_MAX, refusalMessage, reportOk,
  type Quote, type QuoteLine, type Refusal, type StudioDetail, type StudioKind,
} from '@/lib/studio'
import { STATE_BADGE, emoteName, type EmoteTarget } from './EmotesStep'

const PRICE_LABEL: Record<QuoteLine['priceKind'], string> = {
  first: 'First finalize',
  first_extra: 'Extra piece',
  revision: 'Revision',
  revision_extra: 'Revision',
}

/**
 * Every emote on both body shapes and whether the person has looked: a nudge, never a gate. Opening it renders the
 * ones that aren't yet, and each row opens that emote in the Emotes step.
 */
export function EmoteChecklist({ designId, detail, onOpen }: { designId: string; detail: StudioDetail; onOpen: (t: EmoteTarget) => void }) {
  const api = useApi()
  useEffect(() => {
    if (detail.pieces.some((p) => p.revision)) api.requestStudioFinalizeRenders(designId).catch(() => {})
  }, [designId, detail.set.revisions]) // eslint-disable-line react-hooks/exhaustive-deps
  const { rows, checkedCount } = emoteChecklist(detail)
  return (
    <div>
      <p className="text-sm text-gray-300">
        You’ve checked {checkedCount} of {rows.length}.{checkedCount < rows.length && ' Play each emote and say whether it looks right: clipping is fixed free.'}
      </p>
      <ul className="mt-2 grid grid-cols-1 gap-1 sm:grid-cols-2">
        {rows.map((r) => {
          const b = STATE_BADGE[r.state]
          const view = detail.set.views[`walk-${r.bodyShape}-default-${r.emote}`]
          return (
            <li key={`${r.emote}-${r.bodyShape}`}>
              <button type="button" onClick={() => onOpen({ emote: r.emote, bodyShape: r.bodyShape })}
                className="flex w-full items-center justify-between gap-2 rounded px-2 py-1.5 text-left text-sm text-gray-300 hover:bg-white/[0.04]">
                <span>{emoteName(r.emote)} · {r.bodyShape === 'male' ? 'Male' : 'Female'}</span>
                {b ? <Badge tone={b.tone}>{b.label}</Badge>
                  : <span className="text-xs text-gray-500">{view?.status === 'ready' ? 'Not checked' : 'Rendering…'}</span>}
              </button>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

type Props = {
  designId: string; kind: StudioKind; quote: Quote | null; busy: boolean; onChanged: () => Promise<void>
  detail: StudioDetail; onOpenEmote: (t: EmoteTarget) => void
}

/** The finalize strip under the preview, and the dialog that pays for every payable piece at once. */
export default function Finalize({ designId, kind, quote, busy, onChanged, detail, onOpenEmote }: Props) {
  const [open, setOpen] = useState(false)
  const strip = finalizeStrip(quote, kind)
  return (
    <div className="rounded-lg border border-gray-800 bg-gray-900 p-4">
      <p className="text-sm text-gray-300">{strip.unlocks}</p>
      {strip.blocked && <p className="mt-2 text-sm text-amber-300">{strip.blocked}</p>}
      {strip.button && (
        <PrimaryButton type="button" className="mt-3" disabled={busy} onClick={() => setOpen(true)}>{strip.button}</PrimaryButton>
      )}
      {open && quote && (
        <FinalizeDialog designId={designId} quote={quote} onClose={() => setOpen(false)} onChanged={onChanged}>
          <EmoteChecklist designId={designId} detail={detail} onOpen={(t) => { setOpen(false); onOpenEmote(t) }} />
        </FinalizeDialog>
      )}
    </div>
  )
}

function FinalizeDialog({ designId, quote, onClose, onChanged, children }: {
  designId: string; quote: Quote; onClose: () => void; onChanged: () => Promise<void>; children: React.ReactNode
}) {
  const api = useApi()
  const [reports, setReports] = useState<Record<string, string>>({})
  const [paying, setPaying] = useState(false)
  const [refusal, setRefusal] = useState<Refusal | null>(null)

  useEffect(() => {
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape' && !paying) onClose() }
    document.addEventListener('keydown', esc)
    return () => document.removeEventListener('keydown', esc)
  }, [onClose, paying])

  const reported = Object.keys(reports)
  const incomplete = reported.some((c) => !reportOk(reports[c]))
  const total = dialogTotal(quote, reported)

  const toggle = (category: string) => setReports((prev) => {
    const next = { ...prev }
    if (category in next) delete next[category]
    else next[category] = ''
    return next
  })

  const pay = async () => {
    setPaying(true)
    setRefusal(null)
    try {
      const r = await api.finalizeStudio(designId, checkoutBody(reports))
      if ('url' in r) {
        window.location.assign(r.url)
        return
      }
      onClose()
      await onChanged()
    } catch (err) {
      setRefusal(refusalMessage(err as never, new Date()))
      setPaying(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" onMouseDown={(e) => { if (e.target === e.currentTarget && !paying) onClose() }}>
      <div role="dialog" aria-modal="true" aria-labelledby="finalize-title" className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-lg border border-gray-800 bg-gray-900 p-5">
        <h2 id="finalize-title" className="text-lg font-semibold">Finalize</h2>
        <ul className="mt-4 divide-y divide-gray-800">
          {quote.lines.map((l) => {
            const reported = l.category in reports
            // Past the piece's instant refunds, a report is charged now and goes to the team
            const held = reported && (quote.reportsHeld ?? []).includes(l.category)
            const waived = reported && !held
            const revision = l.priceKind.startsWith('revision')
            return (
              <li key={l.category} className="py-3">
                <div className="flex items-baseline justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate font-medium">{l.pieceName}</p>
                    <p className="text-xs text-gray-500">{PRICE_LABEL[l.priceKind]} · revision {l.revisionNumber}</p>
                  </div>
                  <p className="shrink-0 text-right">
                    <span className={waived || l.gift ? 'text-gray-500 line-through' : ''}>{formatCents(l.amountCents)}</span>
                    {l.gift ? <span className="block text-xs text-emerald-300">free (gift code)</span> : waived && <span className="block text-xs text-emerald-300">not charged</span>}
                  </p>
                </div>
                {revision && (
                  <label className="mt-2 flex items-center gap-2 text-sm text-gray-300">
                    <input type="checkbox" checked={reported} onChange={() => toggle(l.category)} />
                    This revision fixes the agent’s mistake
                  </label>
                )}
                {held && <p className="mt-2 text-xs text-gray-400">{HELD_REPORT_COPY}</p>}
                {reported && (
                  <label className="mt-2 block">
                    <span className="mb-1 block text-xs text-gray-400">What did the agent get wrong?</span>
                    <textarea rows={3} maxLength={REPORT_MAX} value={reports[l.category]}
                      onChange={(e) => setReports((prev) => ({ ...prev, [l.category]: e.target.value }))}
                      className="w-full rounded-md border border-gray-800 bg-gray-950 px-3 py-2 text-sm text-white outline-none focus:border-blue-400" />
                    {!reportOk(reports[l.category]) && <span className="text-xs text-gray-500">At least 10 characters.</span>}
                  </label>
                )}
              </li>
            )
          })}
        </ul>
        {quote.notes.map((n) => <p key={n} className="mt-3 text-sm text-gray-400">{n}</p>)}
        <div className="mt-4 border-t border-gray-800 pt-4">{children}</div>
        <div className="mt-4 flex items-baseline justify-between border-t border-gray-800 pt-4">
          <span className="text-gray-400">Total</span>
          <span className="text-xl font-semibold">{formatCents(total)}</span>
        </div>
        {refusal && <p className="mt-3 text-sm text-amber-300" role="alert">{refusal.text}</p>}
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" onClick={onClose} disabled={paying} className="rounded-md bg-gray-800 px-4 py-2 text-sm hover:bg-gray-700">Cancel</button>
          <PrimaryButton type="button" onClick={pay} disabled={paying || incomplete}>
            {paying ? 'Opening Stripe…' : total > 0 ? `Pay ${formatCents(total)}` : 'Finalize'}
          </PrimaryButton>
        </div>
      </div>
    </div>
  )
}
