'use client'
import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { useApi } from '@/lib/api'
import { getBrowserWallet, useAuth, type Eip1193Provider } from '@/lib/auth'
import { PageHeader, PrimaryButton, Skeleton } from '@/components/ui'
import { formatMana, sendMana, walletRejected } from '@/lib/mana'
import {
  checkoutReportsKey, checkoutTarget, checkoutTotals, countdown, formatCents, formatCredit, HELD_REPORT_COPY, lineNote, PRICE_LABEL, refusalMessage,
  type CheckoutMethod, type CheckoutResult, type CheckoutTarget, type ManaQuote, type Quote, type StudioUsage,
} from '@/lib/studio'

/** How often the page asks about a sent MANA transaction until Polygon confirms it. */
const POLL_MS = 5000
const NO_WALLET = 'Pay with MANA needs a browser wallet like MetaMask. You can pay by card.'
const CONFIRMING = 'Waiting for Polygon confirmations…'

type OrderLine = { key: string; name: string; detail: string; amountCents: number; note: string | null; struck: boolean; held: boolean }
type Order = { lines: OrderLine[]; totalCents: number; creditCents: number; dueCents: number }

/**
 * Pay with MANA, step by step: a quote, the wallet sending it, then Polygon confirming it. `quoted` is a quote the
 * wallet didn't send (an error that isn't the person saying no): send it again, or get a new price once it expires.
 */
type ManaStep =
  | { step: 'idle' }
  | { step: 'quoting' }
  | { step: 'sending'; quote: ManaQuote }
  | { step: 'quoted'; quote: ManaQuote; error: string }
  | { step: 'confirming'; quote: ManaQuote; hash: string }
  | { step: 'mismatch'; hash: string; text: string }

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

const codeOf = (err: unknown) => (err as { body?: { code?: string } })?.body?.code

export default function Checkout() {
  const { token } = useAuth()
  const api = useApi()
  const apiRef = useRef(api)
  apiRef.current = api

  const [target, setTarget] = useState<CheckoutTarget | null | undefined>(undefined)
  const [reports, setReports] = useState<Record<string, string>>({})
  const [usage, setUsage] = useState<StudioUsage | null>(null)
  const [quote, setQuote] = useState<Quote | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [wallet, setWallet] = useState<Eip1193Provider | null>(null)
  const [cardBusy, setCardBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [mana, setMana] = useState<ManaStep>({ step: 'idle' })
  const [now, setNow] = useState(() => new Date())
  // Each MANA attempt's number: a wallet answering an attempt the person has moved on from is ignored
  const attempt = useRef(0)
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
      apiRef.current.getStudioQuote(target.designId)
        .then((q) => { if (!cancelled) setQuote(q) })
        .catch((err) => { if (!cancelled) setLoadError(refusalMessage(err, new Date()).text) })
    }
    return () => { cancelled = true }
  }, [token, target])

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
  const busy = cardBusy || mana.step !== 'idle'

  if (loadError) {
    return (
      <Shell back={backHref}>
        <p className="text-sm text-amber-300" role="alert">{loadError}</p>
      </Shell>
    )
  }
  if (!order) return <Shell back={backHref}><Skeleton rows={2} /></Shell>
  if (order.lines.length === 0) {
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
    })
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
    const mine = ++attempt.current
    setError(null)
    setMana({ step: 'quoting' })
    let q: ManaQuote | null
    try {
      q = follow(await run('mana'))
    } catch (err) {
      if (mine !== attempt.current) return
      setError(refusalMessage(err as never, new Date()).text)
      setMana({ step: 'idle' })
      return
    }
    if (q && mine === attempt.current) await send(q, mine)
  }

  const send = async (q: ManaQuote, mine: number) => {
    const w = wallet ?? getBrowserWallet()
    if (!w) {
      setMana({ step: 'idle' })
      setError(NO_WALLET)
      return
    }
    setError(null)
    setMana({ step: 'sending', quote: q })
    let hash: string
    try {
      hash = await sendMana(w, q)
    } catch (err) {
      if (mine !== attempt.current) return
      if (walletRejected(err)) setMana({ step: 'idle' })
      else setMana({ step: 'quoted', quote: q, error: (err as Error)?.message || 'Your wallet didn’t send the payment. Try again.' })
      return
    }
    if (mine !== attempt.current) return
    setMana({ step: 'confirming', quote: q, hash })
    await confirm(q, hash, mine)
  }

  /** Reports the hash until Polygon has mined it, then follows the payment until it is paid. */
  const confirm = async (q: ManaQuote, hash: string, mine: number) => {
    let claimed = false
    while (alive.current && mine === attempt.current) {
      try {
        if (!claimed) {
          if ((await apiRef.current.reportStudioManaTx(q.paymentId, hash)).status === 'granted') return finish(q.paymentId)
          claimed = true
        } else if ((await apiRef.current.getStudioPayment(q.paymentId)).status === 'paid') {
          return finish(q.paymentId)
        }
      } catch (err) {
        const code = codeOf(err)
        const status = (err as { status?: number }).status ?? 0
        if (code === 'tx_failed') {
          setMana({ step: 'quoted', quote: q, error: refusalMessage(err as never, new Date()).text })
          return
        }
        // Not mined yet (tx_not_found), or the network or server hiccuped: ask again. Anything else is for support.
        if (code !== 'tx_not_found' && status >= 400 && status < 500) {
          const text = code === 'tx_used' ? refusalMessage(err as never, new Date()).text : refusalMessage({ body: { code: 'tx_mismatch' } }, new Date()).text
          setMana({ step: 'mismatch', hash, text })
          return
        }
      }
      await new Promise((r) => setTimeout(r, POLL_MS))
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
          <PrimaryButton type="button" disabled={busy} onClick={payCard}>{cardBusy ? 'Finalizing…' : 'Finalize'}</PrimaryButton>
          <p className="mt-2 text-xs text-gray-500">Nothing to pay: your credit, gifts or reports cover it.</p>
        </div>
      ) : (
        <div className={`mt-4 grid gap-4 ${manaOn ? 'sm:grid-cols-2' : ''}`}>
          <section aria-labelledby="card-title" className="rounded-lg border border-gray-800 bg-gray-900 p-4">
            <h2 id="card-title" className="text-sm font-medium">Pay by card</h2>
            <p className="mt-1 text-xs text-gray-500">Secure checkout with Stripe.</p>
            <PrimaryButton type="button" className="mt-3" disabled={busy} onClick={payCard}>
              {cardBusy ? 'Opening Stripe…' : `Pay ${formatCents(due)} by card`}
            </PrimaryButton>
          </section>
          {manaOn && (
            <section aria-labelledby="mana-title" className="rounded-lg border border-gray-800 bg-gray-900 p-4">
              <h2 id="mana-title" className="text-sm font-medium">Pay with MANA</h2>
              <p className="mt-1 text-xs text-gray-500">On Polygon, at today’s MANA price, from any wallet.</p>
              {wallet
                ? <ManaPanel mana={mana} now={now} disabled={cardBusy} onPay={payMana} onSend={(q) => send(q, attempt.current)} />
                : <p className="mt-3 text-sm text-gray-300">{NO_WALLET}</p>}
            </section>
          )}
        </div>
      )}
    </Shell>
  )
}

