'use client'
import { useEffect, useReducer, useRef, useState } from 'react'
import Link from 'next/link'
import { useApi } from '@/lib/api'
import { trialCtx } from '@/lib/studio'
import type { BlockedCtx } from '@/lib/trial'
import { getBrowserWallet, useAuth, type Eip1193Provider } from '@/lib/auth'
import { PageHeader, PrimaryButton, Skeleton } from '@/components/ui'
import { formatMana, sendMana, walletRejected } from '@/lib/mana'
import { MANA_IDLE, canQuote, confirmLoop, manaReducer, manaView, onSent, type ManaEvent, type ManaState } from '@/lib/mana-flow'
import {
  checkoutQuoteRefusal, checkoutReportsKey, checkoutTarget, checkoutTotals, countdown, formatCents, formatCredit, HELD_REPORT_COPY, lineNote, PRICE_LABEL, refusalMessage,
  type CheckoutMethod, type CheckoutResult, type CheckoutTarget, type ManaQuote, type Quote, type StudioUsage,
} from '@/lib/studio'

/** How often the page asks about a sent MANA transaction until Polygon confirms it. */
const POLL_MS = 5000
const NO_WALLET = 'Pay with MANA needs a browser wallet like MetaMask. You can pay by card.'

type OrderLine = { key: string; name: string; detail: string; amountCents: number; note: string | null; struck: boolean; held: boolean }
type Order = { lines: OrderLine[]; totalCents: number; creditCents: number; dueCents: number }

/** The design's payable lines (only `categories`, when given), with the dialog's mistake reports waiving theirs. */
function designOrder(quote: Quote, categories: string[] | null, reports: Record<string, string>): Order {
  const q = categories ? { ...quote, lines: quote.lines.filter((l) => categories.includes(l.category)) } : quote
  const reported = Object.keys(reports).filter((c) => q.lines.some((l) => l.category === c))
  const lines = q.lines.map((l): OrderLine => {
    const held = reported.includes(l.category) && (q.reportsHeld ?? []).includes(l.category)
    const waived = reported.includes(l.category) && !held
    const note = lineNote(l) ?? (waived ? 'not charged (the agent’s mistake)' : null)
    return {
      key: l.category, name: l.pieceName, detail: `${PRICE_LABEL[l.priceKind]} · revision ${l.revisionNumber}`,
      amountCents: l.amountCents, note, struck: waived || !!lineNote(l)?.startsWith('free'), held,
    }
  })
  return { lines, ...checkoutTotals(q, reported) }
}

function topupOrder(usage: StudioUsage, packs: number): Order {
  const totalCents = usage.topup.cents * packs
  const creditCents = Math.min(usage.creditCents ?? 0, totalCents)
  return {
    lines: [{
      key: 'topup', name: `${usage.topup.prompts * packs} prompts`, detail: packs > 1 ? `${packs} packs of ${usage.topup.prompts}` : 'One pack',
      amountCents: totalCents, note: null, struck: false, held: false,
    }],
    totalCents, creditCents, dueCents: totalCents - creditCents,
  }
}

