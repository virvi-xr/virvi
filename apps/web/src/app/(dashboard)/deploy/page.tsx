'use client'
import { destinationHistory } from '@/lib/deploy'
import { useApi, type DclDeployment, type DclDestination } from '@/lib/api'
import { API_URL } from '@/lib/config'
import { destroyWorldPrompt, hyperfyErrorMessage, lastSeenLabel, noSlotsLine, removeWorldPrompt, setupSteps, shortDate, slotLine, worldStatusLabel } from '@/lib/hyperfy'
import type { HyperfyWorldSummary } from '@virvixr/shared'
import { useAuth } from '@/lib/auth'
import Link from 'next/link'
import { useSearchParams, useRouter } from 'next/navigation'
import { useEffect, useRef, useState, Suspense } from 'react'
import { ConfirmAction, PageHeader, Skeleton } from '@/components/ui'
import { AdoptWorldCard, WorldDestinationCard } from '@/components/dcl/WorldDestinationCard'
import { ParcelDestinationCard } from '@/components/dcl/ParcelDestinationCard'
import { wizardErrorMessage } from '@/lib/wizard/run'
import { canDisconnectScene } from '@/lib/world-disconnect'

export default function DeployPage() {
  return (
    <Suspense fallback={<Skeleton />}>
      <DeployContent />
    </Suspense>
  )
}

// -- Your Hyperfy worlds (self-run and Virvi-hosted) -----------------------------

const POLL_MS = 5000

/** An end date picked in the form is the end of that day, UTC. */
const endOfDayUtc = (day: string) => new Date(`${day}T23:59:59Z`).toISOString()

type Shown =
  | { kind: 'key'; worldName: string; key: string }
  | { kind: 'created'; worldName: string; address: string | null; adminCode: string }

