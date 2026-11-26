'use client'
// Drops (LIV-194): the host's automatic giveaways. `?id=` opens one.
import { Suspense, useEffect, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { GIVEAWAY_CHAINS, type GiveawayChain } from '@virvixr/shared'
import { useApi, useDemoPrefix } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { countLabel } from '@/lib/format'
import { GIVEAWAYS_OFF, TEST_BADGE, dropsError, giveawayStatus, type GiveawayAvailability, type GiveawaySummary } from '@/lib/drops'
import { Badge, EmptyState, PageHeader, PrimaryButton, SelectField, Skeleton } from '@/components/ui'
import { GiftIcon, PlusIcon } from '@/components/icons'
import { GiveawayDetail } from '@/components/drops/GiveawayDetail'

const CHAIN_LABELS: Record<GiveawayChain, string> = { polygon: 'Polygon', 'polygon-amoy': 'Amoy (test)' }

export default function DropsPage() {
  return (
    <Suspense fallback={<Skeleton />}>
      <DropsContent />
    </Suspense>
  )
}

function DropsContent() {
  const { token } = useAuth()
  const api = useApi()
  const searchParams = useSearchParams()
  const selectedId = searchParams.get('id')
  const [availability, setAvailability] = useState<GiveawayAvailability | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!token) return
    api.getGiveawayAvailability().then(setAvailability).catch((err) => setError(dropsError(err)))
  }, [token, api])

  if (error) return <div className="mx-auto max-w-7xl"><p role="alert" className="text-red-400">{error}</p></div>
  if (!availability) return <div className="mx-auto max-w-7xl"><Skeleton /></div>
  if (!availability.enabled) {
    return (
      <div className="mx-auto max-w-7xl">
        <PageHeader crumbs={['Workspace', 'Drops']} title="Drops" subtitle="Give wearables to the people who visit your scenes." />
        <p role="note" className="rounded-lg border border-gray-800 bg-gray-900 px-4 py-3 text-sm text-gray-300">{GIVEAWAYS_OFF}</p>
      </div>
    )
  }
  return (
    <div className="mx-auto max-w-7xl">
      {selectedId ? <GiveawayDetail id={selectedId} /> : <GiveawayList />}
    </div>
  )
}

function GiveawayList() {
  const { token, user } = useAuth()
  const api = useApi()
  const prefix = useDemoPrefix()
  const router = useRouter()
  const admin = user?.role === 'admin'
  const [giveaways, setGiveaways] = useState<GiveawaySummary[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [showCreate, setShowCreate] = useState(false)
  const [name, setName] = useState('')
  const [chain, setChain] = useState<GiveawayChain>('polygon')
  const [creating, setCreating] = useState(false)
  const now = Date.now()

  useEffect(() => {
    if (!token) return
    api.getGiveaways().then((d) => setGiveaways(d.giveaways)).catch((err) => setError(dropsError(err)))
  }, [token, api])

  const open = (id: string) => router.push(`${prefix}/drops?id=${encodeURIComponent(id)}`)

  const create = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!name.trim() || creating) return
    setCreating(true)
    setError(null)
    try {
      const { giveaway } = await api.createGiveaway({ name: name.trim(), ...(admin ? { chain } : {}) })
      open(giveaway.id)
    } catch (err) {
      setError(dropsError(err))
      setCreating(false)
    }
  }

  return (
    <>
      <PageHeader
        crumbs={['Workspace', 'Drops']}
        title="Drops"
        count={giveaways ? countLabel(giveaways.length) : undefined}
        subtitle="Give wearables to the people who visit your scenes. Each giveaway has its own wallet that mints them."
        actions={<PrimaryButton onClick={() => setShowCreate(!showCreate)}><PlusIcon size={16} /> Create giveaway</PrimaryButton>}
      />

      {showCreate && (
        <form onSubmit={create} className="mb-6 flex flex-wrap items-center gap-2 rounded-lg border border-gray-800 bg-gray-900 p-4">
          <input aria-label="Giveaway name" type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="Giveaway name"
            maxLength={80} autoFocus
            className="min-w-56 flex-1 rounded-md border border-gray-800 bg-gray-950 px-4 py-2 text-white outline-none focus:border-blue-400" />
          {admin && (
            <SelectField label="Chain" value={chain} onChange={(v) => setChain(v as GiveawayChain)} className="w-44">
              {GIVEAWAY_CHAINS.map((c) => <option key={c} value={c}>{CHAIN_LABELS[c]}</option>)}
            </SelectField>
          )}
          <button type="submit" disabled={!name.trim() || creating} className="rounded-md bg-blue-600 px-4 py-2 text-sm hover:bg-blue-700 disabled:opacity-50">
            {creating ? 'Creating…' : 'Create'}
          </button>
          <button type="button" onClick={() => setShowCreate(false)} className="rounded-md bg-gray-800 px-4 py-2 text-sm hover:bg-gray-700">Cancel</button>
        </form>
      )}

      {error && <p role="alert" className="mb-4 text-sm text-red-400">{error}</p>}

      {!giveaways ? (
        error ? null : <Skeleton />
      ) : giveaways.length === 0 ? (
        <EmptyState icon={<GiftIcon size={40} />} title="No giveaways yet" body="Create one, pick the wearables, and visitors claim them in your scenes." />
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
          {giveaways.map((g) => {
            const status = giveawayStatus(g, now)
            return (
              <button key={g.id} type="button" onClick={() => open(g.id)}
                className="rounded-lg border border-gray-800 bg-gray-900 p-4 text-left transition-colors hover:border-gray-600">
                <div className="flex items-start justify-between gap-2">
                  <h2 className="min-w-0 break-words font-semibold">{g.name}</h2>
                  {g.chain === 'polygon-amoy' && <Badge tone="violet">{TEST_BADGE}</Badge>}
                </div>
                <div className="mt-3 flex flex-wrap items-center gap-2 text-sm text-gray-400">
                  <Badge tone={status.tone}>{status.label}</Badge>
                  {g.counts?.sent !== undefined && <span>{g.counts.sent.toLocaleString('en-US')} sent</span>}
                </div>
              </button>
            )
          })}
        </div>
      )}
    </>
  )
}
