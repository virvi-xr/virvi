'use client'
// One BEAT's page (LIV-11): status, window, place, counts against the cap, attendees and the host's actions. Reached as
// /beats?id=<id> (the static export has one page for every id), which is where Stripe sends the host back.
import { Suspense, useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { useParams, useSearchParams } from 'next/navigation'
import { BEAT_RETIRED_NOTE, BEAT_SUPPLY_CAP_MAX } from '@virvixr/shared'
import { useApi } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import {
  ACTION_LABELS, ART_FAILED, ART_PENDING, CLAIM_STATUS_LABELS, COUNT_LABELS, COUNTS_NOTE, PAYMENT_POLL_MS, PAYMENT_SLOW_MS, STATUS_HELP,
  beatActions, beatsPayable, beatCounts, beatEditBody, beatFieldError, beatLocked, beatToInput, beatWindow, arcDownloadError, cancelledNote, claimRemovedNote, claimUntil, confirmBeatAction,
  formatWhen, locationLine, paymentNote, pollPayment, reviewSummary, topupKey,
  type BeatAction, type BeatAvailability, type BeatClaimant, type BeatInput, type FieldError, type PublicBeat,
} from '@/lib/beats'
import { PageHeader, Skeleton } from '@/components/ui'
import { MediaPicker } from '@/components/MediaPicker'
import { BeatBadges, BeatsGate, FrozenNote } from '@/components/beats/BeatBits'
import { BeatForm } from '@/components/beats/BeatForm'
import { BeatReview } from '@/components/beats/BeatReview'
import { Claimants } from '@/components/beats/Claimants'
import { saveBlob } from '../../studio/[designId]/PaidRevisions'
import { ARC_PRINT_COPY, ARC_STYLES, arcAvailable, type ArcStyle } from '@/lib/venue-pin'

const SLOW_POLL_MS = 30_000
const ALERT = 'rounded-md border border-red-700 bg-red-900/50 px-4 py-2 text-sm text-red-300'
const BTN = 'rounded-md bg-gray-800 px-3 py-1.5 text-sm text-gray-300 hover:bg-gray-700 disabled:opacity-50'

export default function BeatDetailPage() {
  return <Suspense fallback={<Skeleton />}><BeatsGate>{(a) => <BeatDetail availability={a} />}</BeatsGate></Suspense>
}

type Mode = { kind: 'view' } | { kind: 'edit' } | { kind: 'image' } | { kind: 'pay' } | { kind: 'raise'; cap: number | null }

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
  const titleRef = useRef<HTMLSpanElement>(null)
  const [beat, setBeat] = useState<PublicBeat | null>(null)
  const [claimants, setClaimants] = useState<BeatClaimant[]>([])
  const [claimantsError, setClaimantsError] = useState(false)
  const [sceneNames, setSceneNames] = useState<Record<string, string>>({})
  const [missing, setMissing] = useState(false)
  const [error, setError] = useState<{ message: string; reload: boolean } | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
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

  const loadClaimants = useCallback(async () => {
    if (!beatId) return
    try {
      setClaimants(await apiRef.current.getBeatClaimants(beatId))
      setClaimantsError(false)
    } catch { setClaimantsError(true) }
  }, [beatId])

  const load = useCallback(async () => {
    if (!beatId) return
    try {
      setBeat(await apiRef.current.getBeat(beatId))
    } catch (err) {
      if ((err as { status?: number }).status === 404) setMissing(true)
      else setError({ message: beatFieldError(err).message, reload: false })
      return
    }
    await loadClaimants()
  }, [beatId, loadClaimants])

  useEffect(() => { if (token) load() }, [token, load])
  // The scenes' names, for the Scenes line (a scene the host can't open shows as "A scene")
  useEffect(() => {
    if (!token) return
    apiRef.current.getScenes().then((r) => setSceneNames(Object.fromEntries((r.scenes ?? []).map((s: any) => [s.id, s.name])))).catch(() => {})
  }, [token])

  // The webhook may land after the redirect: poll until the BEAT shows paid (or the raised cap), then drop the param.
  // A failed read doesn't end the polling (pollPayment skips it and waits again).
  const note = beat && payment ? paymentNote(payment.param, beat, payment.waitCap, payment.startedAt, new Date()) : null
  const waiting = !!note && !note.settled
  useEffect(() => {
    if (!payment || !beat || waiting) return
    const url = new URL(window.location.href)
    url.searchParams.delete('payment')
    window.history.replaceState(window.history.state, '', url.pathname + url.search)
    try { sessionStorage.removeItem(topupKey(beat.id)) } catch {}
  }, [waiting, beat, payment])
  useEffect(() => {
    if (!payment || !waiting) return
    let stopped = false
    pollPayment({
      load: () => apiRef.current.getBeat(beatId),
      onBeat: (b) => setBeat(b),
      settled: (b) => { const n = paymentNote(payment.param, b, payment.waitCap, payment.startedAt, new Date()); return !n || n.settled },
      delayMs: () => (Date.now() - payment.startedAt > PAYMENT_SLOW_MS ? SLOW_POLL_MS : PAYMENT_POLL_MS),
      stopped: () => stopped,
    })
    return () => { stopped = true }
  }, [waiting, payment, beatId])

  // Focus follows the mode (plain-ux I13): the edit form's heading when it opens, the BEAT's title when back on the page
  const editHeading = useRef<HTMLHeadingElement>(null)
  const firstMode = useRef(true)
  useEffect(() => {
    if (firstMode.current) { firstMode.current = false; return }
    if (mode.kind === 'edit') editHeading.current?.focus()
    else if (mode.kind === 'view') titleRef.current?.focus()
  }, [mode.kind])

  if (missing) {
    return (
      <div className="space-y-3">
        <p className="text-sm text-gray-400">BEAT not found.</p>
        <Link href="/beats" className="text-sm text-blue-300 underline underline-offset-2">Back to your BEATs</Link>
      </div>
    )
  }
  if (!beat) return error ? <div role="alert" className={ALERT}>{error.message}</div> : <Skeleton />

  const fail = (err: unknown) => {
    const e = beatFieldError(err)
    setError({ message: e.message, reload: (err as { body?: { error?: string } })?.body?.error === 'conflict' })
  }

  const act = async (a: BeatAction) => {
    setNotice(null)
    if (a === 'edit') { setFormError(null); setMode({ kind: 'edit' }); return }
    if (a === 'change_image') { setMode({ kind: 'image' }); return }
    if (a === 'pay') { setMode({ kind: 'pay' }); return }
    if (a === 'raise_cap') { setMode({ kind: 'raise', cap: null }); return }
    const question = confirmBeatAction(a, beat)
    if (question && !window.confirm(question)) return
    setBusy(true); setError(null)
    try {
      if (a === 'cancel') {
        const wasPaid = beat.status === 'paid'
        setBeat(await api.cancelBeat(beat.id))
        setNotice(cancelledNote(beat, wasPaid))
      } else if (a === 'send') {
        const n = beat.heldClaims
        setBeat(await api.releaseBeatMints(beat.id))
        setNotice(`${n === 1 ? '1 BEAT is' : `${n} BEATs are`} on the way to the visitors' wallets.`)
        await loadClaimants()
      } else {
        setBeat(await api.endBeatEarly(beat.id))
      }
    } catch (err) { fail(err) }
    setBusy(false)
  }

  const remove = async (c: BeatClaimant) => {
    setBusy(true); setError(null); setNotice(null)
    try {
      await api.removeBeatClaim(beat.id, c.id)
      setNotice(claimRemovedNote(c))
      await load()
    } catch (err) { fail(err) }
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
  const actions = beatActions(beat, new Date(), { payable: beatsPayable(availability) })
  const back = () => { setMode({ kind: 'view' }); load() }
  const after = beat.status === 'live' || beat.status === 'ended'

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <PageHeader crumbs={[{ label: 'BEATs', href: '/beats' }, beat.name]} title={<span ref={titleRef} tabIndex={-1} className="outline-none">{beat.name}</span>}
        subtitle={<BeatBadges status={beat.status} test={beat.test} />}
        actions={mode.kind === 'view' && actions.length > 0 ? (
          <div className="flex flex-wrap gap-2">
            {actions.map((a) => (
              <button key={a} type="button" disabled={busy} onClick={() => act(a)}
                className={`rounded-md px-3 py-1.5 text-sm disabled:opacity-50 ${a === 'pay' || a === 'send' ? 'bg-blue-600 text-white hover:bg-blue-500' : 'bg-gray-800 text-gray-300 hover:bg-gray-700'}`}>
                {ACTION_LABELS[a]}
              </button>
            ))}
          </div>
        ) : undefined} />

      <p className="-mt-3 text-sm text-gray-400">{STATUS_HELP[beat.status]}</p>
      {note && <div role="status" className="rounded-md border border-gray-700 bg-gray-900 px-4 py-2 text-sm text-gray-200">{note.text}</div>}
      {notice && <div role="status" className="rounded-md border border-gray-700 bg-gray-900 px-4 py-2 text-sm text-gray-200">{notice}</div>}
      {error && (
        <div role="alert" className={`${ALERT} flex flex-wrap items-center gap-3`}>
          <span>{error.message}</span>
          {error.reload && <button type="button" className={BTN} onClick={() => window.location.reload()}>Reload</button>}
        </div>
      )}
      {beat.artStatus === 'failed' && beat.status !== 'draft' && beat.status !== 'cancelled' && <p role="alert" className={ALERT}>{ART_FAILED}</p>}
      {beat.artStatus === 'pending' && after && <p role="status" className="text-sm text-gray-400">{ART_PENDING}</p>}
      {beat.retired && <p role="note" className="rounded-md border border-gray-700 bg-gray-950 px-4 py-2 text-sm text-gray-300">{BEAT_RETIRED_NOTE}</p>}
      <FrozenNote locked={beatLocked(beat)} />

      {mode.kind === 'edit' && (
        <>
          <h2 ref={editHeading} tabIndex={-1} className="text-sm font-medium text-gray-300 outline-none">Edit BEAT</h2>
          <BeatForm initial={beatToInput(beat)} editing={beat} error={formError} busy={busy} submitLabel="Save changes" busyLabel="Saving…" onSubmit={saveEdit} onCancel={back} />
        </>
      )}
      {mode.kind === 'image' && <ChangeImage beat={beat} onSaved={(b) => { setBeat(b); setMode({ kind: 'view' }) }} onBack={back} />}
      {mode.kind === 'pay' && <BeatReview beatId={beat.id} test={beat.test || availability.test} summary={reviewSummary(beat)} onPaid={back} onBack={back} />}
      {mode.kind === 'raise' && (mode.cap === null
        ? <RaiseCap current={beat.supplyCap} onQuote={(cap) => setMode({ kind: 'raise', cap })} onBack={back} />
        : <BeatReview beatId={beat.id} test={beat.test || availability.test} raiseTo={mode.cap} onPaid={back} onBack={() => setMode({ kind: 'raise', cap: null })} />)}

      {mode.kind === 'view' && (
        <>
          <section className="grid gap-6 rounded-lg border border-gray-800 bg-gray-900 p-6 md:grid-cols-[8rem_1fr]">
            {beat.imageUrl ? <img src={beat.imageUrl} alt={`${beat.name} artwork`} className="h-32 w-32 rounded-md border border-gray-800 object-cover" /> : <div className="h-32 w-32 rounded-md border border-dashed border-gray-700" />}
            <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-[auto_1fr]">
              {beat.description && <><dt className="text-gray-400">Description</dt><dd className="whitespace-pre-wrap text-gray-200">{beat.description}</dd></>}
              <dt className="text-gray-400">When</dt><dd className="text-gray-200">{beatWindow(beat)}</dd>
              {beat.scheduledEndsAt && <><dt className="text-gray-400">Scheduled end</dt><dd className="text-gray-200">{formatWhen(beat.scheduledEndsAt, true)} (ended early)</dd></>}
              {beat.status !== 'draft' && beat.status !== 'cancelled' && (
                <><dt className="text-gray-400">Claiming</dt><dd className="text-gray-200">Visitors can claim until {formatWhen(claimUntil(beat), true)}</dd></>
              )}
              <dt className="text-gray-400">Minimum time in scene</dt><dd className="text-gray-200">{Math.round(beat.minPresentSeconds / 60)} min</dd>
              <dt className="text-gray-400">Where</dt>
              <dd className="text-gray-200">
                {locationLine(beat.location)}
                {beat.location.url && <> · <a href={beat.location.url} target="_blank" rel="noopener noreferrer" className="text-blue-300 underline underline-offset-2">Event link</a></>}
                {beat.location.mapUrl && <> · <a href={beat.location.mapUrl} target="_blank" rel="noopener noreferrer" className="text-blue-300 underline underline-offset-2">Map</a></>}
              </dd>
              <dt className="text-gray-400">Scenes</dt>
              <dd className="flex flex-wrap gap-x-3 text-gray-200">
                {beat.sceneIds.map((id) => <Link key={id} href={`/scenes?id=${encodeURIComponent(id)}`} className="text-blue-300 underline underline-offset-2">{sceneNames[id] ?? 'A scene'}</Link>)}
              </dd>
              <dt className="text-gray-400">Tradeable</dt><dd className="text-gray-200">{beat.tradeable ? 'Yes' : 'No'}</dd>
              <dt className="text-gray-400">Wallet required to claim</dt><dd className="text-gray-200">{beat.walletRequired ? 'Yes' : 'No'}</dd>
              <dt className="text-gray-400">Check claims first</dt><dd className="text-gray-200">{beat.holdMints ? 'Yes' : 'No'}</dd>
              <dt className="text-gray-400">Claim automatically</dt><dd className="text-gray-200">{beat.autoClaim ? 'Yes' : 'No'}</dd>
            </dl>
          </section>

          {beat.mintsHeldUntil && (
            <p role="status" className="rounded-md border border-blue-800 bg-blue-950/40 px-4 py-2 text-sm text-blue-100">
              {beat.heldClaims === 0 ? 'No claims are waiting for your Send.' : `${beat.heldClaims} ${beat.heldClaims === 1 ? 'claim is' : 'claims are'} waiting for your Send.`}
              {' '}Remove any you don&apos;t recognise below, then press Send claimed BEATs. Claims you haven&apos;t sent go out anyway on {formatWhen(beat.mintsHeldUntil, true)}.
            </p>
          )}

          <section aria-label="Counts" className="grid grid-cols-2 gap-3 sm:grid-cols-5">
            {([['claimed', counts.claimed], ['minting', counts.minting], ['minted', counts.minted], ['failed', counts.failed], ['cap', counts.cap]] as const).map(([k, n]) => (
              <div key={k} className="rounded-lg border border-gray-800 bg-gray-900 px-4 py-3">
                <div className="font-mono text-xs uppercase tracking-wider text-gray-400">{COUNT_LABELS[k]}</div>
                <div className="mt-1 text-2xl font-semibold text-white">{n}</div>
              </div>
            ))}
          </section>
          <p className="-mt-3 text-xs text-gray-400">{counts.used} of {counts.cap} used. {COUNTS_NOTE}</p>
          {(beat.waitingCount > 0 || beat.location.type === 'in_person') && (
            <div className="rounded-lg border border-gray-800 bg-gray-900 px-4 py-3 sm:w-max sm:min-w-[12rem]">
              <div className="font-mono text-xs uppercase tracking-wider text-gray-400">{CLAIM_STATUS_LABELS.waiting}</div>
              <div className="mt-1 text-2xl font-semibold text-white">{beat.waitingCount}</div>
            </div>
          )}

          {arcAvailable(beat) && <ArcDownload beatId={beat.id} venue={beat.location.venue ?? 'the venue'} />}

          <Claimants claimants={claimants} beat={beat} error={claimantsError} busy={busy} onRetry={loadClaimants} onRemove={remove} />
        </>
      )}
    </div>
  )
}

