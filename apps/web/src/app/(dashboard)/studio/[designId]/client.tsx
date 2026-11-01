'use client'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useParams } from 'next/navigation'
import Link from 'next/link'
import { useApi } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { useStudioRoom } from '@/lib/colyseus'
import { Badge, PageHeader, RowMenu, Skeleton } from '@/components/ui'
import {
  designBadge, designIdFromPath, nextPoll, paymentBanner, refreshDue, refusalMessage, reloadsOn,
  type Quote, type Refusal, type Step, type StudioDetail, type StudioEvent, type StudioUsage,
} from '@/lib/studio'
import Conversation from './Conversation'
import Preview from './Preview'
import Finalize, { EmoteChecklist } from './Finalize'
import type { EmoteTarget } from './EmotesStep'
import PaidRevisions from './PaidRevisions'

/** The events kept for progress lines: enough for any one job's latest note. */
const MAX_EVENTS = 200
/** Back from Stripe: poll this often until the webhook's grant shows. */
const PAYMENT_POLL_MS = 5000

export default function StudioDesignPage() {
  const params = useParams()
  const { token } = useAuth()
  const api = useApi()
  const apiRef = useRef(api)
  apiRef.current = api

  const [designId, setDesignId] = useState<string | null>(null)
  const [missing, setMissing] = useState(false)
  const [detail, setDetail] = useState<StudioDetail | null>(null)
  const [usage, setUsage] = useState<StudioUsage | null>(null)
  const [events, setEvents] = useState<StudioEvent[]>([])
  const [notice, setNotice] = useState<Refusal | null>(null)
  const [category, setCategory] = useState<string | null>(null)
  const [step, setStep] = useState<Step>('avatar')
  const [emoteTarget, setEmoteTarget] = useState<EmoteTarget | null>(null)
  const openEmote = useCallback((t: EmoteTarget) => { setEmoteTarget(t); setStep('emotes') }, [])
  const [quote, setQuote] = useState<Quote | null>(null)
  const [payment, setPayment] = useState<{ id: string; startedAt: number } | null>(null)
  const fetchedAt = useRef(0)

  useEffect(() => {
    const id = designIdFromPath(window.location.pathname, params.designId as string | undefined)
    if (id) setDesignId(id)
    else setMissing(true)
    const paid = new URLSearchParams(window.location.search).get('payment')
    if (paid) setPayment({ id: paid, startedAt: Date.now() })
  }, [params.designId])

  /** Re-read the design (with fresh frame URLs) and the prompts left. */
  const reload = useCallback(async () => {
    if (!designId) return
    try {
      const [d, u, q] = await Promise.all([
        apiRef.current.getStudioDesign(designId),
        apiRef.current.getStudioUsage().catch(() => null),
        apiRef.current.getStudioQuote(designId).catch(() => null),
      ])
      fetchedAt.current = Date.now()
      setDetail(d)
      if (u) setUsage(u)
      setQuote(q)
    } catch (err) {
      if ((err as { status?: number }).status === 404) setMissing(true)
    }
  }, [designId])

  useEffect(() => {
    if (token && designId) reload()
  }, [token, designId, reload])

  const onEvent = useCallback((e: StudioEvent) => {
    setEvents((prev) => [...prev.slice(-(MAX_EVENTS - 1)), e])
    if (reloadsOn(e)) reload()
  }, [reload])
  const { connected } = useStudioRoom(designId, token, onEvent)

  // A reconnect may have missed a job ending: re-read
  const wasConnected = useRef(false)
  useEffect(() => {
    if (connected && !wasConnected.current && fetchedAt.current) reload()
    wasConnected.current = connected
  }, [connected, reload])

  // While a job runs, poll as a backstop to the room
  useEffect(() => {
    if (!detail) return
    const ms = nextPoll(detail, connected)
    if (ms === null) return
    const t = setTimeout(reload, ms)
    return () => clearTimeout(t)
  }, [detail, connected, reload])

  // Back from Stripe before the webhook: poll until the paid revision shows, then while it is packaged
  const banner = detail && payment ? paymentBanner(payment.id, detail, payment.startedAt, new Date()) : null
  useEffect(() => {
    if (!banner) return
    if (banner.kind === 'ready' || banner.kind === 'failed') {
      // Settled: a reload of this URL later shouldn't claim the payment is still on its way
      const url = new URL(window.location.href)
      url.searchParams.delete('payment')
      window.history.replaceState(window.history.state, '', url.pathname + url.search)
      return
    }
    const t = setTimeout(reload, banner.kind === 'slow' ? 30_000 : PAYMENT_POLL_MS)
    return () => clearTimeout(t)
  }, [banner?.kind, detail, reload])

  // Frame URLs expire: a page left open re-reads before they do
  useEffect(() => {
    const check = () => { if (fetchedAt.current && refreshDue(fetchedAt.current, Date.now())) reload() }
    const t = setInterval(check, 60_000)
    document.addEventListener('visibilitychange', check)
    return () => { clearInterval(t); document.removeEventListener('visibilitychange', check) }
  }, [reload])

  const setArchived = async (archived: boolean) => {
    if (!designId) return
    setNotice(null)
    try {
      await api.updateStudioDesign(designId, { archived })
      await reload()
    } catch (err) {
      setNotice(refusalMessage(err as never, new Date()))
    }
  }

  if (missing) {
    return (
      <div className="mx-auto max-w-7xl">
        <PageHeader crumbs={[{ label: 'Design Studio', href: '/studio' }, 'Not found']} title="Design not found" />
        <p className="text-gray-400">This design doesn’t exist or isn’t yours. <Link href="/studio" className="text-blue-300 underline">Back to your designs</Link></p>
      </div>
    )
  }
  if (!detail || !designId) return <div className="mx-auto max-w-7xl"><Skeleton rows={2} className="h-64" /></div>

  const d = detail.design
  const badge = designBadge(d)
  return (
    <div className="mx-auto max-w-7xl">
      <PageHeader
        crumbs={[{ label: 'Design Studio', href: '/studio' }, d.name]}
        title={d.name}
        subtitle={<span className="flex flex-wrap items-center gap-2">{d.kind === 'emote' ? 'Emote' : 'Wearable'} <Badge tone={badge.tone}>{badge.label}</Badge></span>}
        actions={<RowMenu label="Design actions" items={[d.archivedAt
          ? { label: 'Unarchive', onSelect: () => setArchived(false) }
          : { label: 'Archive', onSelect: () => setArchived(true), confirm: 'Archive this design?' }]} />}
      />
      {notice && (
        <p className="mb-4 text-sm text-amber-300" role="alert">
          {notice.text} {notice.action === 'settings' && <Link href="/settings" className="underline">Settings</Link>}
        </p>
      )}
      {banner && (
        <p className={`mb-4 rounded-md border px-4 py-3 text-sm ${banner.kind === 'ready' ? 'border-emerald-500/40 text-emerald-200' : banner.kind === 'failed' ? 'border-amber-500/40 text-amber-200' : 'border-blue-500/40 text-blue-200'}`} role="status">
          {banner.text}
        </p>
      )}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Conversation designId={designId} detail={detail} usage={usage} events={events} onChanged={reload} />
        <Preview designId={designId} detail={detail} category={category} onSelect={setCategory} onChanged={reload}
          step={step} onStep={setStep} emoteTarget={emoteTarget}
          finalizeStep={<div className="p-4"><EmoteChecklist designId={designId} detail={detail} onOpen={openEmote} /></div>}>
          <Finalize designId={designId} kind={d.kind} quote={quote} busy={detail.activeJob?.type === 'prompt'} onChanged={reload}
            detail={detail} onOpenEmote={openEmote} />
          <PaidRevisions designId={designId} piece={detail.pieces.find((p) => p.category === category) ?? detail.pieces[0]} onChanged={reload} />
        </Preview>
      </div>
    </div>
  )
}