function HyperfyWorlds({ sceneId }: { sceneId: string }) {
  const { token } = useAuth()
  const api = useApi()
  const [worlds, setWorlds] = useState<HyperfyWorldSummary[]>([])
  const [slots, setSlots] = useState<{ used: number; limit: number; hostingAvailable: boolean } | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [name, setName] = useState('')
  const [hostedName, setHostedName] = useState('')
  const [hostedEnd, setHostedEnd] = useState('')
  const [busy, setBusy] = useState(false)
  // Keys and admin codes live only in this component's state: shown once, dropped when the scene changes.
  const [shown, setShown] = useState<Shown | null>(null)
  const [revealed, setRevealed] = useState<{ id: string; code: string } | null>(null)
  const [editing, setEditing] = useState<{ id: string; day: string } | null>(null)
  const [copied, setCopied] = useState(false)

  const refreshSlots = () =>
    api.getHyperfySlots()
      .then((s) => setSlots({ used: s.used, limit: s.limit ?? Infinity, hostingAvailable: s.hostingAvailable }))
      .catch(() => setSlots(null))

  useEffect(() => {
    if (!token) return
    let stale = false
    setLoading(true)
    setError('')
    setNotice('')
    setShown(null)
    setRevealed(null)
    setEditing(null)
    api.getHyperfyWorlds(sceneId)
      .then((d) => { if (!stale) setWorlds(d.worlds) })
      .catch((err) => { if (!stale) { setWorlds([]); setError(hyperfyErrorMessage(err)) } })
      .finally(() => { if (!stale) setLoading(false) })
    api.getHyperfySlots()
      .then((s) => { if (!stale) setSlots({ used: s.used, limit: s.limit ?? Infinity, hostingAvailable: s.hostingAvailable }) })
      .catch(() => { if (!stale) setSlots(null) })
    return () => { stale = true }
  }, [token, sceneId])

  // Worlds still setting up refresh every few seconds until they settle.
  const settling = worlds.some((w) => w.status === 'provisioning')
  useEffect(() => {
    if (!token || !settling) return
    let stale = false
    const timer = setInterval(() => {
      api.getHyperfyWorlds(sceneId)
        .then((d) => { if (!stale) { setWorlds(d.worlds); refreshSlots() } })
        .catch(() => { /* keep the last list; the next tick retries */ })
    }, POLL_MS)
    return () => { stale = true; clearInterval(timer) }
  }, [token, sceneId, settling])

  const run = async (action: () => Promise<void>) => {
    setBusy(true)
    setError('')
    setNotice('')
    try {
      await action()
    } catch (err) {
      setError(hyperfyErrorMessage(err))
    }
    setBusy(false)
  }

  const replaceWorld = (world: HyperfyWorldSummary) => setWorlds((prev) => prev.map((x) => (x.id === world.id ? world : x)))

  const connect = (e: React.FormEvent) => {
    e.preventDefault()
    if (!name.trim()) return
    return run(async () => {
      const { world, key } = await api.createHyperfyWorld({ sceneId, name: name.trim() })
      setWorlds((prev) => [...prev, world])
      setShown({ kind: 'key', worldName: world.name, key })
      setCopied(false)
      setName('')
    })
  }

  const createHosted = (e: React.FormEvent) => {
    e.preventDefault()
    if (!hostedName.trim()) return
    if (hostedEnd && new Date(endOfDayUtc(hostedEnd)).getTime() <= Date.now()) {
      setError('Pick an end date in the future.')
      return
    }
    return run(async () => {
      try {
        const { world, adminCode } = await api.createHostedHyperfyWorld({
          sceneId,
          name: hostedName.trim(),
          endsAt: hostedEnd ? endOfDayUtc(hostedEnd) : null,
        })
        setWorlds((prev) => [...prev, world])
        setShown({ kind: 'created', worldName: world.name, address: world.address, adminCode })
        setCopied(false)
        setHostedName('')
        setHostedEnd('')
      } finally {
        refreshSlots()
      }
    })
  }

  const rotate = (w: HyperfyWorldSummary) => {
    const hosted = w.kind === 'hosted'
    return run(async () => {
      const { world, key } = await api.rotateHyperfyWorldKey(w.id)
      replaceWorld(world)
      if (hosted) {
        setNotice(`"${world.name}" restarted with a new key.`)
      } else {
        setShown({ kind: 'key', worldName: world.name, key })
        setCopied(false)
      }
    })
  }

  const remove = (w: HyperfyWorldSummary) => {
    const hosted = w.kind === 'hosted'
    return run(async () => {
      try {
        await api.deleteHyperfyWorld(w.id)
        setWorlds((prev) => prev.filter((x) => x.id !== w.id))
        setShown(null)
        setRevealed((r) => (r?.id === w.id ? null : r))
      } finally {
        if (hosted) refreshSlots()
      }
    })
  }

  const saveEndDate = (w: HyperfyWorldSummary, day: string | null) => {
    if (day && new Date(endOfDayUtc(day)).getTime() <= Date.now()) {
      setError('Pick an end date in the future.')
      return
    }
    return run(async () => {
      const { world } = await api.setHyperfyWorldEndDate(w.id, day ? endOfDayUtc(day) : null)
      replaceWorld(world)
      setEditing(null)
    })
  }

  const restore = (w: HyperfyWorldSummary) =>
    run(async () => {
      try {
        const { world } = await api.restoreHyperfyWorld(w.id)
        replaceWorld(world)
      } finally {
        refreshSlots()
      }
    })

  const showAdminCode = (w: HyperfyWorldSummary) =>
    run(async () => {
      const { adminCode } = await api.getHyperfyAdminCode(w.id)
      setRevealed({ id: w.id, code: adminCode })
    })

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
    } catch {
      // clipboard blocked: the text is still visible to select
    }
  }

  const now = new Date()
  const noSlotsLeft = slots !== null && slots.used >= slots.limit
  const link = (address: string) => (
    <a href={`https://${address}`} target="_blank" rel="noreferrer" className="text-blue-400 hover:text-blue-300">{address}</a>
  )
  const rotatePrompt = (w: HyperfyWorldSummary) => w.kind === 'hosted'
    ? `Make a new key for "${w.name}"? The world restarts to pick it up.`
    : `Make a new key for "${w.name}"? The old key stops working right away.`
  const actionClass = 'text-blue-400 hover:text-blue-300 disabled:opacity-50'
  const dangerClass = 'text-red-400 hover:text-red-300 disabled:opacity-50'

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold">Your Hyperfy worlds</h2>
        <p className="text-sm text-gray-500">Have Virvi host a world for this scene, or connect one you run yourself. Either way it follows your edits.</p>
      </div>

      {error && <p className="rounded-lg border border-red-900/60 bg-red-950/40 px-4 py-3 text-sm text-red-300" role="alert">{error}</p>}
      {notice && <p className="rounded-lg border border-blue-900/60 bg-blue-950/40 px-4 py-3 text-sm text-blue-300" role="status">{notice}</p>}

      {shown?.kind === 'key' && (
        <div className="space-y-3 rounded-lg border border-blue-500/40 bg-gray-900 p-5">
          <p className="text-sm font-medium text-blue-400">World key for {shown.worldName}</p>
          <div className="flex items-center gap-2">
            <code className="min-w-0 flex-1 break-all rounded-md bg-gray-800 px-3 py-2 text-sm text-white">{shown.key}</code>
            <button onClick={() => copy(shown.key)} className="rounded-md bg-gray-800 px-3 py-2 text-sm text-blue-400 hover:bg-gray-700">{copied ? 'Copied' : 'Copy'}</button>
          </div>
          <p className="text-sm text-yellow-400">You won&apos;t see this key again.</p>
          <a href={`${API_URL}/api/hyperfy/app.hyp`} className="inline-block rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700">Download Virvi app (.hyp)</a>
          <ol className="list-decimal space-y-1 pl-5 text-sm text-gray-300">
            {setupSteps(API_URL).map((step) => <li key={step}>{step}</li>)}
          </ol>
          <button onClick={() => setShown(null)} className="text-sm text-gray-400 hover:text-white">Done</button>
        </div>
      )}

      {shown?.kind === 'created' && (
        <div className="space-y-3 rounded-lg border border-blue-500/40 bg-gray-900 p-5">
          <p className="text-sm font-medium text-blue-400">{shown.worldName} is being set up</p>
          <p className="text-sm text-gray-300">Type <code className="rounded bg-gray-800 px-1.5 py-0.5 text-white">/admin {shown.adminCode}</code> in the world&apos;s chat to build.</p>
          <div>
            <button onClick={() => copy(shown.adminCode)} className="rounded-md bg-gray-800 px-3 py-2 text-sm text-blue-400 hover:bg-gray-700">{copied ? 'Copied' : 'Copy admin code'}</button>
          </div>
          {shown.address && <p className="text-sm text-gray-300">Address: {link(shown.address)}</p>}
          <p className="text-sm text-gray-400">Setup takes about 2 to 3 minutes. The world shows as Live below when it&apos;s ready.</p>
          <p className="text-sm text-yellow-400">Save the admin code now. You can show it again later from the world&apos;s row.</p>
          <button onClick={() => setShown(null)} className="text-sm text-gray-400 hover:text-white">Done</button>
        </div>
      )}

      {loading ? (
        <Skeleton rows={2} className="h-12" />
      ) : worlds.length === 0 ? (
        !error && <p className="rounded-lg border border-gray-800 bg-gray-900 py-6 text-center text-sm text-gray-500">No worlds connected to this scene yet.</p>
      ) : (
        <div className="space-y-2">
          {worlds.map((w) => w.kind === 'hosted' ? (
            <div key={w.id} className="space-y-2 rounded-lg border border-gray-800 bg-gray-900 px-4 py-3">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="truncate font-medium">{w.name}</p>
                  {w.address && <p className="truncate text-sm">{link(w.address)}</p>}
                  <p className="text-xs text-gray-500">
                    {worldStatusLabel(w, now)}
                    {w.status !== 'ended' && w.endsAt && ` · Ends ${shortDate(w.endsAt)}`}
                  </p>
                </div>
                <div className="flex flex-wrap gap-3 text-sm">
                  {w.status !== 'ended' && w.status !== 'failed' && (
                    <button disabled={busy} onClick={() => setEditing({ id: w.id, day: w.endsAt ? w.endsAt.slice(0, 10) : '' })} className={actionClass}>Edit end date</button>
                  )}
                  {w.status !== 'ended' && w.status !== 'failed' && w.endsAt && (
                    <button disabled={busy} onClick={() => saveEndDate(w, null)} className={actionClass}>Make permanent</button>
                  )}
                  {w.status === 'ended' && <button disabled={busy} onClick={() => restore(w)} className={actionClass}>Restore</button>}
                  {w.status === 'running' && <button disabled={busy} onClick={() => showAdminCode(w)} className={actionClass}>Show admin code</button>}
                  {w.status === 'running' && <ConfirmAction disabled={busy} danger={false} confirmLabel="New key" prompt={rotatePrompt(w)} onConfirm={() => rotate(w)} className={actionClass}>New key</ConfirmAction>}
                  <ConfirmAction disabled={busy} confirmLabel="Destroy" prompt={destroyWorldPrompt(w.name)} onConfirm={() => remove(w)} className={dangerClass}>Destroy</ConfirmAction>
                </div>
              </div>
              {editing?.id === w.id && (
                <div className="flex flex-wrap items-end gap-3">
                  <div>
                    <label className="mb-1 block text-xs text-gray-400" htmlFor={`end-${w.id}`}>Ends on</label>
                    <input
                      id={`end-${w.id}`}
                      type="date"
                      value={editing.day}
                      onChange={(e) => setEditing({ id: w.id, day: e.target.value })}
                      className="rounded-md bg-gray-950 px-3 py-2 text-white outline-none focus:border-blue-400 border border-gray-800"
                    />
                  </div>
                  <button disabled={busy || !editing.day} onClick={() => saveEndDate(w, editing.day)} className="rounded-md bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50">Save</button>
                  <button onClick={() => setEditing(null)} className="text-sm text-gray-400 hover:text-white">Cancel</button>
                </div>
              )}
              {revealed?.id === w.id && (
                <div className="flex flex-wrap items-center gap-2 text-sm text-gray-300">
                  <span>Type <code className="rounded bg-gray-800 px-1.5 py-0.5 text-white">/admin {revealed.code}</code> in the world&apos;s chat to build.</span>
                  <button onClick={() => setRevealed(null)} className="text-gray-400 hover:text-white">Hide</button>
                </div>
              )}
            </div>
          ) : (
            <div key={w.id} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-gray-800 bg-gray-900 px-4 py-3">
              <div className="min-w-0">
                <p className="truncate font-medium">{w.name}</p>
                <p className="text-xs text-gray-500">Key {w.keyPrefix}… · {lastSeenLabel(w.lastSeenAt, now)}</p>
              </div>
              <div className="flex gap-3 text-sm">
                <ConfirmAction disabled={busy} danger={false} confirmLabel="New key" prompt={rotatePrompt(w)} onConfirm={() => rotate(w)} className={actionClass}>New key</ConfirmAction>
                <ConfirmAction disabled={busy} confirmLabel="Remove" prompt={removeWorldPrompt(w.name)} onConfirm={() => remove(w)} className={dangerClass}>Remove</ConfirmAction>
              </div>
            </div>
          ))}
        </div>
      )}

      {slots?.hostingAvailable && (
        <div className="space-y-3 rounded-lg border border-gray-800 bg-gray-900 p-4">
          <p className="text-sm font-medium">Create a hosted world</p>
          {slotLine(slots.used, slots.limit) && <p className="text-xs text-gray-400">{slotLine(slots.used, slots.limit)}</p>}
          {noSlotsLeft ? (
            <p className="text-sm text-gray-300">
              {noSlotsLine(slots.limit)}{' '}
              <Link href="/settings" className="text-blue-400 hover:text-blue-300">See plans</Link>
            </p>
          ) : (
            <form onSubmit={createHosted} className="flex flex-wrap items-end gap-3">
              <div className="min-w-[12rem] flex-1">
                <label className="mb-1 block text-xs text-gray-400" htmlFor="hosted-name">World name</label>
                <input
                  id="hosted-name"
                  value={hostedName}
                  onChange={(e) => setHostedName(e.target.value)}
                  maxLength={100}
                  placeholder="My hosted world"
                  className="w-full rounded-md bg-gray-950 px-4 py-2 text-white outline-none focus:border-blue-400 border border-gray-800"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs text-gray-400" htmlFor="hosted-end">Ends on (optional)</label>
                <input
                  id="hosted-end"
                  type="date"
                  value={hostedEnd}
                  onChange={(e) => setHostedEnd(e.target.value)}
                  className="rounded-md bg-gray-950 px-3 py-2 text-white outline-none focus:border-blue-400 border border-gray-800"
                />
              </div>
              <button type="submit" disabled={busy || !hostedName.trim()} className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50">Create world</button>
            </form>
          )}
        </div>
      )}

      <form onSubmit={connect} className="flex flex-wrap items-end gap-3 rounded-lg border border-gray-800 bg-gray-900 p-4">
        <div className="min-w-[12rem] flex-1">
          <label className="block text-xs text-gray-400 mb-1">Connect a world you run yourself</label>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={100}
            placeholder="My Hyperfy world"
            className="w-full rounded-md bg-gray-950 px-4 py-2 text-white outline-none focus:border-blue-400 border border-gray-800"
          />
        </div>
        <button type="submit" disabled={busy || !name.trim()} className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50">Connect a world</button>
      </form>
    </div>
  )
}