function readReports(designId: string): Record<string, string> {
  try {
    const raw = sessionStorage.getItem(checkoutReportsKey(designId))
    const parsed = raw ? JSON.parse(raw) : null
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

export default function Checkout() {
  const { token, user } = useAuth()
  const api = useApi()
  const apiRef = useRef(api)
  apiRef.current = api

  const [target, setTarget] = useState<CheckoutTarget | null | undefined>(undefined)
  const [reports, setReports] = useState<Record<string, string>>({})
  const [usage, setUsage] = useState<StudioUsage | null>(null)
  const [quote, setQuote] = useState<Quote | null>(null)
  // A trial's sign-up sheet names the design: its name and revisions
  const [signUpCtx, setSignUpCtx] = useState<BlockedCtx | undefined>(undefined)
  const [loadError, setLoadError] = useState<string | null>(null)
  // The ticked pieces were paid for meanwhile (another tab): the nothing-left page, not an error
  const [nothingLeft, setNothingLeft] = useState(false)
  const [wallet, setWallet] = useState<Eip1193Provider | null>(null)
  const [cardBusy, setCardBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Pay with MANA's steps (lib/mana-flow.ts). The ref is the latest state for the flow's awaits: dispatch updates it at once.
  const [mana, dispatchMana] = useReducer(manaReducer, MANA_IDLE)
  const manaRef = useRef<ManaState>(mana)
  const dispatch = (e: ManaEvent) => {
    manaRef.current = manaReducer(manaRef.current, e)
    dispatchMana(e)
  }
  const latest = (): ManaState => manaRef.current
  const [now, setNow] = useState(() => new Date())
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => { alive.current = false }
  }, [])

  useEffect(() => {
    const t = checkoutTarget(window.location.search)
    setTarget(t)
    if (t?.kind === 'design') setReports(readReports(t.designId))
    setWallet(getBrowserWallet())
  }, [])

  useEffect(() => {
    if (!token || !target) return
    let cancelled = false
    apiRef.current.getStudioUsage().then((u) => { if (!cancelled) setUsage(u) })
      // a top-up's order is the usage's price; a design's only loses Pay with MANA without it
      .catch((err) => { if (!cancelled && target.kind === 'topup') setLoadError(refusalMessage(err, new Date()).text) })
    if (target.kind === 'design') {
      // The ticked pieces' own quote: which is the first piece, and the free finalizes, are the server's
      apiRef.current.getStudioQuote(target.designId, target.categories)
        .then((q) => { if (!cancelled) setQuote(q) })
        .catch((err) => {
          if (cancelled) return
          const r = checkoutQuoteRefusal(err)
          if (r === 'nothing_left') setNothingLeft(true)
          else setLoadError(r)
        })
      if (user?.trial) apiRef.current.getStudioDesign(target.designId).then((d) => { if (!cancelled) setSignUpCtx(trialCtx(d)) }).catch(() => {})
    }
    return () => { cancelled = true }
  }, [token, target, user?.trial])

  // The quote's countdown ticks while one is on screen
  const ticking = mana.step === 'sending' || mana.step === 'quoted'
  useEffect(() => {
    if (!ticking) return
    setNow(new Date())
    const t = setInterval(() => setNow(new Date()), 1000)
    return () => clearInterval(t)
  }, [ticking])

  if (target === undefined) return null
  if (target === null) {
    return (
      <Shell>
        <p className="text-sm text-gray-300">This checkout link isn’t complete. Go back to your design and finalize it again.</p>
        <Link href="/studio/" className="mt-3 inline-block text-sm text-blue-300 underline">Your designs</Link>
      </Shell>
    )
  }

  const backHref = target.kind === 'design' ? `/studio/${target.designId}/` : '/studio/'
  const order = target.kind === 'design'
    ? quote && designOrder(quote, target.categories, reports)
    : usage && topupOrder(usage, target.packs)
  const view = manaView(mana, now)
  const cardDisabled = cardBusy || !view.cardOpen

  if (loadError) {
    return (
      <Shell back={backHref}>
        <p className="text-sm text-amber-300" role="alert">{loadError}</p>
      </Shell>
    )
  }
  if (!nothingLeft && !order) return <Shell back={backHref}><Skeleton rows={2} /></Shell>
  if (nothingLeft || !order || order.lines.length === 0) {
    return (
      <Shell back={backHref}>
        <p className="text-sm text-gray-300">There’s nothing left to pay for on this design.</p>
      </Shell>
    )
  }

  const run = (method: CheckoutMethod): Promise<CheckoutResult> => target.kind === 'design'
    ? api.finalizeStudio(target.designId, {
      ...(target.categories ? { categories: target.categories } : {}),
      ...(Object.keys(reports).length ? { reports } : {}),
      method,
    }, signUpCtx)
    : api.buyStudioPrompts(target.packs, method)

  /** Paid: back to the design (its banner follows the payment) or to the studio, where the prompts show up. */
  const finish = (paymentId: string) => {
    if (target.kind === 'design') {
      try { sessionStorage.removeItem(checkoutReportsKey(target.designId)) } catch { /* nothing kept */ }
    }
    window.location.assign(`${backHref}?payment=${paymentId}`)
  }

  /** Stripe's page or a grant leaves this page; a MANA quote comes back to pay. */
  const follow = (r: CheckoutResult): ManaQuote | null => {
    if ('url' in r) window.location.assign(r.url)
    else if ('granted' in r) finish(r.paymentId)
    else return r.mana
    return null
  }

  const payCard = async () => {
    setCardBusy(true)
    setError(null)
    try {
      follow(await run('card'))
    } catch (err) {
      setError(refusalMessage(err as never, new Date()).text)
      setCardBusy(false)
    }
  }

  const payMana = async () => {
    if (!canQuote(latest())) return
    dispatch({ type: 'pay' })
    const mine = latest().attempt
    setError(null)
    let q: ManaQuote | null
    try {
      q = follow(await run('mana'))
    } catch (err) {
      if (latest().attempt === mine) setError(refusalMessage(err as never, new Date()).text)
      dispatch({ type: 'quoteFailed', attempt: mine })
      return
    }
    if (!q) return // fully covered: on the way to the design
    dispatch({ type: 'quote', attempt: mine, quote: q })
    const cur = latest()
    if (cur.step !== 'sending' || cur.attempt !== mine) return
    const w = wallet ?? getBrowserWallet()
    if (!w) {
      dispatch({ type: 'rejected', attempt: mine })
      setError(NO_WALLET)
      return
    }
    let hash: string
    try {
      hash = await sendMana(w, q)
    } catch (err) {
      dispatch(walletRejected(err)
        ? { type: 'rejected', attempt: mine }
        : { type: 'walletError', attempt: mine, text: `${(err as Error)?.message || 'Your wallet didn’t send the payment.'} Get a new price to try again.` })
      return
    }
    const sent = onSent(latest(), mine, q, hash)
    if (sent.reportStale) {
      // The page moved on, but this MANA was sent: the server can still settle it (a duplicate becomes credit)
      apiRef.current.reportStudioManaTx(sent.reportStale.paymentId, sent.reportStale.hash).catch(() => {})
      return
    }
    dispatch({ type: 'sent', attempt: mine, hash })
    await confirm(q, hash, mine)
  }

  /** Reports the hash on every poll until the payment is paid (the server settles it on a report), or it can't be. */
  const confirm = async (q: ManaQuote, hash: string, mine: number) => {
    const outcome = await confirmLoop({
      report: () => apiRef.current.reportStudioManaTx(q.paymentId, hash),
      active: () => alive.current && latest().step === 'confirming' && latest().attempt === mine,
      wait: () => new Promise((r) => setTimeout(r, POLL_MS)),
    })
    if (outcome === 'paid') return finish(q.paymentId)
    if (!outcome) return
    if ('txFailed' in outcome) {
      dispatch({ type: 'txFailed', attempt: mine, text: refusalMessage({ body: { code: 'tx_failed' } }, new Date()).text })
    } else {
      const code = outcome.support === 'tx_used' ? 'tx_used' : 'tx_mismatch'
      dispatch({ type: 'support', attempt: mine, hash, text: refusalMessage({ body: { code } }, new Date()).text })
    }
  }

  const manaOn = !!usage?.mana
  const due = order.dueCents

  return (
    <Shell back={backHref}>
      <section aria-labelledby="order-title" className="rounded-lg border border-gray-800 bg-gray-900">
        <h2 id="order-title" className="border-b border-gray-800 px-4 py-3 text-sm font-medium">Your order</h2>
        <ul className="divide-y divide-gray-800 px-4">
          {order.lines.map((l) => (
            <li key={l.key} className="py-3">
              <div className="flex items-baseline justify-between gap-3">
                <div className="min-w-0">
                  <p className="truncate font-medium">{l.name}</p>
                  <p className="text-xs text-gray-500">{l.detail}</p>
                </div>
                <p className="shrink-0 text-right">
                  <span className={l.struck ? 'text-gray-500 line-through' : ''}>{formatCents(l.amountCents)}</span>
                  {l.note && <span className="block text-xs text-emerald-300">{l.note}</span>}
                </p>
              </div>
              {l.held && <p className="mt-2 text-xs text-gray-400">{HELD_REPORT_COPY}</p>}
            </li>
          ))}
        </ul>
        {quote?.notes.map((n) => <p key={n} className="px-4 pb-3 text-sm text-gray-400">{n}</p>)}
        <dl className="space-y-1 border-t border-gray-800 px-4 py-3 text-sm">
          {order.creditCents > 0 && (
            <>
              <div className="flex justify-between text-gray-400"><dt>Total</dt><dd>{formatCents(order.totalCents)}</dd></div>
              <div className="flex justify-between text-emerald-300"><dt>Virvi credit</dt><dd>−{formatCredit(order.creditCents)}</dd></div>
            </>
          )}
          <div className="flex items-baseline justify-between pt-1">
            <dt className="text-gray-400">Due</dt>
            <dd className="text-xl font-semibold text-white">{formatCents(due)} <span className="text-sm font-normal text-gray-500">USD</span></dd>
          </div>
        </dl>
      </section>

      {error && <p className="mt-4 text-sm text-amber-300" role="alert">{error}</p>}

      {due === 0 ? (
        <div className="mt-4">
          <PrimaryButton type="button" disabled={cardDisabled} onClick={payCard}>{cardBusy ? 'Finalizing…' : 'Finalize'}</PrimaryButton>
          <p className="mt-2 text-xs text-gray-500">Nothing to pay: your credit, gifts or reports cover it.</p>
        </div>
      ) : (
        <div className={`mt-4 grid gap-4 ${manaOn ? 'sm:grid-cols-2' : ''}`}>
          <section aria-labelledby="card-title" className="rounded-lg border border-gray-800 bg-gray-900 p-4">
            <h2 id="card-title" className="text-sm font-medium">Pay by card</h2>
            <p className="mt-1 text-xs text-gray-500">Secure checkout with Stripe.</p>
            <PrimaryButton type="button" className="mt-3" disabled={cardDisabled} onClick={payCard}>
              {cardBusy ? 'Opening Stripe…' : `Pay ${formatCents(due)} by card`}
            </PrimaryButton>
          </section>
          {manaOn && (
            <section aria-labelledby="mana-title" className="rounded-lg border border-gray-800 bg-gray-900 p-4">
              <h2 id="mana-title" className="text-sm font-medium">Pay with MANA</h2>
              <p className="mt-1 text-xs text-gray-500">On Polygon, at today’s MANA price, from any wallet.</p>
              {wallet
                ? <ManaPanel mana={mana} now={now} disabled={cardBusy} onPay={payMana} />
                : <p className="mt-3 text-sm text-gray-300">{NO_WALLET}</p>}
            </section>
          )}
        </div>
      )}
    </Shell>
  )
}

function ManaPanel({ mana, now, disabled, onPay }: { mana: ManaState; now: Date; disabled: boolean; onPay: () => void }) {
  const v = manaView(mana, now)
  const q = v.quote
  const hash = 'hash' in mana ? mana.hash : null
  return (
    <div className="text-sm">
      {q && mana.step !== 'mismatch' && (
        <>
          <p className="mt-3 text-2xl font-semibold text-white">{formatMana(q.amountWei)}</p>
          {mana.step !== 'confirming' && (
            <p className="mt-1 text-xs text-gray-500">
              {formatCents(q.usdCents)} at ${q.usdPerMana.toFixed(4)} per MANA · {v.expired ? 'price expired' : `price held for ${countdown(q.expiresAt, now)}`}
            </p>
          )}
        </>
      )}
      {v.message && (
        <p className={`mt-2 ${v.tone === 'alert' ? 'text-amber-300' : 'text-gray-300'}`} role={v.tone ?? undefined}>{v.message}</p>
      )}
      {mana.step === 'confirming' && <p className="mt-1 text-xs text-gray-500">This takes a minute or two. You can keep this page open.</p>}
      {hash && (
        <p className="mt-2 text-xs text-gray-500">Transaction: <a className="break-all text-blue-300 underline" href={`https://polygonscan.com/tx/${hash}`} target="_blank" rel="noreferrer">{hash}</a></p>
      )}
      {(v.action || mana.step === 'quoting') && (
        <PrimaryButton type="button" className="mt-3" disabled={disabled || mana.step === 'quoting'} onClick={onPay}>
          {mana.step === 'quoting' ? 'Getting the MANA price…' : v.action === 'requote' ? 'Get a new price' : 'Pay with MANA'}
        </PrimaryButton>
      )}
    </div>
  )
}

/** `back`: the design this checkout pays for (or the studio, for prompts), linked under the title. */
function Shell({ back, children }: { back?: string; children: React.ReactNode }) {
  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader crumbs={['Workspace', { label: 'Design Studio', href: '/studio/' }, 'Checkout']} title="Checkout"
        subtitle={back && back !== '/studio/' ? <Link href={back} className="text-blue-300 underline">Back to your design</Link> : undefined} />
      {children}
    </div>
  )
}
