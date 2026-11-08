'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { getBrowserWallet, useAuth } from '@/lib/auth'
import { useApi } from '@/lib/api'
import { Badge, ConfirmAction, PageHeader, PrimaryButton, Skeleton } from '@/components/ui'
import { formatMana, sendMana } from '@/lib/mana'
import {
  SCOPE_CATEGORY_WORDS, TX_HASH, adminActionMessage, adminManaRows, flagSummary, formatCents, readUnrecordedRefunds, writeUnrecordedRefund,
  type AdminManaRefund, type AdminMistakeReport, type AdminStudioFlag,
} from '@/lib/studio'
import AdminDesigns from './Designs'

const dateFmt = new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'short' })
const smallButton = 'rounded-md bg-gray-800 px-3 py-1.5 text-sm hover:bg-gray-700 disabled:opacity-50'
const inputClass = 'rounded-md border border-gray-800 bg-gray-950 px-3 py-1.5 text-sm'
const browserStore = () => { try { return window.localStorage } catch { return null } }
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`

type Api = ReturnType<typeof useApi>

/** One MANA-back request: Send from the owner's wallet, or Decline after typing DECLINE (no browser dialogs). */
function RefundRow({ r, api, onChanged }: { r: AdminManaRefund; api: Api; onChanged: () => Promise<void> }) {
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const [declining, setDeclining] = useState(false)
  const [typed, setTyped] = useState('')
  // A transaction that left the wallet but isn't recorded yet: kept so the owner can record it again, never send twice
  // (also kept in the browser, so a reload after sending still shows it)
  const [unrecorded, setUnrecorded] = useState<{ txHash: string; amountWei: string } | null>(null)
  useEffect(() => {
    const kept = readUnrecordedRefunds(browserStore()).find((x) => x.id === r.id)
    if (kept) setUnrecorded({ txHash: kept.txHash, amountWei: kept.amountWei })
  }, [r.id])

  const record = async (txHash: string, amountWei: string) => {
    if (!TX_HASH.test(txHash)) { setNote('That isn’t a transaction hash.'); return }
    await api.markAdminManaRefundSent(r.id, txHash, amountWei)
    writeUnrecordedRefund(browserStore(), r.id, null)
    await onChanged()
  }

  const run = async (fn: () => Promise<void>) => {
    setBusy(true)
    setNote(null)
    try { await fn() } catch (e) {
      setNote(adminActionMessage(e))
    } finally { setBusy(false) }
  }

  const send = () => run(async () => {
    const wallet = getBrowserWallet()
    if (!wallet) throw new Error('No browser wallet found. Open this page in a browser with your wallet.')
    const q = await api.getAdminManaRefundQuote(r.id)
    const hash = await sendMana(wallet, { token: q.token, recipient: q.to, amountWei: q.amountWei })
    setUnrecorded({ txHash: hash, amountWei: q.amountWei })
    writeUnrecordedRefund(browserStore(), r.id, { id: r.id, txHash: hash, amountWei: q.amountWei })
    await record(hash, q.amountWei)
  })

  return (
    <li className="rounded-lg border border-gray-800 bg-gray-900 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-medium">{r.user.email ?? r.user.id} <span className="text-sm text-gray-500">· {formatCents(r.usdCents)}</span></p>
          <p className="break-all text-sm text-gray-400">
            Wallet {r.user.wallet ?? 'none linked'} · send to {r.toAddress} · {dateFmt.format(new Date(r.createdAt))}
          </p>
        </div>
        {!unrecorded && (
          <div className="flex flex-wrap gap-2">
            <PrimaryButton type="button" disabled={busy} onClick={send}>Send MANA</PrimaryButton>
            <button type="button" disabled={busy} onClick={() => { setDeclining(!declining); setTyped('') }} className={smallButton}>Decline</button>
          </div>
        )}
      </div>
      {declining && !unrecorded && (
        <form className="mt-3 flex flex-wrap items-center gap-2 text-sm" onSubmit={(e) => { e.preventDefault(); if (typed === 'DECLINE') run(async () => { await api.declineAdminManaRefund(r.id); await onChanged() }) }}>
          <label htmlFor={`decline-${r.id}`} className="text-gray-400">Type DECLINE to keep their money as Virvi credit</label>
          <input id={`decline-${r.id}`} value={typed} onChange={(e) => setTyped(e.target.value)} className={inputClass} autoComplete="off" />
          <button type="submit" disabled={busy || typed !== 'DECLINE'} className="rounded-md bg-red-600/80 px-3 py-1.5 text-white hover:bg-red-600 disabled:opacity-50">Decline request</button>
        </form>
      )}
      {unrecorded && (
        <div className="mt-3 text-sm">
          <p className="text-amber-300">Sent {formatMana(unrecorded.amountWei)} in transaction <span className="break-all">{unrecorded.txHash}</span>, but it isn’t recorded yet. Don’t send again.</p>
          <button type="button" disabled={busy} onClick={() => run(() => record(unrecorded.txHash, unrecorded.amountWei))} className={`${smallButton} mt-2`}>Record it again</button>
        </div>
      )}
      {note && <p className="mt-2 text-sm text-red-400" role="alert">{note}</p>}
    </li>
  )
}

/** One unmatched transfer: settle it with one of its candidate payments, or record the hash it was sent back with. */
function TransferRow({ t, api, onChanged }: { t: ReturnType<typeof adminManaRows>[number]; api: Api; onChanged: () => Promise<void> }) {
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const [paymentId, setPaymentId] = useState('')
  const [returning, setReturning] = useState(false)
  const [hash, setHash] = useState('')

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true)
    setNote(null)
    try { await fn(); await onChanged() } catch (e) {
      setNote(adminActionMessage(e))
    } finally { setBusy(false) }
  }

  return (
    <li className="rounded-lg border border-gray-800 bg-gray-900 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-medium">{t.mana} <span className="text-sm text-gray-500">· from {short(t.fromAddress)}</span></p>
          <p className="break-all text-sm text-gray-400">
            <a href={t.scanUrl} target="_blank" rel="noopener noreferrer" className="underline hover:text-white">{t.txHash}</a> · {dateFmt.format(new Date(t.createdAt))}
          </p>
        </div>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2 text-sm">
        <label htmlFor={`pay-${t.key}`} className="sr-only">Payment to settle with</label>
        <select id={`pay-${t.key}`} value={paymentId} onChange={(e) => setPaymentId(e.target.value)} className={inputClass} disabled={t.candidates.length === 0}>
          <option value="">{t.candidates.length ? 'Settle with payment…' : 'No payment near this amount'}</option>
          {t.candidates.map((c) => (
            <option key={c.id} value={c.id}>
              {c.user.email ?? c.user.id} · {formatMana(c.manaAmountWei)} · {formatCents(c.amountCents)} · {c.status}
            </option>
          ))}
        </select>
        <button type="button" disabled={busy || !paymentId} onClick={() => run(() => api.settleAdminManaTransfer(t.txHash, t.logIndex, paymentId))} className={smallButton}>Settle</button>
        <button type="button" disabled={busy} onClick={() => { setReturning(!returning); setHash('') }} className={smallButton}>Mark returned</button>
      </div>
      {returning && (
        <form className="mt-3 flex flex-wrap items-center gap-2 text-sm" onSubmit={(e) => {
          e.preventDefault()
          if (!TX_HASH.test(hash.trim())) { setNote('That isn’t a transaction hash (0x and 64 hex characters).'); return }
          run(() => api.returnAdminManaTransfer(t.txHash, t.logIndex, hash.trim()))
        }}>
          <label htmlFor={`ret-${t.key}`} className="text-gray-400">Hash of the transaction that sent it back</label>
          <input id={`ret-${t.key}`} value={hash} onChange={(e) => setHash(e.target.value)} placeholder="0x…" className={`${inputClass} w-80 max-w-full`} autoComplete="off" />
          <button type="submit" disabled={busy || !hash.trim()} className={smallButton}>Save</button>
        </form>
      )}
      {note && <p className="mt-2 text-sm text-red-400" role="alert">{note}</p>}
    </li>
  )
}

/**
 * Admin: everyone's designs (open one to help as Virvi support), accounts the studio flagged for repeatedly sending work that isn't a design (dismiss, or pause their studio
 * access), and mistake reports past a piece's instant refunds (approve or decline).
 */
export default function AdminStudioPage() {
  const { user } = useAuth()
  const api = useApi()
  const [status, setStatus] = useState<'open' | 'closed'>('open')
  const [flags, setFlags] = useState<AdminStudioFlag[] | null>(null)
  const [reports, setReports] = useState<AdminMistakeReport[] | null>(null)
  const [refunds, setRefunds] = useState<AdminManaRefund[] | null>(null)
  const [transfers, setTransfers] = useState<ReturnType<typeof adminManaRows> | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  // useApi gives a new object each render, so the effect keys on the role and the tab, not on load itself
  const [flagsError, setFlagsError] = useState<string | null>(null)
  const [reportsError, setReportsError] = useState<string | null>(null)
  const [refundsError, setRefundsError] = useState<string | null>(null)
  const [transfersError, setTransfersError] = useState<string | null>(null)
  const text = (e: unknown) => (e as Error)?.message ?? 'Something went wrong'
  // Each section loads on its own, so one failing list doesn't blank the others
  const load = async () => {
    setError(null)
    await Promise.all([
      api.getAdminStudioFlags(status).then((f) => { setFlags(f.flags); setFlagsError(null) }, (e) => setFlagsError(text(e))),
      api.getAdminStudioReports().then((r) => { setReports(r.reports); setReportsError(null) }, (e) => setReportsError(text(e))),
      api.getAdminManaRefunds().then((m) => { setRefunds(m.refunds); setRefundsError(null) }, (e) => setRefundsError(text(e))),
      api.getAdminManaTransfers().then((m) => { setTransfers(adminManaRows(m.transfers)); setTransfersError(null) }, (e) => setTransfersError(text(e))),
    ])
  }

  useEffect(() => {
    if (user?.role === 'admin') load()
  }, [user?.role, status]) // eslint-disable-line react-hooks/exhaustive-deps

  if (user?.role !== 'admin') return <p className="text-gray-400">Admin access required.</p>

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true)
    setError(null)
    try {
      await fn()
      await load()
    } catch (e) {
      setError((e as Error)?.message ?? 'Something went wrong')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader
        crumbs={['System', { label: 'Admin', href: '/admin' }, 'Studio flags']}
        title="Studio flags"
        subtitle="Everyone's designs to open and help with, accounts whose studio messages keep getting turned down as work that isn't a wearable or emote, and mistake reports waiting for a decision."
        actions={<Link href="/admin/studio/gift-codes" className="rounded-md border border-gray-800 bg-gray-900 px-3 py-2 text-sm hover:border-gray-700">Gift codes</Link>}
      />
      {error && <p className="mb-4 text-sm text-red-400" role="alert">{error}</p>}

      <AdminDesigns />

      <section aria-labelledby="flags-title" className="mt-10">
        <div className="mb-3 flex items-center justify-between gap-3">
          <h2 id="flags-title" className="text-lg font-semibold">Flagged accounts</h2>
          <div className="flex gap-1 text-sm">
            {(['open', 'closed'] as const).map((s) => (
              <button key={s} type="button" onClick={() => { setFlags(null); setStatus(s) }}
                className={`rounded-md px-3 py-1.5 ${status === s ? 'bg-gray-800 text-white' : 'text-gray-400 hover:text-white'}`}>
                {s === 'open' ? 'Open' : 'Closed'}
              </button>
            ))}
          </div>
        </div>
        {flagsError && <p className="mb-3 text-sm text-red-400" role="alert">{flagsError}</p>}
        {!flags ? (flagsError ? null : <Skeleton rows={2} className="h-16" />) : flags.length === 0 ? (
          <p className="text-gray-400">{status === 'open' ? 'No account is flagged.' : 'No closed flags yet.'}</p>
        ) : (
          <ul className="space-y-3">
            {flags.map((f) => (
              <li key={f.id} className="rounded-lg border border-gray-800 bg-gray-900 p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="font-medium">{f.user.email ?? f.user.id} <span className="text-sm text-gray-500">· {f.user.plan} plan</span></p>
                    <p className="text-sm text-gray-400">{flagSummary(f)}</p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    {f.paused && <Badge tone="warning">Paused</Badge>}
                    {f.status === 'open' && (
                      <button type="button" disabled={busy} onClick={() => act(() => api.dismissAdminStudioFlag(f.id))}
                        className="rounded-md bg-gray-800 px-3 py-1.5 text-sm hover:bg-gray-700">Dismiss</button>
                    )}
                    {f.paused ? (
                      <button type="button" disabled={busy} onClick={() => act(() => api.resumeStudioUser(f.user.id))}
                        className="rounded-md bg-gray-800 px-3 py-1.5 text-sm hover:bg-gray-700">Resume studio access</button>
                    ) : (
                      <ConfirmAction prompt="Pause their studio access? They can still finalize and download." confirmLabel="Pause"
                        onConfirm={() => act(() => api.pauseStudioUser(f.user.id))} disabled={busy}
                        className="rounded-md bg-red-600/80 px-3 py-1.5 text-sm text-white hover:bg-red-600">
                        Pause studio access
                      </ConfirmAction>
                    )}
                  </div>
                </div>
                <ul className="mt-3 divide-y divide-gray-800 border-t border-gray-800 text-sm">
                  {f.events.map((e, i) => (
                    <li key={i} className="py-2">
                      <p className="text-xs text-gray-500">
                        {dateFmt.format(new Date(e.createdAt))} · {SCOPE_CATEGORY_WORDS[e.category] ?? e.category} · turned down by {e.by === 'check' ? 'the check' : 'the agent'}
                      </p>
                      <p className="whitespace-pre-wrap break-words text-gray-200">{e.message}</p>
                      {e.note && <p className="text-xs italic text-gray-400">{e.note}</p>}
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="reports-title" className="mt-10">
        <h2 id="reports-title" className="mb-3 text-lg font-semibold">Mistake reports to review</h2>
        {reportsError && <p className="mb-3 text-sm text-red-400" role="alert">{reportsError}</p>}
        {!reports ? (reportsError ? null : <Skeleton rows={1} className="h-16" />) : reports.length === 0 ? (
          <p className="text-gray-400">No report is waiting.</p>
        ) : (
          <ul className="space-y-3">
            {reports.map((r) => (
              <li key={r.id} className="rounded-lg border border-gray-800 bg-gray-900 p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="font-medium">{r.piece.name}: revision {r.revisionNumber} <span className="text-sm text-gray-500">· {formatCents(r.refundCents)}</span></p>
                    <p className="text-sm text-gray-400">{r.user.email ?? r.user.id} · {dateFmt.format(new Date(r.createdAt))}</p>
                  </div>
                  <div className="flex gap-2">
                    <PrimaryButton type="button" disabled={busy} onClick={() => act(() => api.approveAdminStudioReport(r.id))}>
                      Approve and refund
                    </PrimaryButton>
                    <button type="button" disabled={busy} onClick={() => act(() => api.declineAdminStudioReport(r.id))}
                      className="rounded-md bg-gray-800 px-3 py-1.5 text-sm hover:bg-gray-700">Decline</button>
                  </div>
                </div>
                <dl className="mt-3 grid gap-2 text-sm sm:grid-cols-2">
                  <div>
                    <dt className="text-xs text-gray-500">What the customer says went wrong</dt>
                    <dd className="whitespace-pre-wrap break-words text-gray-200">{r.text}</dd>
                  </div>
                  <div>
                    <dt className="text-xs text-gray-500">What the revision was asked to do</dt>
                    <dd className="whitespace-pre-wrap break-words text-gray-200">{r.request || '—'}</dd>
                  </div>
                </dl>
                {(r.before || r.after) && (
                  <div className="mt-3 flex flex-wrap gap-3">
                    {([['Before', r.before], ['After', r.after]] as const).map(([label, src]) => (
                      <figure key={label} className="w-40">
                        {src ? <img src={src} alt={`${label}: ${r.piece.name}`} className="aspect-square w-full rounded-md bg-gray-950 object-contain" />
                          : <div className="flex aspect-square w-full items-center justify-center rounded-md bg-gray-950 text-xs text-gray-500">No render</div>}
                        <figcaption className="mt-1 text-xs text-gray-500">{label}</figcaption>
                      </figure>
                    ))}
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="mana-refunds-title" className="mt-10">
        <h2 id="mana-refunds-title" className="mb-3 text-lg font-semibold">MANA refunds to send</h2>
        {refundsError && <p className="mb-3 text-sm text-red-400" role="alert">{refundsError}</p>}
        {!refunds ? (refundsError ? null : <Skeleton rows={1} className="h-16" />) : refunds.length === 0 ? (
          <p className="text-gray-400">No one is waiting for MANA back.</p>
        ) : (
          <ul className="space-y-3">
            {refunds.map((r) => <RefundRow key={r.id} r={r} api={api} onChanged={load} />)}
          </ul>
        )}
      </section>

      <section aria-labelledby="mana-transfers-title" className="mt-10">
        <h2 id="mana-transfers-title" className="mb-3 text-lg font-semibold">MANA payments that didn’t match</h2>
        {transfersError && <p className="mb-3 text-sm text-red-400" role="alert">{transfersError}</p>}
        {!transfers ? (transfersError ? null : <Skeleton rows={1} className="h-16" />) : transfers.length === 0 ? (
          <p className="text-gray-400">Every MANA payment has matched an order.</p>
        ) : (
          <ul className="space-y-3">
            {transfers.map((t) => <TransferRow key={t.key} t={t} api={api} onChanged={load} />)}
          </ul>
        )}
      </section>
    </div>
  )
}