// -- Main Content -------------------------------------------------------------

interface WorldsState {
  destinations: DclDestination[]
  /** Worlds set up in-world for this scene that have no destination yet. */
  adoptable: string[]
  history: DclDeployment[]
  /** Destinations adopted on this visit: their card offers the permission. */
  offerGrant: Set<string>
}

function DeployContent() {
  const { token } = useAuth()
  const api = useApi()
  const searchParams = useSearchParams()
  const router = useRouter()

  // Scene selector
  const [scenes, setScenes] = useState<any[]>([])
  const [selectedSceneId, setSelectedSceneId] = useState<string>(searchParams.get('scene') || '')
  const [loadingScenes, setLoadingScenes] = useState(true)

  // Load scenes
  useEffect(() => {
    if (!token) return
    api.getScenes().then((data) => {
      setScenes(data.scenes)
      setLoadingScenes(false)
      if (!selectedSceneId && data.scenes.length > 0) {
        const preselected = searchParams.get('scene')
        if (preselected && data.scenes.some((s: any) => s.id === preselected)) {
          setSelectedSceneId(preselected)
        }
      }
    }).catch(() => setLoadingScenes(false))
  }, [token])

  // Decentraland Worlds
  const [worlds, setWorlds] = useState<WorldsState | null>(null)
  const [worldsError, setWorldsError] = useState<string | null>(null)
  const [virviDeploys, setVirviDeploys] = useState(false)

  useEffect(() => {
    if (!token) return
    api.getWizardOptions().then((o) => setVirviDeploys(o.dcl.virviDeploys)).catch(() => setVirviDeploys(false))
  }, [token])

  const loadHistory = (sceneId: string) =>
    api.getDeployments(sceneId).then((d) => d.deployments as DclDeployment[]).catch(() => [] as DclDeployment[])

  // Load the scene's Worlds when the scene changes
  useEffect(() => {
    setWorlds(null)
    setWorldsError(null)
    if (!token || !selectedSceneId) return
    let stale = false
    Promise.all([api.getSceneDclDestinations(selectedSceneId), loadHistory(selectedSceneId)])
      .then(([{ destinations, adoptable }, history]) => {
        if (!stale) setWorlds({ destinations, adoptable: adoptable.map((a) => a.world), history, offerGrant: new Set() })
      })
      .catch((err) => { if (!stale) setWorldsError(wizardErrorMessage(err)) })
    return () => { stale = true }
  }, [token, selectedSceneId])

  const currentScene = useRef(selectedSceneId)
  currentScene.current = selectedSceneId
  const refreshHistory = async () => {
    const sceneId = selectedSceneId
    const history = await loadHistory(sceneId)
    setWorlds((w) => (w && currentScene.current === sceneId ? { ...w, history } : w))
  }

  const adopted = (dest: DclDestination) =>
    setWorlds((w) => w && {
      ...w,
      destinations: [...w.destinations, dest],
      adoptable: w.adoptable.filter((x) => x !== dest.worldName),
      offerGrant: new Set([...w.offerGrant, dest.id]),
    })

  // A World disconnected from the scene: its card goes. Its deployments stay in the scene's records (Download what went
  // live still works by deployment), but this page lists history per World, so they no longer show here.
  const [worldNotice, setWorldNotice] = useState<string | null>(null)
  useEffect(() => setWorldNotice(null), [selectedSceneId])
  const disconnected = (dest: DclDestination, notice: string) => {
    setWorlds((w) => w && { ...w, destinations: w.destinations.filter((d) => d.id !== dest.id) })
    setWorldNotice(notice)
  }

  const handleSceneChange = (sceneId: string) => {
    setSelectedSceneId(sceneId)
    const url = sceneId ? `/deploy?scene=${sceneId}` : '/deploy'
    router.replace(url)
  }

  // -- Render -----------------------------------------------------------------

  if (loadingScenes) return <Skeleton />

  return (
    <div className="mx-auto max-w-7xl space-y-8">
      <PageHeader
        crumbs={['Tools', 'Deploy']}
        title="Deploy"
        subtitle="Publish your scenes to their worlds."
      />

      {/* Scene Selector */}
      <div>
        <label className="block text-xs text-gray-400 mb-1">Select Scene</label>
        <select
          value={selectedSceneId}
          onChange={(e) => handleSceneChange(e.target.value)}
          className="w-full max-w-md rounded-md bg-gray-950 px-4 py-2 text-white outline-none focus:border-blue-400 border border-gray-800"
        >
          <option value="">-- Choose a scene --</option>
          {scenes.map((scene) => (
            <option key={scene.id} value={scene.id}>{scene.name}</option>
          ))}
        </select>
      </div>

      {!selectedSceneId && (
        <div className="text-center py-12">
          <p className="text-gray-500 mb-2">Select a scene to see where it&apos;s deployed.</p>
          <p className="text-sm text-gray-600">Scenes go live in a Decentraland World, or in a Hyperfy world.</p>
        </div>
      )}

      {selectedSceneId && (
        <div className="space-y-4">
          <div>
            <h2 className="text-lg font-semibold">Decentraland Worlds</h2>
            <p className="text-sm text-gray-500">Virvi deploys from what&apos;s live in your World, so you never need the scene&apos;s files.</p>
          </div>
          {worldNotice && <p className="rounded-lg border border-blue-900/60 bg-blue-950/40 px-4 py-3 text-sm text-blue-200" role="status">{worldNotice}</p>}
          {worldsError ? (
            <p className="rounded-lg border border-red-900/60 bg-red-950/40 px-4 py-3 text-sm text-red-300" role="alert">{worldsError}</p>
          ) : !worlds ? (
            <Skeleton rows={1} className="h-32" />
          ) : worlds.destinations.length === 0 && worlds.adoptable.length === 0 ? (
            <div className="rounded-lg border border-gray-800 bg-gray-900 py-6 text-center text-sm text-gray-500">
              <p>This scene isn&apos;t deployed to a Decentraland World.</p>
              <p className="mt-1">
                <Link href="/scenes/new" className="text-blue-400 hover:text-blue-300">Make a new scene</Link> to deploy one, or set this scene up in your own Creator Hub scene with virvi-dcl.
              </p>
            </div>
          ) : (
            <div className="space-y-4">
              {worlds.destinations.map((d) => d.kind === 'parcels' ? (
                <ParcelDestinationCard key={d.id} destination={d} history={destinationHistory(worlds.history, d.id)} onChanged={refreshHistory} />
              ) : (
                <WorldDestinationCard
                  key={d.id}
                  destination={d}
                  history={destinationHistory(worlds.history, d.id)}
                  virviDeploys={virviDeploys}
                  offerGrant={worlds.offerGrant.has(d.id)}
                  onChanged={refreshHistory}
                  onDisconnected={disconnected}
                  canDisconnect={canDisconnectScene(scenes.find((s) => s.id === selectedSceneId)?.relationship)}
                />
              ))}
              {worlds.adoptable.map((world) => (
                <AdoptWorldCard key={world} world={world} sceneId={selectedSceneId} onAdopted={adopted} />
              ))}
            </div>
          )}
        </div>
      )}

      {selectedSceneId && <HyperfyWorlds sceneId={selectedSceneId} />}

    </div>
  )
}
