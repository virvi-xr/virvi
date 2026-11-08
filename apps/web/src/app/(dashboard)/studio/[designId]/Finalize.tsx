'use client'
import { useEffect, useRef, useState } from 'react'
import { useApi } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { Badge, PrimaryButton } from '@/components/ui'
import {
  canReport, checkoutBody, checkoutHref, checkoutReportsKey, dialogTotal, emoteChecklist, finalizeChoices, finalizeStrip, formatCents, initialSelection,
  latestOnly, lineNote, HELD_REPORT_COPY, PRICE_LABEL, REPORT_MAX, refusalMessage, reportOk, selectionCategories, selectionProblem, toggleSelection,
  triangleWarning, wornDetail, type Quote, type StudioDetail, type StudioKind, type WornState,
} from '@/lib/studio'
import { NONE_TICKED, STATE_BADGE, WORN_NOTE, emoteName, type EmoteTarget } from './EmotesStep'

/**
 * Every emote on both body shapes and whether the person has looked: a nudge, never a gate. Opening it renders the
 * ones that aren't yet, and each row opens that emote in the Emotes step. With only some pieces ticked (`worn`), it
 * is about those pieces and the finalized ones worn together; 'loading' while that selection's views are fetched,
 * 'none' with nothing ticked.
 */
