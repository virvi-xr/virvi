'use client'
import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useApi } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { Badge, EmptyState, PageHeader, PrimaryButton, Skeleton } from '@/components/ui'
import { PlusIcon, SparkleIcon } from '@/components/icons'
import { countLabel } from '@/lib/format'
import { AgentPicker } from './AgentPicker'
import { startingAgent } from '@/lib/studio-ratings'
import { KindPicker } from '@/components/KindPicker'
import {
  DEFAULT_AGENT, agentLabel, designBadge, giftRedeemMessage, giftRedeemSuccess, kindLabel, refusalMessage, relativeTime, usageLine,
  type Refusal, type StudioDesign, type StudioKind, type StudioUsage,
} from '@/lib/studio'

// A design page is /studio/<id>: the static export has one page for every design, which the server serves for any id,
// so these links load it in full rather than through the client router.
const designHref = (id: string) => `/studio/${id}/`

export default function StudioPage() {
  const { token } = useAuth()
  const api = useApi()
  const [archived, setArchived] = useState(false)
  const [designs, setDesigns] = useState<StudioDesign[] | null>(null)
  const [usage, setUsage] = useState<StudioUsage | null>(null)
  const [showCreate, setShowCreate] = useState(false)
  const [showRedeem, setShowRedeem] = useState(false)

  // Back from buying prompts (?payment=): the webhook adds them, so re-read usage a few times
  const [toppedUp, setToppedUp] = useState(false)
  useEffect(() => {
    if (!token) return
    api.getStudioUsage().then(setUsage).catch(() => {})
    if (!new URLSearchParams(window.location.search).get('payment')) return
    setToppedUp(true)
    const timers = [5000, 15000, 45000].map((ms) => setTimeout(() => api.getStudioUsage().then(setUsage).catch(() => {}), ms))
    return () => timers.forEach(clearTimeout)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token])

  useEffect(() => {
    if (!token) return
    let cancelled = false
    setDesigns(null)
    api.getStudioDesigns(archived)
      .then((d) => { if (!cancelled) setDesigns(d) })
      .catch(() => { if (!cancelled) setDesigns([]) })
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, archived])

  return (
    <div className="mx-auto max-w-7xl">
      <PageHeader
        crumbs={['Workspace', 'Design Studio']}
        title="Design Studio"
        count={designs ? countLabel(designs.length) : undefined}
        subtitle={usage ? usageLine(usage) : 'Design Decentraland wearables, emotes, buildings and furniture with an agent.'}
        actions={
          <div className="flex items-center gap-2">
            <button type="button" onClick={() => setShowRedeem((v) => !v)} aria-expanded={showRedeem}
              className="rounded-md border border-gray-800 bg-gray-900 px-3 py-2 text-sm hover:border-gray-700">Have a code?</button>
            <PrimaryButton onClick={() => setShowCreate((v) => !v)}><PlusIcon size={16} /> New design</PrimaryButton>
          </div>
        }
      />

      {toppedUp && (
        <p className="mb-4 rounded-md border border-emerald-500/40 px-4 py-3 text-sm text-emerald-200" role="status">
          Payment received. Your prompts show up here in a moment.
        </p>
      )}

      {showRedeem && <RedeemCode onRedeemed={() => api.getStudioUsage().then(setUsage).catch(() => {})} onClose={() => setShowRedeem(false)} />}

      {showCreate && <NewDesign onCancel={() => setShowCreate(false)} />}

      <div className="mb-4 inline-flex rounded-md border border-gray-800 p-0.5 text-sm" role="tablist" aria-label="Which designs">
        {([['Open', false], ['Archived', true]] as const).map(([label, value]) => (
          <button key={label} role="tab" aria-selected={archived === value} onClick={() => setArchived(value)}
            className={`rounded px-3 py-1.5 ${archived === value ? 'bg-white/[0.06] text-white' : 'text-gray-400 hover:text-white'}`}>
            {label}
          </button>
        ))}
      </div>

      {!designs ? (
        <Skeleton />
      ) : designs.length === 0 ? (
        archived ? (
          <p className="text-gray-500">No archived designs.</p>
        ) : (
          <EmptyState icon={<SparkleIcon size={32} />} title="No designs yet"
            body="Describe a wearable, an emote, a building or furniture, and an agent builds it for Decentraland."
            action={<PrimaryButton onClick={() => setShowCreate(true)}><PlusIcon size={16} /> New design</PrimaryButton>} />
        )
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
          {designs.map((d) => <DesignCard key={d.id} d={d} />)}
        </div>
      )}
    </div>
  )
}

