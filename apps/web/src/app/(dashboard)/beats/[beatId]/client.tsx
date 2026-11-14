'use client'
// One BEAT's page (LIV-11): status, window, counts against the cap, claimants and the host's actions. Reached as
// /beats?id=<id> (the static export has one page for every id), which is where Stripe sends the host back.
import { Suspense, useCallback, useEffect, useRef, useState } from 'react'
import { useParams, useSearchParams } from 'next/navigation'
import { BEAT_SUPPLY_CAP_MAX } from '@virvixr/shared'
import { useApi } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import {
  ACTION_LABELS, BEAT_FROZEN_NOTE, PAYMENT_POLL_MS, beatActions, beatCounts, beatEditBody, beatFieldError, beatToInput, beatWindow, confirmBeatAction,
  paymentNote, topupKey, type BeatAction, type BeatAvailability, type BeatClaimant, type BeatInput, type FieldError, type PublicBeat,
} from '@/lib/beats'
import { PageHeader, Skeleton } from '@/components/ui'
import { BeatBadges, BeatsGate } from '@/components/beats/BeatBits'
import { BeatForm } from '@/components/beats/BeatForm'
import { BeatReview } from '@/components/beats/BeatReview'
import { Claimants } from '@/components/beats/Claimants'

const SLOW_POLL_MS = 30_000

export default function BeatDetailPage() {
  return <Suspense fallback={<Skeleton />}><BeatsGate>{(a) => <BeatDetail availability={a} />}</BeatsGate></Suspense>
}

type Mode = { kind: 'view' } | { kind: 'edit' } | { kind: 'pay' } | { kind: 'raise'; cap: number | null }

function readTopup(beatId: string): number | null {
  try {
    const v = Number(sessionStorage.getItem(topupKey(beatId)))
    return Number.isInteger(v) && v > 0 ? v : null
  } catch { return null }
}