function ManaPanel({ mana, now, disabled, onPay, onSend }: {
  mana: ManaStep; now: Date; disabled: boolean; onPay: () => void; onSend: (q: ManaQuote) => void
}) {
  if (mana.step === 'idle' || mana.step === 'quoting') {
    return (
      <PrimaryButton type="button" className="mt-3" disabled={disabled || mana.step === 'quoting'} onClick={onPay}>
        {mana.step === 'quoting' ? 'Getting the MANA price…' : 'Pay with MANA'}
      </PrimaryButton>
    )
  }
  if (mana.step === 'mismatch') {
    return (
      <div className="mt-3 space-y-2 text-sm" role="alert">
        <p className="text-amber-300">{mana.text}</p>
        <p className="text-gray-400">Transaction: <a className="break-all text-blue-300 underline" href={`https://polygonscan.com/tx/${mana.hash}`} target="_blank" rel="noreferrer">{mana.hash}</a></p>
      </div>
    )
  }
  const q = mana.quote
  const amount = <p className="mt-3 text-2xl font-semibold text-white">{formatMana(q.amountWei)}</p>
  if (mana.step === 'confirming') {
    return (
      <div className="text-sm">
        {amount}
        <p className="mt-2 text-gray-300" role="status">{CONFIRMING}</p>
        <p className="mt-1 text-xs text-gray-500">This takes a minute or two. You can keep this page open.</p>
        <p className="mt-2 text-xs text-gray-500">Transaction: <a className="break-all text-blue-300 underline" href={`https://polygonscan.com/tx/${mana.hash}`} target="_blank" rel="noreferrer">{mana.hash}</a></p>
      </div>
    )
  }
  const expired = new Date(q.expiresAt).getTime() <= now.getTime()
  return (
    <div className="text-sm">
      {amount}
      <p className="mt-1 text-xs text-gray-500">
        {formatCents(q.usdCents)} at ${q.usdPerMana.toFixed(4)} per MANA · {expired ? 'price expired' : `price held for ${countdown(q.expiresAt, now)}`}
      </p>
      {mana.step === 'sending' && !expired && <p className="mt-2 text-gray-300" role="status">Confirm the payment in your wallet.</p>}
      {mana.step === 'quoted' && <p className="mt-2 text-amber-300" role="alert">{mana.error}</p>}
      {expired ? (
        <>
          <p className="mt-2 text-gray-300">This price has expired. {mana.step === 'sending' && 'If your wallet still shows it, reject it there. '}Get a new price to pay.</p>
          <PrimaryButton type="button" className="mt-3" disabled={disabled} onClick={onPay}>Get a new price</PrimaryButton>
        </>
      ) : mana.step === 'quoted' && (
        <PrimaryButton type="button" className="mt-3" disabled={disabled} onClick={() => onSend(q)}>Send {formatMana(q.amountWei)}</PrimaryButton>
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