function DesignCard({ d }: { d: StudioDesign }) {
  const badge = designBadge(d)
  return (
    <a href={designHref(d.id)} className="rounded-lg border border-gray-800 bg-gray-900 p-4 text-left transition-colors hover:border-gray-600">
      <div className="flex items-center justify-between gap-3">
        <h3 className="truncate font-semibold">{d.name}</h3>
        <Badge tone={badge.tone}>{badge.label}</Badge>
      </div>
      <p className="mt-2 text-sm text-gray-400">{kindLabel(d.kind)} · {agentLabel(d.agent)}</p>
      <p className="mt-1 text-xs text-gray-600">{d.lastJobAt ? `Last worked on ${relativeTime(d.lastJobAt, new Date())}` : `Started ${relativeTime(d.createdAt, new Date())}`}</p>
    </a>
  )
}

function RedeemCode({ onRedeemed, onClose }: { onRedeemed: () => void; onClose: () => void }) {
  const api = useApi()
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null)

  const redeem = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!code.trim()) return
    setBusy(true)
    setResult(null)
    try {
      const r = await api.redeemGiftCode(code.trim())
      setResult({ ok: true, text: giftRedeemSuccess(r) })
      setCode('')
      onRedeemed()
    } catch (err) {
      setResult({ ok: false, text: giftRedeemMessage(err as never) })
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={redeem} className="mb-6 space-y-3 rounded-lg border border-gray-800 bg-gray-900 p-4">
      <label className="block">
        <span className="mb-2 block text-sm text-gray-400">Gift code</span>
        <input type="text" value={code} onChange={(e) => setCode(e.target.value)} maxLength={64} autoComplete="off" spellCheck={false}
          className="w-full max-w-md rounded-md border border-gray-800 bg-gray-950 px-4 py-2 font-mono text-white outline-none focus:border-blue-400" />
      </label>
      {result && <p className={`text-sm ${result.ok ? 'text-emerald-300' : 'text-amber-300'}`} role={result.ok ? 'status' : 'alert'}>{result.text}</p>}
      <div className="flex gap-2">
        <PrimaryButton type="submit" disabled={busy || !code.trim()}>{busy ? 'Redeeming…' : 'Redeem'}</PrimaryButton>
        <button type="button" onClick={onClose} className="rounded-md bg-gray-800 px-4 py-2 text-sm hover:bg-gray-700">Close</button>
      </div>
    </form>
  )
}

function NewDesign({ onCancel }: { onCancel: () => void }) {
  const api = useApi()
  const [kind, setKind] = useState<StudioKind>('wearable')
  const [agent, setAgent] = useState<string>(DEFAULT_AGENT)
  // The admin's default agent for each kind (LIV-142), until the person picks one themselves
  const [defaults, setDefaults] = useState<Partial<Record<StudioKind, string | null>> | null>(null)
  const [picked, setPicked] = useState(false)
  useEffect(() => {
    let cancelled = false
    api.getStudioDefaults().then((r) => { if (!cancelled) setDefaults(r.agents) }).catch(() => {})
    return () => { cancelled = true }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!picked) setAgent(startingAgent(kind, defaults, DEFAULT_AGENT))
  }, [kind, defaults, picked])
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [refusal, setRefusal] = useState<Refusal | null>(null)

  const create = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setRefusal(null)
    try {
      const d = await api.createStudioDesign({ kind, agent, ...(name.trim() ? { name: name.trim() } : {}) })
      window.location.assign(designHref(d.id))
    } catch (err) {
      setRefusal(refusalMessage(err as never, new Date()))
      setBusy(false)
    }
  }

  return (
    <form onSubmit={create} className="mb-6 space-y-4 rounded-lg border border-gray-800 bg-gray-900 p-4">
      <fieldset>
        <legend className="mb-2 text-sm text-gray-400">What are you making?</legend>
        <KindPicker value={kind} onChange={setKind} />
      </fieldset>
      <fieldset>
        <legend className="mb-2 text-sm text-gray-400">Who builds it?</legend>
        <AgentPicker name="new-agent" value={agent} onChange={(a) => { setPicked(true); setAgent(a) }} />
      </fieldset>
      <label className="block">
        <span className="mb-2 block text-sm text-gray-400">Name (optional)</span>
        <input type="text" value={name} onChange={(e) => setName(e.target.value)} maxLength={120}
          placeholder={kind === 'emote' ? 'Untitled emote' : kind === 'scene' ? 'Untitled scene piece' : 'Untitled design'}
          className="w-full max-w-md rounded-md border border-gray-800 bg-gray-950 px-4 py-2 text-white outline-none focus:border-blue-400" />
      </label>
      {refusal && (
        <p className="text-sm text-amber-300" role="alert">
          {refusal.text}{' '}
          {refusal.action === 'settings' && <Link href="/settings" className="underline">Settings</Link>}
        </p>
      )}
      <div className="flex gap-2">
        <PrimaryButton type="submit" disabled={busy}>{busy ? 'Creating…' : 'Create'}</PrimaryButton>
        <button type="button" onClick={onCancel} className="rounded-md bg-gray-800 px-4 py-2 text-sm hover:bg-gray-700">Cancel</button>
      </div>
    </form>
  )
}
