'use client'
import { useCallback, useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useApi, useDemoPrefix } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { fromLocalInput, toLocalInput } from '@/lib/beats'
import {
  TEST_BADGE, dropsError, giveawayAddressUrl, giveawayStatus, mintStep, notReadyLines, type HostGiveaway,
} from '@/lib/drops'
import { Badge, ConfirmAction, PageHeader, Skeleton } from '@/components/ui'
import { ItemPicker } from './ItemPicker'
import { FundingCard } from './FundingCard'
import { ClaimsTable } from './ClaimsTable'

const card = 'rounded-lg border border-gray-800 bg-gray-900 p-4'
const input = 'rounded-md border border-gray-800 bg-gray-950 px-3 py-2 text-sm text-white outline-none focus:border-blue-400'

/** One giveaway, in the order a host sets it up: status, wallet, items, funding, rules, scenes, claims, delete. */
export function GiveawayDetail({ id }: { id: string }) {
  const { token } = useAuth()
  const api = useApi()
  const prefix = useDemoPrefix()
  const router = useRouter()
  const [g, setG] = useState<HostGiveaway | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [statusError, setStatusError] = useState<{ message: string; items: string[] } | null>(null)
  const [switching, setSwitching] = useState(false)
  const [checking, setChecking] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)

  const load = useCallback(() => api.getGiveaway(id).then(setG), [api, id])
  useEffect(() => {
    if (!token) return
    load().catch((err) => setLoadError(dropsError(err)))
  }, [token, load])

  if (loadError && !g) return <p role="alert" className="text-red-400">{loadError}</p>
  if (!g) return <Skeleton />

  const deleting = g.deleteState === 'returning'
  const status = giveawayStatus(g, Date.now())

  const toggle = async () => {
    setSwitching(true)
    setStatusError(null)
    try {
      setG(await api.updateGiveaway(id, { enabled: !g.enabled }))
    } catch (err) {
      setStatusError({ message: dropsError(err), items: notReadyLines(err, g.items, g.walletAddress) })
    }
    setSwitching(false)
  }

  const checkAgain = async () => {
    setChecking(true)
    try {
      await load()
    } catch (err) {
      setStatusError({ message: dropsError(err), items: [] })
    }
    setChecking(false)
  }

  const remove = async () => {
    setDeleteError(null)
    try {
      await api.deleteGiveaway(id)
      router.push(`${prefix}/drops`)
    } catch (err) {
      setDeleteError(dropsError(err))
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        crumbs={['Workspace', { label: 'Drops', href: `${prefix}/drops` }, g.name]}
        title={g.name}
        subtitle={g.chain === 'polygon-amoy' ? <Badge tone="violet">{TEST_BADGE}</Badge> : undefined}
      />

      {/* 1. Status */}
      <section aria-label="Status" className={`${card} flex flex-wrap items-center justify-between gap-3`}>
        <div className="flex items-center gap-3">
          <Badge tone={status.tone}>{status.label}</Badge>
          {deleting && <span className="text-sm text-gray-400">This giveaway is being deleted.</span>}
        </div>
        <label className="inline-flex items-center gap-2 text-sm text-gray-300">
          <span>{g.enabled ? 'On' : 'Off'}</span>
          <button type="button" role="switch" aria-checked={g.enabled} aria-label="Giveaway on" disabled={switching || deleting} onClick={toggle}
            className={`relative h-6 w-11 rounded-full transition-colors disabled:opacity-50 ${g.enabled ? 'bg-green-500' : 'bg-gray-700'}`}>
            <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition-all ${g.enabled ? 'left-[22px]' : 'left-0.5'}`} />
          </button>
        </label>
        {statusError && (
          <div role="alert" className="w-full text-sm text-red-400">
            <p>{statusError.message}</p>
            {statusError.items.length > 0 && <ul className="mt-1 list-disc pl-5">{statusError.items.map((l) => <li key={l}>{l}</li>)}</ul>}
          </div>
        )}
      </section>

      {/* 2. Wallet */}
      <section className={card}>
        <h2 className="mb-2 text-lg font-semibold">Wallet</h2>
        <p className="mb-2 text-sm text-gray-400">This giveaway's own wallet. It mints the wearables and pays the gas.</p>
        {g.walletAddress ? <WalletLine chain={g.chain} address={g.walletAddress} /> : <p className="text-sm text-gray-500">No wallet yet.</p>}
      </section>

      {/* 3. Items */}
      <section className={card}>
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-lg font-semibold">Items</h2>
          <div className="flex gap-2">
            <button type="button" onClick={checkAgain} disabled={checking} className="rounded-md bg-gray-800 px-3 py-1.5 text-sm hover:bg-gray-700 disabled:opacity-50">
              {checking ? 'Checking…' : 'Check again'}
            </button>
            {!deleting && <ItemPicker giveaway={g} onSaved={setG} />}
          </div>
        </div>
        {g.items.length === 0 ? (
          <p className="text-sm text-gray-500">No items yet. Choose the wearables to give away.</p>
        ) : (
          <ul className="space-y-2">
            {g.items.map((item) => {
              const step = mintStep(item.mintState, g.walletAddress)
              return (
                <li key={item.id} className="flex flex-wrap items-center justify-between gap-3 rounded-md bg-gray-800/50 px-3 py-2">
                  <div className="flex min-w-0 items-center gap-3">
                    {item.thumbnail
                      ? <img src={item.thumbnail} alt="" className="h-10 w-10 rounded object-cover" />
                      : <span aria-hidden="true" className="h-10 w-10 rounded bg-gray-800" />}
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">{item.name || `Item ${item.itemId ?? ''}`}</p>
                      <p className="text-xs text-gray-500">
                        {[item.rarity, item.remaining !== null && item.mintState !== 'sold_out' ? `${item.remaining.toLocaleString('en-US')} left` : null].filter(Boolean).join(' · ')}
                      </p>
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center gap-2 text-sm">
                    <Badge tone={step.tone}>{step.text}</Badge>
                    {step.builder && (
                      <a href={g.builderUrl} target="_blank" rel="noopener noreferrer" className="text-blue-400 underline underline-offset-2 hover:text-blue-300">Open the Builder</a>
                    )}
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </section>

      {/* 4. Funding */}
      <FundingCard giveaway={g} disabled={deleting} onSent={() => { load().catch(() => {}) }} />

      {/* 5. Rules */}
      <RulesCard giveaway={g} disabled={deleting} onSaved={setG} />

      {/* 6. Scenes */}
      <ScenesCard giveaway={g} disabled={deleting} onSaved={setG} />

      {/* 7. Claims */}
      <ClaimsTable giveaway={g} />

      {/* 8. Delete */}
      {!deleting && (
        <section className="rounded-lg border border-red-900/50 bg-gray-900 p-4">
          <h2 className="mb-2 text-lg font-semibold text-red-400">Delete</h2>
          <ConfirmAction prompt="Delete this giveaway? It stops at once." confirmLabel="Delete" onConfirm={remove}
            className="rounded-md bg-red-900/30 px-4 py-2 text-sm text-red-400 hover:bg-red-900/50">
            Delete giveaway
          </ConfirmAction>
          {deleteError && <p role="alert" className="mt-2 text-sm text-red-400">{deleteError}</p>}
        </section>
      )}
    </div>
  )
}

function WalletLine({ chain, address }: { chain: HostGiveaway['chain']; address: string }) {
  const [copied, setCopied] = useState(false)
  const copy = () => {
    navigator.clipboard?.writeText(address).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500) }).catch(() => {})
  }
  return (
    <div className="flex flex-wrap items-center gap-3 text-sm">
      <code className="break-all font-mono text-gray-200">{address}</code>
      <button type="button" onClick={copy} className="text-blue-400 underline underline-offset-2 hover:text-blue-300">{copied ? 'Copied' : 'Copy'}</button>
      <a href={giveawayAddressUrl(chain, address)} target="_blank" rel="noopener noreferrer" className="text-blue-400 underline underline-offset-2 hover:text-blue-300">View on Polygonscan</a>
    </div>
  )
}

function RulesCard({ giveaway: g, disabled, onSaved }: { giveaway: HostGiveaway; disabled: boolean; onSaved: (g: HostGiveaway) => void }) {
  const api = useApi()
  const [startsAt, setStartsAt] = useState(g.startsAt ? toLocalInput(g.startsAt) : '')
  const [endsAt, setEndsAt] = useState(g.endsAt ? toLocalInput(g.endsAt) : '')
  const [cap, setCap] = useState(g.claimCap === null ? '' : String(g.claimCap))
  const [minutes, setMinutes] = useState(String(Math.round(g.minPresentSeconds / 60)))
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null)

  const save = async (e: React.FormEvent) => {
    e.preventDefault()
    setSaving(true)
    setMessage(null)
    try {
      onSaved(await api.updateGiveaway(g.id, {
        startsAt: fromLocalInput(startsAt) || null,
        endsAt: fromLocalInput(endsAt) || null,
        claimCap: cap.trim() === '' ? null : Number(cap),
        minPresentSeconds: Math.round((Number(minutes) || 0) * 60),
      }))
      setMessage({ ok: true, text: 'Saved.' })
    } catch (err) {
      setMessage({ ok: false, text: dropsError(err) })
    }
    setSaving(false)
  }

  return (
    <form onSubmit={save} className={card}>
      <h2 className="mb-3 text-lg font-semibold">Rules</h2>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="flex flex-col gap-1 text-sm text-gray-300">
          Starts
          <input type="datetime-local" value={startsAt} onChange={(e) => setStartsAt(e.target.value)} className={input} />
          <span className="text-xs text-gray-500">Leave empty to start when it's switched on.</span>
        </label>
        <label className="flex flex-col gap-1 text-sm text-gray-300">
          Ends
          <input type="datetime-local" value={endsAt} onChange={(e) => setEndsAt(e.target.value)} className={input} />
          <span className="text-xs text-gray-500">Leave empty to run until you switch it off.</span>
        </label>
        <label className="flex flex-col gap-1 text-sm text-gray-300">
          Claim limit
          <input type="number" min={1} step={1} value={cap} onChange={(e) => setCap(e.target.value)} placeholder="No limit" className={input} />
          <span className="text-xs text-gray-500">The most people who can claim. Leave empty for no limit.</span>
        </label>
        <label className="flex flex-col gap-1 text-sm text-gray-300">
          Minimum minutes in the scene
          <input type="number" min={0} max={120} step={1} value={minutes} onChange={(e) => setMinutes(e.target.value)} className={input} />
          <span className="text-xs text-gray-500">0 means no minimum.</span>
        </label>
      </div>
      <div className="mt-3 flex items-center gap-3">
        <button type="submit" disabled={saving || disabled} className="rounded-md bg-blue-600 px-4 py-2 text-sm hover:bg-blue-700 disabled:opacity-50">
          {saving ? 'Saving…' : 'Save rules'}
        </button>
        {message && <p role={message.ok ? 'status' : 'alert'} className={`text-sm ${message.ok ? 'text-green-400' : 'text-red-400'}`}>{message.text}</p>}
      </div>
    </form>
  )
}

function ScenesCard({ giveaway: g, disabled, onSaved }: { giveaway: HostGiveaway; disabled: boolean; onSaved: (g: HostGiveaway) => void }) {
  const api = useApi()
  const [scenes, setScenes] = useState<{ id: string; name: string }[] | null>(null)
  const [picked, setPicked] = useState<Set<string>>(new Set(g.sceneIds))
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null)

  useEffect(() => {
    api.getScenes().then((d) => setScenes(d.scenes.map((s: { id: string; name: string }) => ({ id: s.id, name: s.name })))).catch(() => setScenes([]))
  }, [api])

  const flip = (sceneId: string) => setPicked((p) => {
    const next = new Set(p)
    if (next.has(sceneId)) next.delete(sceneId)
    else next.add(sceneId)
    return next
  })
  const changed = picked.size !== g.sceneIds.length || g.sceneIds.some((s) => !picked.has(s))

  const save = async () => {
    setSaving(true)
    setMessage(null)
    try {
      const next = await api.setGiveawayScenes(g.id, [...picked])
      onSaved(next)
      setPicked(new Set(next.sceneIds))
      setMessage({ ok: true, text: 'Saved.' })
    } catch (err) {
      setMessage({ ok: false, text: dropsError(err) })
    }
    setSaving(false)
  }

  return (
    <section className={card}>
      <h2 className="mb-1 text-lg font-semibold">Scenes</h2>
      <p className="mb-3 text-sm text-gray-400">Visitors in these scenes see the giveaway.</p>
      {!scenes ? <Skeleton rows={1} className="h-10" /> : scenes.length === 0 ? (
        <p className="text-sm text-gray-500">You have no scenes yet.</p>
      ) : (
        <fieldset className="space-y-1" disabled={disabled}>
          <legend className="sr-only">Scenes</legend>
          {scenes.map((s) => (
            <label key={s.id} className="flex items-center gap-2 text-sm text-gray-200">
              <input type="checkbox" checked={picked.has(s.id)} onChange={() => flip(s.id)} className="rounded" />
              {s.name}
            </label>
          ))}
        </fieldset>
      )}
      <div className="mt-3 flex items-center gap-3">
        <button type="button" onClick={save} disabled={saving || disabled || !changed} className="rounded-md bg-blue-600 px-4 py-2 text-sm hover:bg-blue-700 disabled:opacity-50">
          {saving ? 'Saving…' : 'Save scenes'}
        </button>
        {message && <p role={message.ok ? 'status' : 'alert'} className={`text-sm ${message.ok ? 'text-green-400' : 'text-red-400'}`}>{message.text}</p>}
      </div>
    </section>
  )
}