/** The in-person BEAT's printable ARC: the PDF in the chosen colours. */
function ArcDownload({ beatId, venue }: { beatId: string; venue: string }) {
  const api = useApi()
  const [style, setStyle] = useState<ArcStyle>('normal')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const download = async () => {
    setBusy(true); setError(null)
    try {
      const { blob, filename } = await api.downloadBeatArc(beatId, style)
      saveBlob(blob, filename)
    } catch (err) { setError(arcDownloadError(err)) }
    setBusy(false)
  }
  return (
    <section aria-labelledby="beat-arc-heading" className="space-y-3 rounded-lg border border-gray-800 bg-gray-900 p-6">
      <h2 id="beat-arc-heading" className="text-sm font-medium text-gray-300">Event ARC</h2>
      <p className="text-sm text-gray-400">{ARC_PRINT_COPY(venue)}</p>
      {error && <p role="alert" className={ALERT}>{error}</p>}
      <div className="flex flex-wrap items-end gap-3">
        <div>
          <label htmlFor="beat-arc-style" className="block text-xs text-gray-400">Style</label>
          <select id="beat-arc-style" value={style} onChange={(e) => setStyle(e.target.value as ArcStyle)}
            className="mt-1 rounded-md border border-gray-800 bg-gray-950 px-3 py-2 text-sm text-white outline-none focus:border-blue-400">
            {ARC_STYLES.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </div>
        <button type="button" disabled={busy} onClick={download} className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-50">
          {busy ? 'Preparing…' : 'Download ARC'}
        </button>
      </div>
    </section>
  )
}

/** After the start, while the art couldn't be made: pick another image (the only change allowed then). */
function ChangeImage({ beat, onSaved, onBack }: { beat: PublicBeat; onSaved: (b: PublicBeat) => void; onBack: () => void }) {
  const api = useApi()
  const heading = useRef<HTMLHeadingElement>(null)
  const [picked, setPicked] = useState<{ id: string; url: string } | null>(null)
  const [picking, setPicking] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => { heading.current?.focus() }, [])
  const save = async () => {
    if (!picked) return
    setBusy(true); setError(null)
    try { onSaved(await api.updateBeat(beat.id, { imageMediaId: picked.id })) } catch (err) { setError(beatFieldError(err).message) }
    setBusy(false)
  }
  return (
    <section className="space-y-3 rounded-lg border border-gray-800 bg-gray-900 p-6">
      <h2 ref={heading} tabIndex={-1} className="text-sm font-medium text-gray-300 outline-none">Change image</h2>
      <p className="text-sm text-gray-400">Only the image can change now. Pick a square image of at least 512 × 512.</p>
      {error && <p role="alert" className={ALERT}>{error}</p>}
      {picked && <img src={picked.url} alt="Selected artwork" className="h-24 w-24 rounded-md border border-gray-800 object-cover" />}
      <div className="flex gap-2">
        <button type="button" className={BTN} onClick={() => setPicking(true)}>{picked ? 'Pick another' : 'Pick image'}</button>
        <button type="button" disabled={!picked || busy} onClick={save} className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-50">{busy ? 'Saving…' : 'Save image'}</button>
        <button type="button" className={BTN} onClick={onBack}>Back</button>
      </div>
      {picking && <MediaPicker api={api} accept="image/png,image/jpeg,image/webp" onClose={() => setPicking(false)} onSelect={(url, asset) => { setPicked({ id: asset.id, url }); setPicking(false) }} />}
    </section>
  )
}