export function EmoteChecklist({ designId, detail: whole, worn = null, onOpen }: {
  designId: string; detail: StudioDetail; worn?: WornState; onOpen: (t: EmoteTarget) => void
}) {
  const api = useApi()
  const { user } = useAuth()
  const waiting = worn === 'loading' || worn === 'none'
  const selection = waiting ? null : worn
  const detail = wornDetail(whole, selection)
  useEffect(() => {
    // finalize-renders is closed to a trial: asking would open an unrequested sign-up sheet
    if (waiting) return
    if (!user?.trial && detail.pieces.some((p) => p.revision)) api.requestStudioFinalizeRenders(designId, selection?.categories ?? null).catch(() => {})
  }, [designId, waiting ? null : detail.set.revisions]) // eslint-disable-line react-hooks/exhaustive-deps
  if (worn === 'none') return <p className="text-sm text-gray-400">{NONE_TICKED}</p>
  if (worn === 'loading') return <p className="text-sm text-gray-400" aria-live="polite">Loading the emote checks for the pieces you ticked…</p>
  const { rows, checkedCount } = emoteChecklist(detail)
  return (
    <div>
      {selection && <p className="mb-1 text-xs text-gray-400">{WORN_NOTE}</p>}
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
  designId: string; kind: StudioKind; quote: Quote | null; busy: boolean
  detail: StudioDetail; onOpenEmote: (t: EmoteTarget) => void
  /** The ticked pieces (null: not chosen yet, so every payable piece), kept by the page while the dialog closes. */
  selected: string[] | null; onSelected: (categories: string[] | null) => void
  worn: WornState
}

/** The finalize strip under the preview, and the dialog that pays for the ticked pieces (every payable one at first). */
export default function Finalize({ designId, kind, quote, busy, detail, onOpenEmote, selected, onSelected, worn }: Props) {
  const [open, setOpen] = useState(false)
  const strip = finalizeStrip(quote, kind)
  return (
    <div className="rounded-lg border border-gray-800 bg-gray-900 p-4">
      <p className="text-sm text-gray-300">{strip.unlocks}</p>
      {strip.blocked && <p className="mt-2 text-sm text-amber-300">{strip.blocked}</p>}
      {detail.pieces.map((p) => triangleWarning(p.name, p.revision?.checker ?? null)).filter(Boolean).map((w) => (
        <p key={w} className="mt-2 text-sm text-amber-300">{w}</p>
      ))}
      {strip.button && (
        <PrimaryButton type="button" className="mt-3" disabled={busy} onClick={() => setOpen(true)}>{strip.button}</PrimaryButton>
      )}
      {open && quote && (
        <FinalizeDialog designId={designId} quote={quote} selected={selected ?? initialSelection(quote)} onSelected={onSelected}
          onClose={() => { setOpen(false); onSelected(null) }}>
          {kind !== 'scene' && <EmoteChecklist designId={designId} detail={detail} worn={worn} onOpen={(t) => { setOpen(false); onOpenEmote(t) }} />}
        </FinalizeDialog>
      )}
    </div>
  )
}

function FinalizeDialog({ designId, quote, selected, onSelected, onClose, children }: {
  designId: string; quote: Quote; selected: string[]; onSelected: (categories: string[]) => void; onClose: () => void; children: React.ReactNode
}) {
  const api = useApi()
  const [reports, setReports] = useState<Record<string, string>>({})
  const [paying, setPaying] = useState(false)
  // The selection's quote, from the server: the total, free finalizes and which piece is the first are always its
  const chosen = selectionCategories(selected, quote)
  const chosenKey = chosen?.join(',') ?? ''
  const [picked, setPicked] = useState<{ key: string; quote: Quote } | null>(null)
  const [quoteError, setQuoteError] = useState<string | null>(null)
  const gate = useRef(latestOnly())

  useEffect(() => {
    setQuoteError(null)
    const id = gate.current.next()
    if (!chosen?.length) return
    api.getStudioQuote(designId, chosen)
      .then((q) => { if (gate.current.isLatest(id)) setPicked({ key: chosenKey, quote: q }) })
      .catch((err) => { if (gate.current.isLatest(id)) setQuoteError(refusalMessage(err as never, new Date()).text) })
  }, [designId, chosenKey]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape' && !paying) onClose() }
    document.addEventListener('keydown', esc)
    return () => document.removeEventListener('keydown', esc)
  }, [onClose, paying])

  // Everything ticked is the quote the page already has; a selection's comes back from the server
  const shown = chosen === null ? quote : picked?.key === chosenKey ? picked.quote : null
  const problem = selectionProblem(chosen ?? selected)
  const reported = Object.keys(reports).filter((c) => shown?.lines.some((l) => l.category === c && canReport(l, selected)))
  const incomplete = reported.some((c) => !reportOk(reports[c]))
  const total = shown ? dialogTotal(shown, reported) : null

  const toggleReport = (category: string) => setReports((prev) => {
    const next = { ...prev }
    if (category in next) delete next[category]
    else next[category] = ''
    return next
  })

  // Paying happens on the checkout page (card and MANA side by side, credit applied); the ticked pieces go in its
  // link, the reports with it
  const pay = () => {
    setPaying(true)
    const body = checkoutBody(Object.fromEntries(reported.map((c) => [c, reports[c]])), chosen)
    try {
      if (body.reports) sessionStorage.setItem(checkoutReportsKey(designId), JSON.stringify(body.reports))
      else sessionStorage.removeItem(checkoutReportsKey(designId))
    } catch {
      /* no storage (a private window): the checkout charges the reported lines, which can still be reported after */
    }
    window.location.assign(checkoutHref({ kind: 'design', designId, categories: body.categories ?? null }))
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" onMouseDown={(e) => { if (e.target === e.currentTarget && !paying) onClose() }}>
      <div role="dialog" aria-modal="true" aria-labelledby="finalize-title" className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-lg border border-gray-800 bg-gray-900 p-5">
        <h2 id="finalize-title" className="text-lg font-semibold">Finalize</h2>
        <p className="mt-1 text-sm text-gray-400">Tick the pieces to finalize now. You can keep working on the rest and finalize them later.</p>
        <ul className="mt-4 divide-y divide-gray-800">
          {finalizeChoices(quote).map((c) => {
            const ticked = c.pickable && selected.includes(c.category)
            const l = ticked ? shown?.lines.find((x) => x.category === c.category) : undefined
            const isReported = !!l && reported.includes(c.category)
            // Past the piece's instant refunds, a report is charged now and goes to the team
            const held = isReported && (shown?.reportsHeld ?? []).includes(c.category)
            const waived = isReported && !held
            const boxId = `finalize-${c.category}`
            return (
              <li key={c.category} className="py-3">
                <div className="flex items-baseline justify-between gap-3">
                  <label htmlFor={boxId} className={`flex min-w-0 items-baseline gap-2 ${c.pickable ? 'cursor-pointer' : 'cursor-default'}`}>
                    <input id={boxId} type="checkbox" className="self-center" checked={ticked || c.finalized} disabled={!c.pickable || paying}
                      onChange={() => onSelected(toggleSelection(selected, c.category, quote))} />
                    <span className="min-w-0">
                      <span className={`block truncate font-medium ${c.pickable ? '' : 'text-gray-400'}`}>{c.name}</span>
                      <span className="block text-xs text-gray-500">
                        {c.reason ?? (l ? `${PRICE_LABEL[l.priceKind]} · revision ${l.revisionNumber}` : ticked ? 'Updating the price…' : 'Not finalizing now')}
                      </span>
                    </span>
                  </label>
                  {l && (
                    <p className="shrink-0 text-right">
                      <span className={waived || lineNote(l)?.startsWith('free') ? 'text-gray-500 line-through' : ''}>{formatCents(l.amountCents)}</span>
                      {lineNote(l) ? <span className="block text-xs text-emerald-300">{lineNote(l)}</span> : waived && <span className="block text-xs text-emerald-300">not charged</span>}
                    </p>
                  )}
                </div>
                {l && canReport(l, selected) && (
                  <label className="mt-2 flex items-center gap-2 text-sm text-gray-300">
                    <input type="checkbox" checked={c.category in reports} onChange={() => toggleReport(c.category)} />
                    This revision fixes the agent’s mistake
                  </label>
                )}
                {held && <p className="mt-2 text-xs text-gray-400">{HELD_REPORT_COPY}</p>}
                {isReported && (
                  <label className="mt-2 block">
                    <span className="mb-1 block text-xs text-gray-400">What did the agent get wrong?</span>
                    <textarea rows={3} maxLength={REPORT_MAX} value={reports[c.category]}
                      onChange={(e) => setReports((prev) => ({ ...prev, [c.category]: e.target.value }))}
                      className="w-full rounded-md border border-gray-800 bg-gray-950 px-3 py-2 text-sm text-white outline-none focus:border-blue-400" />
                    {!reportOk(reports[c.category]) && <span className="text-xs text-gray-500">At least 10 characters.</span>}
                  </label>
                )}
              </li>
            )
          })}
        </ul>
        {(shown?.notes ?? []).map((n) => <p key={n} className="mt-3 text-sm text-gray-400">{n}</p>)}
        <div className="mt-4 border-t border-gray-800 pt-4">{children}</div>
        <div className="mt-4 flex items-baseline justify-between border-t border-gray-800 pt-4">
          <span className="text-gray-400">Total</span>
          <span className="text-xl font-semibold" aria-live="polite">{problem ? formatCents(0) : total === null ? '…' : formatCents(total)}</span>
        </div>
        {problem && <p className="mt-2 text-sm text-amber-300" role="status">{problem}</p>}
        {!problem && quoteError && <p className="mt-2 text-sm text-amber-300" role="alert">{quoteError}</p>}
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" onClick={onClose} disabled={paying} className="rounded-md bg-gray-800 px-4 py-2 text-sm hover:bg-gray-700">Cancel</button>
          <PrimaryButton type="button" onClick={pay} disabled={paying || incomplete || !!problem || total === null}>
            {paying ? 'Opening checkout…' : total ? `Continue to pay ${formatCents(total)}` : 'Continue'}
          </PrimaryButton>
        </div>
      </div>
    </div>
  )
}