function BeatDetail({ availability }: { availability: BeatAvailability }) {
  const params = useParams()
  const searchParams = useSearchParams()
  const beatId = (searchParams.get('id') || params.beatId) as string
  const { token } = useAuth()
  const api = useApi()
  const apiRef = useRef(api)
  apiRef.current = api
  const [beat, setBeat] = useState<PublicBeat | null>(null)
  const [claimants, setClaimants] = useState<BeatClaimant[]>([])
  const [missing, setMissing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [formError, setFormError] = useState<FieldError | null>(null)
  const [busy, setBusy] = useState(false)
  const [mode, setMode] = useState<Mode>({ kind: 'view' })
  // Back from Stripe: the payment param, when it came, and the cap a raise waits for
  const [payment, setPayment] = useState<{ param: string; startedAt: number; waitCap: number | null } | null>(null)

  useEffect(() => {
    const param = searchParams.get('payment')
    if (param && beatId) setPayment({ param, startedAt: Date.now(), waitCap: readTopup(beatId) })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [beatId])

  const load = useCallback(async () => {
    if (!beatId) return
    try {
      const [b, c] = await Promise.all([apiRef.current.getBeat(beatId), apiRef.current.getBeatClaimants(beatId).catch(() => null)])
      setBeat(b)
      if (c) setClaimants(c)
    } catch (err) {
      if ((err as { status?: number }).status === 404) setMissing(true)
      else setError(beatFieldError(err).message)
    }
  }, [beatId])

  useEffect(() => { if (token) load() }, [token, load])

  // The webhook may land after the redirect: poll until the BEAT shows paid (or the raised cap), then drop the param
  const note = beat && payment ? paymentNote(payment.param, beat, payment.waitCap, payment.startedAt, new Date()) : null
  useEffect(() => {
    if (!payment || !beat) return
    if (!note || note.settled) {
      const url = new URL(window.location.href)
      url.searchParams.delete('payment')
      window.history.replaceState(window.history.state, '', url.pathname + url.search)
      try { sessionStorage.removeItem(topupKey(beat.id)) } catch {}
      return
    }
    const slow = Date.now() - payment.startedAt > 2 * 60_000
    const t = setTimeout(load, slow ? SLOW_POLL_MS : PAYMENT_POLL_MS)
    return () => clearTimeout(t)
  }, [note?.settled, note?.text, beat, payment, load])

  if (missing) return <p className="text-sm text-gray-400">BEAT not found.</p>
  if (!beat) return error ? <div role="alert" className="rounded-md border border-red-700 bg-red-900/50 px-4 py-2 text-sm text-red-300">{error}</div> : <Skeleton />

  const act = async (a: BeatAction) => {
    if (a === 'edit') { setFormError(null); setMode({ kind: 'edit' }); return }
    if (a === 'pay') { setMode({ kind: 'pay' }); return }
    if (a === 'raise_cap') { setMode({ kind: 'raise', cap: null }); return }
    const question = confirmBeatAction(a)
    if (question && !window.confirm(question)) return
    setBusy(true); setError(null)
    try {
      setBeat(a === 'cancel' ? await api.cancelBeat(beat.id) : await api.endBeatEarly(beat.id))
    } catch (err) { setError(beatFieldError(err).message) }
    setBusy(false)
  }

  const saveEdit = async (f: BeatInput) => {
    setBusy(true); setFormError(null)
    try {
      setBeat(await api.updateBeat(beat.id, beatEditBody(f, beat.status)))
      setMode({ kind: 'view' })
    } catch (err) { setFormError(beatFieldError(err)) }
    setBusy(false)
  }

  const counts = beatCounts(beat)
  const actions = beatActions(beat, new Date())
  const back = () => { setMode({ kind: 'view' }); load() }

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <PageHeader crumbs={[{ label: 'BEATs', href: '/beats' }, beat.name]} title={beat.name}
        subtitle={<BeatBadges status={beat.status} test={beat.test} />}
        actions={mode.kind === 'view' && actions.length > 0 ? (
          <div className="flex flex-wrap gap-2">
            {actions.map((a) => (
              <button key={a} type="button" disabled={busy} onClick={() => act(a)}
                className={`rounded-md px-3 py-1.5 text-sm disabled:opacity-50 ${a === 'pay' ? 'bg-blue-600 text-white hover:bg-blue-500' : 'bg-gray-800 text-gray-300 hover:bg-gray-700'}`}>
                {ACTION_LABELS[a]}
              </button>
            ))}
          </div>
        ) : undefined} />

      {note && <div role="status" className="rounded-md border border-gray-700 bg-gray-900 px-4 py-2 text-sm text-gray-200">{note.text}</div>}
      {error && <div role="alert" className="rounded-md border border-red-700 bg-red-900/50 px-4 py-2 text-sm text-red-300">{error}</div>}
      {beat.frozen && <p className="text-sm text-gray-400">{BEAT_FROZEN_NOTE}</p>}

      {mode.kind === 'edit' && (
        <BeatForm initial={beatToInput(beat)} editing={beat} error={formError} busy={busy} submitLabel="Save changes" onSubmit={saveEdit} onCancel={back} />
      )}
      {mode.kind === 'pay' && <BeatReview beatId={beat.id} test={beat.test || availability.test} onPaid={back} onBack={back} />}
      {mode.kind === 'raise' && (mode.cap === null
        ? <RaiseCap current={beat.supplyCap} onQuote={(cap) => setMode({ kind: 'raise', cap })} onBack={back} />
        : <BeatReview beatId={beat.id} test={beat.test || availability.test} raiseTo={mode.cap} onPaid={back} onBack={() => setMode({ kind: 'raise', cap: null })} />)}

      {mode.kind === 'view' && (
        <>
          <section className="grid gap-6 rounded-lg border border-gray-800 bg-gray-900 p-6 md:grid-cols-[8rem_1fr]">
            {beat.imageUrl ? <img src={beat.imageUrl} alt="" className="h-32 w-32 rounded-md border border-gray-800 object-cover" /> : <div className="h-32 w-32 rounded-md border border-dashed border-gray-700" />}
            <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-[auto_1fr]">
              {beat.description && <><dt className="text-gray-500">Description</dt><dd className="whitespace-pre-wrap text-gray-200">{beat.description}</dd></>}
              <dt className="text-gray-500">Window</dt><dd className="text-gray-200">{beatWindow(beat)}</dd>
              <dt className="text-gray-500">Minimum time</dt><dd className="text-gray-200">{Math.round(beat.minPresentSeconds / 60)} min</dd>
              <dt className="text-gray-500">Scenes</dt><dd className="text-gray-200">{beat.sceneIds.length}</dd>
              <dt className="text-gray-500">Tradeable</dt><dd className="text-gray-200">{beat.tradeable ? 'Yes' : 'No'}</dd>
            </dl>
          </section>

          <section aria-label="Counts" className="grid grid-cols-2 gap-3 sm:grid-cols-5">
            {([['Claimed', counts.claimed], ['Minting', counts.minting], ['Minted', counts.minted], ['Failed', counts.failed], ['Cap', counts.cap]] as const).map(([label, n]) => (
              <div key={label} className="rounded-lg border border-gray-800 bg-gray-900 px-4 py-3">
                <div className="font-mono text-xs uppercase tracking-wider text-gray-500">{label}</div>
                <div className="mt-1 text-2xl font-semibold text-white">{n}</div>
              </div>
            ))}
          </section>
          <p className="-mt-3 text-xs text-gray-500">{counts.used} of {counts.cap} used</p>

          <Claimants claimants={claimants} />
        </>
      )}
    </div>
  )
}

function RaiseCap({ current, onQuote, onBack }: { current: number; onQuote: (cap: number) => void; onBack: () => void }) {
  const [cap, setCap] = useState(current + 1)
  const ok = Number.isInteger(cap) && cap > current && cap <= BEAT_SUPPLY_CAP_MAX
  return (
    <form onSubmit={(e) => { e.preventDefault(); if (ok) onQuote(cap) }} className="space-y-3 rounded-lg border border-gray-800 bg-gray-900 p-6">
      <h2 className="text-sm font-medium text-gray-300">Raise cap</h2>
      <label className="block text-xs text-gray-400">New cap (now {current})
        <input type="number" min={current + 1} max={BEAT_SUPPLY_CAP_MAX} value={cap} onChange={(e) => setCap(Number(e.target.value))}
          className="mt-1 block w-32 rounded-md border border-gray-800 bg-gray-950 px-3 py-2 text-sm text-white outline-none focus:border-blue-400" />
      </label>
      {!ok && <p className="text-xs text-red-400">Pick a cap from {current + 1} to {BEAT_SUPPLY_CAP_MAX}.</p>}
      <div className="flex gap-2">
        <button type="submit" disabled={!ok} className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-50">Review</button>
        <button type="button" onClick={onBack} className="rounded-md bg-gray-800 px-4 py-2 text-sm text-gray-300 hover:bg-gray-700">Back</button>
      </div>
    </form>
  )
}