function RaiseCap({ current, onQuote, onBack }: { current: number; onQuote: (cap: number) => void; onBack: () => void }) {
  const [text, setText] = useState(String(current + 1))
  const heading = useRef<HTMLHeadingElement>(null)
  useEffect(() => { heading.current?.focus() }, [])
  const cap = Number(text)
  const ok = text !== '' && Number.isInteger(cap) && cap > current && cap <= BEAT_SUPPLY_CAP_MAX
  return (
    <form onSubmit={(e) => { e.preventDefault(); if (ok) onQuote(cap) }} className="space-y-3 rounded-lg border border-gray-800 bg-gray-900 p-6">
      <h2 ref={heading} tabIndex={-1} className="text-sm font-medium text-gray-300 outline-none">Raise cap</h2>
      <label htmlFor="beat-raise-cap" className="block text-xs text-gray-400">New cap (now {current})</label>
      <input id="beat-raise-cap" type="number" min={current + 1} max={BEAT_SUPPLY_CAP_MAX} value={text} onChange={(e) => setText(e.target.value)}
        aria-invalid={!ok} aria-describedby={!ok ? 'beat-raise-cap-error' : undefined}
        className="block w-32 rounded-md border border-gray-800 bg-gray-950 px-3 py-2 text-sm text-white outline-none focus:border-blue-400" />
      {!ok && <p id="beat-raise-cap-error" className="text-xs text-red-400">Pick a cap from {current + 1} to {BEAT_SUPPLY_CAP_MAX}.</p>}
      <div className="flex gap-2">
        <button type="submit" disabled={!ok} className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-50">Review</button>
        <button type="button" onClick={onBack} className={BTN}>Back</button>
      </div>
    </form>
  )
}
