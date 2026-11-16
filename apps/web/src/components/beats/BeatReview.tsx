'use client'
// The BEAT review step (LIV-11): the quote's lines and total, the no-refund sentence, and the ways to pay.
import { useEffect, useRef, useState } from 'react'
import { useApi } from '@/lib/api'
import { PAY_BUSY, beatFieldError, payBody, reviewModel, topupKey, type BeatQuote, type ReviewMethod } from '@/lib/beats'

/**
 * Pays for a draft's supply, or with `raiseTo` for raising a paid BEAT's cap. Card goes to Stripe, which comes back to
 * the BEAT's page; credit and test BEATs are paid at once (`onPaid`).
 */
export function BeatReview({ beatId, test, raiseTo, summary, onPaid, onBack }: {
  beatId: string
  test: boolean
  raiseTo?: number
  /** What is fixed once it starts (supply, Tradeable, scenes, start), shown above the price (plain-ux I4). */
  summary?: string
  onPaid: () => void
  onBack: () => void
}) {
  const api = useApi()
  const [quote, setQuote] = useState<BeatQuote | null>(null)
  const [creditCents, setCreditCents] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [cardMin, setCardMin] = useState<string | null>(null)
  const [busy, setBusy] = useState<ReviewMethod | null>(null)
  // Focus moves to this step's heading when it opens (plain-ux I13)
  const heading = useRef<HTMLHeadingElement>(null)
  useEffect(() => { heading.current?.focus() }, [])

  useEffect(() => {
    let live = true
    setQuote(null); setError(null)
    setCardMin(null)
    api.getBeatQuote(beatId, raiseTo).then((q) => { if (live) setQuote(q) }).catch((err) => {
      if (!live) return
      // Too small for a card (Stripe's minimum): say so, and price it for credit, which pays any amount
      if ((err as { body?: { error?: string } })?.body?.error === 'below_minimum') {
        setCardMin(beatFieldError(err).message)
        api.getBeatQuote(beatId, raiseTo, 'credit').then((q) => { if (live) setQuote(q) }).catch((e2) => { if (live) setError(beatFieldError(e2).message) })
        return
      }
      setError(beatFieldError(err).message)
    })
    // Virvi credit is the studio's balance (0 where the studio is off)
    if (!test) api.getStudioUsage().then((u) => { if (live) setCreditCents(u.creditCents ?? 0) }).catch(() => {})
    return () => { live = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [beatId, raiseTo, test])

  const pay = async (method: ReviewMethod) => {
    setBusy(method); setError(null)
    try {
      const body = payBody(method)
      const res = raiseTo === undefined ? await api.checkoutBeat(beatId, body) : await api.raiseBeatCap(beatId, raiseTo, body)
      if ('url' in res) {
        // The page Stripe returns to waits for this cap to show
        if (raiseTo !== undefined) try { sessionStorage.setItem(topupKey(beatId), String(raiseTo)) } catch {}
        window.location.assign(res.url)
        return
      }
      onPaid()
    } catch (err) {
      setError(beatFieldError(err).message)
    }
    setBusy(null)
  }

  const model = quote ? reviewModel(quote, { test, creditCents }) : null
  // Under the card minimum only credit can pay
  const r = model && cardMin ? { ...model, buttons: model.buttons.filter((x) => x.method !== 'card') } : model
  return (
    <section aria-label="Review" className="space-y-4 rounded-lg border border-gray-800 bg-gray-900 p-6">
      <h2 ref={heading} tabIndex={-1} className="text-sm font-medium text-gray-300 outline-none">{raiseTo === undefined ? 'Review' : `Raise the cap to ${raiseTo}`}</h2>
      {summary && <p className="text-sm text-gray-200">{summary}</p>}
      {error && <div role="alert" className="rounded-md border border-red-700 bg-red-900/50 px-4 py-2 text-sm text-red-300">{error}</div>}
      {!r ? (!error && <p className="text-sm text-gray-400">Getting the price…</p>) : (
        <>
          <table className="w-full max-w-md text-sm">
            <tbody>
              {r.lines.map((l, i) => (
                <tr key={i}><td className="py-1 text-gray-300">{l.label}</td><td className="py-1 text-right font-mono text-gray-200">{l.amount}</td></tr>
              ))}
              <tr className="border-t border-gray-800"><td className="py-2 font-medium text-white">Total</td><td className="py-2 text-right font-mono font-medium text-white">{r.total}</td></tr>
            </tbody>
          </table>
          <p className="text-sm text-gray-400">{r.note}</p>
          {cardMin && <p role="status" className="text-sm text-amber-200">{cardMin}</p>}
          {r.credit && <p className="text-sm text-gray-400">{r.credit}</p>}
          <div className="flex flex-wrap gap-2">
            {r.buttons.map((b, i) => (
              <button key={b.method} type="button" disabled={busy !== null} onClick={() => pay(b.method)}
                className={`rounded-md px-4 py-2 text-sm font-medium disabled:opacity-50 ${i === 0 ? 'bg-blue-600 text-white hover:bg-blue-500' : 'bg-gray-800 text-gray-200 hover:bg-gray-700'}`}>
                {busy === b.method ? PAY_BUSY[b.method] : b.label}
              </button>
            ))}
            <button type="button" onClick={onBack} disabled={busy !== null} className="rounded-md bg-gray-800 px-4 py-2 text-sm text-gray-300 hover:bg-gray-700 disabled:opacity-50">Back</button>
          </div>
        </>
      )}
      {!r && error && <button type="button" onClick={onBack} className="rounded-md bg-gray-800 px-4 py-2 text-sm text-gray-300 hover:bg-gray-700">Back</button>}
    </section>
  )
}
