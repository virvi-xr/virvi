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
import { acceptRefusal, peopleRefusal, roleLabel, splitDesigns, type MyInvite, type PastPackage } from '@/lib/studio-people'
import { saveBlob } from './[designId]/PaidRevisions'
import {
  DEFAULT_AGENT, agentLabel, categoryLabel, designBadge, giftRedeemMessage, giftRedeemSuccess, kindLabel, refusalMessage, relativeTime, usageLine,
  type Refusal, type StudioDesign, type StudioKind, type StudioUsage,
} from '@/lib/studio'

// A design page is /studio/<id>: the static export has one page for every design, which the server serves for any id,
// so these links load it in full rather than through the client router.
const designHref = (id: string) => `/studio/${id}/`

export default function StudioPage() {
  const { token, user } = useAuth()
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

  const lists = designs ? splitDesigns(designs) : null
  // A trial can't be invited or leave a design, and these routes are an account's: asking would open the sign-up sheet
  const account = !!token && !user?.trial
  return (
    <div className="mx-auto max-w-7xl">
      <PageHeader
        crumbs={['Workspace', 'Design Studio']}
        title="Design Studio"
        count={lists ? countLabel(lists.mine.length) : undefined}
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

      {account && <Invites />}

      <div className="mb-4 inline-flex rounded-md border border-gray-800 p-0.5 text-sm" role="tablist" aria-label="Which designs">
        {([['Open', false], ['Archived', true]] as const).map(([label, value]) => (
          <button key={label} role="tab" aria-selected={archived === value} onClick={() => setArchived(value)}
            className={`rounded px-3 py-1.5 ${archived === value ? 'bg-white/[0.06] text-white' : 'text-gray-400 hover:text-white'}`}>
            {label}
          </button>
        ))}
      </div>

      {!lists ? (
        <Skeleton />
      ) : lists.mine.length === 0 && lists.shared.length === 0 ? (
        archived ? (
          <p className="text-gray-500">No archived designs.</p>
        ) : (
          <EmptyState icon={<SparkleIcon size={32} />} title="No designs yet"
            body="Describe a wearable, an emote, a building or furniture, and an agent builds it for Decentraland."
            action={<PrimaryButton onClick={() => setShowCreate(true)}><PlusIcon size={16} /> New design</PrimaryButton>} />
        )
      ) : (
        <>
          {lists.mine.length > 0 ? (
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
              {lists.mine.map((d) => <DesignCard key={d.id} d={d} />)}
            </div>
          ) : (
            <p className="text-gray-500">{archived ? 'None of your own designs are archived.' : 'You have no designs of your own yet.'}</p>
          )}
          {lists.shared.length > 0 && (
            <section aria-labelledby="shared-heading" className="mt-8">
              <h2 id="shared-heading" className="mb-3 text-lg font-semibold">Shared with me</h2>
              <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
                {lists.shared.map((d) => <DesignCard key={d.id} d={d} />)}
              </div>
            </section>
          )}
        </>
      )}

      {account && !archived && <PastPackages />}
    </div>
  )
}

function DesignCard({ d }: { d: StudioDesign }) {
  const badge = designBadge(d)
  const shared = !!d.role && d.role !== 'owner'
  return (
    <a href={designHref(d.id)} className="rounded-lg border border-gray-800 bg-gray-900 p-4 text-left transition-colors hover:border-gray-600">
      <div className="flex items-center justify-between gap-3">
        <h3 className="truncate font-semibold">{d.name}</h3>
        <Badge tone={badge.tone}>{badge.label}</Badge>
      </div>
      <p className="mt-2 text-sm text-gray-400">{kindLabel(d.kind)} · {agentLabel(d.agent)}</p>
      {shared && <p className="mt-1 truncate text-sm text-gray-400">{d.ownerName?.trim() ? `${d.ownerName.trim()}’s design` : 'Shared with you'} · {roleLabel(d.role!)}</p>}
      <p className="mt-1 text-xs text-gray-600">{d.lastJobAt ? `Last worked on ${relativeTime(d.lastJobAt, new Date())}` : `Started ${relativeTime(d.createdAt, new Date())}`}</p>
    </a>
  )
}

