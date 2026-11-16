'use client'
// Settings: "Move my BEATs to a new wallet" (LIV-11). The person asks Virvi to send their BEATs again to a new, linked
// wallet when the old one was lost or stolen; a Virvi admin reviews it. Shown only while BEATs are on.
import { useCallback, useEffect, useState } from 'react'
import { useApi } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { useBeatAvailability } from '@/lib/use-beats'
import { Badge, ConfirmAction, Skeleton } from '@/components/ui'
import {
  APPROVED_NOTE, BEAT_REISSUE_REASON_MAX, MOVE_INTRO, MOVE_TITLE, MOVE_WHAT_HAPPENS, REISSUE_STATUS_LABELS, chainLabel, isOpen, itemStateLabel, moveError, moveFormError,
  type ReissueRequest,
} from '@/lib/reissue'

const INPUT = 'mt-1 w-full rounded-md border border-gray-800 bg-gray-950 px-3 py-2 text-sm text-white outline-none focus:border-blue-400'
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : null)

export function MoveBeats() {
  const availability = useBeatAvailability()
  return availability?.enabled ? <MoveBeatsCard /> : null
}

function MoveBeatsCard() {
  const { token } = useAuth()
  const api = useApi()
  const [requests, setRequests] = useState<ReissueRequest[] | null>(null)
  const [wallets, setWallets] = useState<string[]>([])
  const [loadError, setLoadError] = useState(false)
  const [form, setForm] = useState({ oldWallet: '', newWallet: '', reason: '' })
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    try {
      const [r, w] = await Promise.all([api.listMyReissueRequests(), api.getWallets()])
      setRequests(r)
      setWallets(w.wallets.map((x) => x.address.toLowerCase()))
      setLoadError(false)
    } catch { setLoadError(true) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token])
  useEffect(() => { load() }, [load])

  const open = requests?.find(isOpen) ?? null
  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    const why = moveFormError(form)
    if (why) { setError(why); return }
    setBusy(true); setError(null)
    try {
      await api.createReissueRequest({ oldWallet: form.oldWallet.trim(), newWallet: form.newWallet.trim(), reason: form.reason.trim() })
      setForm({ oldWallet: '', newWallet: '', reason: '' })
      await load()
    } catch (err) { setError(moveError(err)) }
    setBusy(false)
  }
  const cancel = async (r: ReissueRequest) => {
    setBusy(true); setError(null)
    try { await api.cancelReissueRequest(r.id); await load() } catch (err) { setError(moveError(err)) }
    setBusy(false)
  }

  return (
    <div className="rounded-lg border border-gray-800 bg-gray-900 p-6">
      <h3 className="mb-1 text-sm font-medium text-gray-300">{MOVE_TITLE}</h3>
      <div className="mb-3 space-y-1 text-xs text-gray-400">{MOVE_INTRO.map((p) => <p key={p}>{p}</p>)}</div>
      <details className="mb-3 text-xs text-gray-400">
        <summary className="cursor-pointer text-gray-300">What happens when you ask</summary>
        <ul className="mt-1 list-disc space-y-1 pl-5">{MOVE_WHAT_HAPPENS.map((p) => <li key={p}>{p}</li>)}</ul>
      </details>
      {error && <div role="alert" className="mb-3 rounded-md border border-red-700 bg-red-900/50 px-4 py-2 text-sm text-red-300">{error}</div>}
      {loadError ? (
        <div className="flex items-center gap-3">
          <p role="alert" className="text-sm text-red-300">We couldn&apos;t load your requests.</p>
          <button type="button" onClick={load} className="rounded-md bg-gray-800 px-3 py-1.5 text-sm text-gray-300 hover:bg-gray-700">Try again</button>
        </div>
      ) : requests === null ? <Skeleton rows={2} className="h-10" /> : (
        <>
          {!open && (
            <form onSubmit={submit} noValidate className="space-y-3">
              <div>
                <label htmlFor="move-old" className="block text-xs text-gray-400">Old wallet (the lost or stolen one)</label>
                <input id="move-old" className={`${INPUT} font-mono`} placeholder="0x…" value={form.oldWallet} onChange={(e) => setForm({ ...form, oldWallet: e.target.value })} />
              </div>
              <div>
                <label htmlFor="move-new" className="block text-xs text-gray-400">New wallet (already linked above)</label>
                <select id="move-new" className={`${INPUT} font-mono`} value={form.newWallet} onChange={(e) => setForm({ ...form, newWallet: e.target.value })}>
                  <option value="">Pick a linked wallet</option>
                  {wallets.filter((w) => w !== form.oldWallet.trim().toLowerCase()).map((w) => <option key={w} value={w}>{w}</option>)}
                </select>
                {wallets.length < 2 && <p className="mt-1 text-xs text-gray-400">Link your new wallet under Linked Wallets first.</p>}
              </div>
              <div>
                <label htmlFor="move-reason" className="block text-xs text-gray-400">What happened to the old wallet?</label>
                <textarea id="move-reason" rows={3} maxLength={BEAT_REISSUE_REASON_MAX} className={INPUT} value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} />
              </div>
              <button type="submit" disabled={busy} className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50">{busy ? 'Sending…' : 'Ask to move my BEATs'}</button>
            </form>
          )}
          {requests.length > 0 && (
            <ul className="mt-4 space-y-3">
              {requests.map((r) => (
                <li key={r.id} className="rounded-md border border-gray-800 p-3 text-sm">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-mono text-xs text-gray-300">{r.oldWallet} → {r.newWallet}</span>
                    <Badge tone={r.status === 'done' ? 'success' : r.status === 'rejected' || r.status === 'withdrawn' || r.status === 'cancelled' ? 'neutral' : 'info'}>{REISSUE_STATUS_LABELS[r.status]}</Badge>
                  </div>
                  <p className="mt-1 text-xs text-gray-400">
                    Asked {when(r.createdAt)}{r.reviewedAt ? ` · reviewed ${when(r.reviewedAt)}` : ''}{r.doneAt ? ` · done ${when(r.doneAt)}` : ''}{r.cancelledAt ? ` · cancelled ${when(r.cancelledAt)}` : ''}{r.withdrawnAt ? ` · withdrawn ${when(r.withdrawnAt)}` : ''}
                  </p>
                  {r.reviewNote && <p className="mt-1 text-gray-200">Note from Virvi: {r.reviewNote}</p>}
                  {(r.status === 'approved' || r.status === 'proposed' || r.status === 'done') && <p className="mt-1 text-gray-300">{APPROVED_NOTE}</p>}
                  {r.beats.length > 0 && (
                    <ul className="mt-2 space-y-0.5 text-xs text-gray-300">
                      {r.beats.map((b) => <li key={`${b.chain}-${b.tokenId}`}>{b.name} ({chainLabel(b.chain)}{b.tradeable ? ', tradeable' : ''}): {itemStateLabel(b.state)}</li>)}
                    </ul>
                  )}
                  {r.status === 'pending' && (
                    <div className="mt-2">
                      <ConfirmAction prompt="Cancel this request?" confirmLabel="Cancel request" disabled={busy}
                        className="rounded-md border border-gray-700 px-3 py-1.5 text-xs hover:border-gray-500 disabled:opacity-50" onConfirm={() => cancel(r)}>
                        Cancel request
                      </ConfirmAction>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  )
}