/** "Invited to a design": the invites matched to my account, with Accept and Decline. Nothing shows without any. */
function Invites() {
  const api = useApi()
  const [invites, setInvites] = useState<MyInvite[]>([])
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<{ id: string; text: string; openDesign?: boolean } | null>(null)
  useEffect(() => {
    let cancelled = false
    api.getMyStudioInvites().then((r) => { if (!cancelled) setInvites(r) }).catch(() => {})
    return () => { cancelled = true }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const answer = async (i: MyInvite, accept: boolean) => {
    setBusy(i.id)
    setError(null)
    try {
      if (accept) {
        const r = await api.acceptStudioInvite(i.id)
        window.location.assign(designHref(r.designId))
        return
      }
      await api.declineStudioInvite(i.id)
      setInvites((prev) => prev.filter((x) => x.id !== i.id))
    } catch (err) {
      setError({ id: i.id, ...(accept ? acceptRefusal(err as never) : { text: peopleRefusal(err as never) }) })
    }
    setBusy(null)
  }

  if (invites.length === 0) return null
  return (
    <section aria-labelledby="invites-heading" className="mb-6 rounded-lg border border-blue-500/30 bg-blue-500/5 p-4">
      <h2 id="invites-heading" className="mb-3 font-semibold">Invited to a design</h2>
      <ul className="space-y-3">
        {invites.map((i) => (
          <li key={i.id} className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="truncate font-medium">{i.designName}</p>
              <p className="text-sm text-gray-400">{i.inviterName?.trim() ? `${i.inviterName.trim()} invited you` : 'You’re invited'} as a {roleLabel(i.role).toLowerCase()}.</p>
              {error?.id === i.id && (
                <p className="mt-1 text-sm text-amber-300" role="alert">
                  {error.text}{' '}
                  {error.openDesign && <a href={designHref(i.designId)} className="text-blue-300 underline">Open the design</a>}
                </p>
              )}
            </div>
            <div className="flex shrink-0 gap-2">
              <PrimaryButton type="button" disabled={busy === i.id} onClick={() => answer(i, true)}>Accept</PrimaryButton>
              <button type="button" disabled={busy === i.id} onClick={() => answer(i, false)}
                className="rounded-md bg-gray-800 px-4 py-2 text-sm hover:bg-gray-700 disabled:opacity-50">Decline</button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  )
}

/** "Finalized while you were on it": packages kept from designs I've left or was removed from. Nothing shows without any. */
function PastPackages() {
  const api = useApi()
  const [packages, setPackages] = useState<PastPackage[]>([])
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    api.getStudioPastPackages().then((r) => { if (!cancelled) setPackages(r) }).catch(() => {})
    return () => { cancelled = true }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const download = async (p: PastPackage) => {
    setBusy(p.entitlementId)
    setError(null)
    try {
      const { blob, filename } = await api.downloadStudioPastPackage(p.entitlementId)
      saveBlob(blob, filename)
    } catch (err) {
      setError(refusalMessage(err as never, new Date()).text)
    } finally {
      setBusy(null)
    }
  }

  if (packages.length === 0) return null
  return (
    <section aria-labelledby="past-heading" className="mt-8">
      <h2 id="past-heading" className="text-lg font-semibold">Finalized while you were on it</h2>
      <p className="mb-3 text-sm text-gray-400">Pieces finalized on designs you’ve left. They stay yours to download.</p>
      {error && <p className="mb-2 text-sm text-amber-300" role="alert">{error}</p>}
      <ul className="divide-y divide-gray-800 rounded-lg border border-gray-800 bg-gray-900">
        {packages.map((p) => (
          <li key={p.entitlementId} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 text-sm">
            <div className="min-w-0">
              <p className="truncate font-medium">{p.designName}</p>
              <p className="text-xs text-gray-500"><span className="capitalize">{categoryLabel(p.category)}</span> · Revision {p.revisionNumber} · finalized {new Date(p.finalizedAt).toLocaleDateString()}</p>
            </div>
            <PrimaryButton type="button" disabled={busy === p.entitlementId} onClick={() => download(p)}>Download</PrimaryButton>
          </li>
        ))}
      </ul>
    </section>
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
