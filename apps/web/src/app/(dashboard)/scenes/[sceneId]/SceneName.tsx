'use client'
// The scene's name, editable in place, and "Use the new name everywhere?": carrying a new name to the
// scene's Decentraland Worlds (a redeploy), Hyperfy worlds and AR spaces.
import { useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import type { ArSpaceView, HyperfyWorldSummary } from '@virvixr/shared'
import { useApi, type DclDestination } from '@/lib/api'
import { defaultTicked, namesDiffer, renameError, sceneNameError, SCENE_NAME_MAX } from '@/lib/scene-rename'
import { PencilIcon } from '@/components/icons'
import { useWorldSigning } from '@/components/dcl/useWorldSigning'
import { destinationLocation } from '@/lib/deploy'
import { placeLabel } from '@/lib/import'
import { ROOM_LAYOUT_NOTICE } from '@/lib/room-set'

// ---------------------------------------------------------------------------
// Editable title
// ---------------------------------------------------------------------------

/** The page title with a pencil: Enter saves, Esc cancels, a blank name isn't saved. */
export function EditableSceneTitle({ name, onSave }: { name: string; onSave: (name: string) => Promise<void> }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(name)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const cancel = () => { setEditing(false); setError(null) }
  const save = async () => {
    const problem = sceneNameError(draft)
    if (problem) return setError(problem)
    const next = draft.trim()
    if (next === name) return cancel()
    setSaving(true)
    setError(null)
    try {
      await onSave(next)
      setEditing(false)
    } catch (err) {
      setError(renameError(err))
    } finally {
      setSaving(false)
    }
  }

  if (!editing) {
    return (
      <span className="group inline-flex items-center gap-2">
        {name}
        <button type="button" onClick={() => { setDraft(name); setEditing(true) }} aria-label="Rename scene" title="Rename scene"
          className="text-gray-500 hover:text-white focus:text-white">
          <PencilIcon size={18} />
        </button>
      </span>
    )
  }
  return (
    <form onSubmit={(e) => { e.preventDefault(); save() }} className="flex flex-wrap items-center gap-2 text-base font-normal tracking-normal">
      <input value={draft} onChange={(e) => { setDraft(e.target.value); setError(null) }} autoFocus maxLength={SCENE_NAME_MAX}
        onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); cancel() } }}
        aria-label="Scene name" placeholder="Name your scene" disabled={saving}
        className="min-w-0 flex-1 rounded-md border border-gray-800 bg-gray-950 px-3 py-1.5 text-2xl font-bold text-white outline-none focus:border-blue-400 md:min-w-[24rem]" />
      <button type="submit" disabled={saving || !draft.trim()} className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium hover:bg-blue-700 disabled:opacity-50">
        {saving ? 'Saving…' : 'Save'}
      </button>
      <button type="button" onClick={cancel} disabled={saving} className="rounded-md bg-gray-800 px-3 py-1.5 text-sm hover:bg-gray-700">Cancel</button>
      {error && <p className="w-full text-sm text-red-400" role="alert">{error}</p>}
    </form>
  )
}

// ---------------------------------------------------------------------------
// What's connected to the scene
// ---------------------------------------------------------------------------

export interface Connected {
  dcl: DclDestination[]
  hyperfy: HyperfyWorldSummary[]
  ar: ArSpaceView[]
}

/** The scene's Worlds, Hyperfy worlds and AR spaces. A list the caller may not see (e.g. Hyperfy for an editor) is empty.
 *  `enabled` false (a trial: all three are account-only) fetches nothing and shows nothing connected. */
export function useConnected(sceneId: string, enabled = true) {
  const api = useApi()
  const [connected, setConnected] = useState<Connected | null>(null)
  const reload = useCallback(async () => {
    if (!enabled) { setConnected({ dcl: [], hyperfy: [], ar: [] }); return }
    const [dcl, hyperfy, ar] = await Promise.all([
      api.getSceneDclDestinations(sceneId).then((r) => r.destinations).catch(() => []),
      api.getHyperfyWorlds(sceneId).then((r) => r.worlds).catch(() => []),
      api.getArSpaces(sceneId).catch(() => []),
    ])
    setConnected({ dcl, hyperfy, ar })
  }, [sceneId, enabled, api.getSceneDclDestinations, api.getHyperfyWorlds, api.getArSpaces])
  useEffect(() => { reload() }, [reload])
  return { connected, reload }
}

export const hasConnected = (c: Connected | null) => !!c && c.dcl.length + c.hyperfy.length + c.ar.length > 0
/** Whether a Hyperfy world or AR space is called something other than the scene (a World's title can't be read back). */
export const connectedNamesDiffer = (c: Connected | null, sceneName: string) =>
  !!c && namesDiffer(sceneName, [...c.hyperfy.map((w) => w.name), ...c.ar.map((s) => s.name)])

// ---------------------------------------------------------------------------
// "Use the new name everywhere?"
// ---------------------------------------------------------------------------

type Result = { status: 'working' } | { status: 'done' } | { status: 'failed'; message: string }
type Deployer = () => Promise<{ ok: true } | { ok: false; message: string }>

/** A World can be redeployed from here when its owner signs (sign mode) or Virvi holds the permission. An adopted
 *  World's title is its own scene.json's, so a redeploy can't change it. */
const canRedeploy = (d: DclDestination) => !d.adopted && (d.mode === 'sign' || !!d.grantedAt)

export function UseNameEverywhere({ sceneName, oldName, connected, hasRoomSet = false, onDone, onClose }: {
  sceneName: string
  /** The name before the rename this visit; null when reopened with nothing to compare against. */
  oldName: string | null
  connected: Connected
  /** The scene holds a room set: a World redeploy shows the room's layout, which the panel says once. */
  hasRoomSet?: boolean
  /** Something was renamed or redeployed: the page reloads what's connected. */
  onDone: () => void
  onClose: () => void
}) {
  const api = useApi()
  // Ticks are set once per panel opening, from the names as they were then.
  const [ticked, setTicked] = useState<Record<string, boolean>>(() => {
    const t: Record<string, boolean> = {}
    for (const d of connected.dcl) t[`dcl:${d.id}`] = oldName !== null && canRedeploy(d)
    for (const w of connected.hyperfy) t[`hyperfy:${w.id}`] = defaultTicked(w.name, oldName, sceneName)
    for (const s of connected.ar) t[`ar:${s.id}`] = defaultTicked(s.name, oldName, sceneName)
    return t
  })
  const [results, setResults] = useState<Record<string, Result>>({})
  const [running, setRunning] = useState(false)
  const [finished, setFinished] = useState(false)
  const deployers = useRef<Record<string, Deployer>>({})

  const set = (key: string, r: Result) => setResults((prev) => ({ ...prev, [key]: r }))
  const toggle = (key: string) => setTicked((t) => ({ ...t, [key]: !t[key] }))
  const chosen = Object.keys(ticked).filter((k) => ticked[k])

  const apply = async () => {
    setRunning(true)
    setResults({})
    const rename = async (key: string, fn: () => Promise<unknown>) => {
      set(key, { status: 'working' })
      try {
        await fn()
        set(key, { status: 'done' })
      } catch (err) {
        set(key, { status: 'failed', message: renameError(err) })
      }
    }
    await Promise.all([
      ...connected.hyperfy.filter((w) => ticked[`hyperfy:${w.id}`]).map((w) => rename(`hyperfy:${w.id}`, () => api.renameHyperfyWorld(w.id, sceneName))),
      ...connected.ar.filter((s) => ticked[`ar:${s.id}`]).map((s) => rename(`ar:${s.id}`, () => api.updateArSpace(s.id, { name: sceneName }))),
    ])
    // One World at a time: each may ask the wallet to sign.
    for (const d of connected.dcl) {
      const key = `dcl:${d.id}`
      const deploy = deployers.current[d.id]
      if (!ticked[key] || !deploy) continue
      set(key, { status: 'working' })
      const r = await deploy()
      set(key, r.ok ? { status: 'done' } : { status: 'failed', message: r.message })
    }
    setRunning(false)
    setFinished(true)
    onDone()
  }

  return (
    <section aria-labelledby="use-name-heading" className="space-y-4 rounded-lg border border-blue-500/40 bg-gray-900 p-5 text-sm">
      <div>
        <h2 id="use-name-heading" className="text-base font-semibold text-white">Use the new name everywhere?</h2>
        <p className="mt-1 text-gray-400">
          {oldName !== null ? <>The scene is now called &ldquo;{sceneName}&rdquo; (it was &ldquo;{oldName}&rdquo;). </> : null}
          Pick what should be called &ldquo;{sceneName}&rdquo; too. Addresses and links stay as they are.
        </p>
      </div>
      {hasRoomSet && connected.dcl.length > 0 && (
        <p className="rounded-md border border-yellow-700/60 bg-yellow-950/30 px-3 py-2 text-yellow-100">{ROOM_LAYOUT_NOTICE}</p>
      )}
      <ul className="space-y-2">
        {connected.dcl.map((d) => (
          <DclRow key={d.id} dest={d} checked={!!ticked[`dcl:${d.id}`]} onToggle={() => toggle(`dcl:${d.id}`)} disabled={running || finished}
            result={results[`dcl:${d.id}`]} register={(fn) => { deployers.current[d.id] = fn }} />
        ))}
        {connected.hyperfy.map((w) => (
          <NameRow key={w.id} kind="Hyperfy world" current={w.name} newName={sceneName} checked={!!ticked[`hyperfy:${w.id}`]}
            onToggle={() => toggle(`hyperfy:${w.id}`)} disabled={running || finished} result={results[`hyperfy:${w.id}`]} />
        ))}
        {connected.ar.map((s) => (
          <NameRow key={s.id} kind="AR space" current={s.name} newName={sceneName} checked={!!ticked[`ar:${s.id}`]}
            onToggle={() => toggle(`ar:${s.id}`)} disabled={running || finished} result={results[`ar:${s.id}`]} />
        ))}
      </ul>
      <div className="flex flex-wrap gap-2">
        {finished ? (
          <button type="button" onClick={onClose} className="rounded-md bg-gray-800 px-3 py-1.5 hover:bg-gray-700">Close</button>
        ) : (
          <>
            <button type="button" onClick={apply} disabled={running || chosen.length === 0}
              className="rounded-md bg-blue-600 px-3 py-1.5 font-medium text-white hover:bg-blue-700 disabled:opacity-50">
              {running ? 'Updating…' : 'Update selected'}
            </button>
            <button type="button" onClick={onClose} disabled={running} className="rounded-md bg-gray-800 px-3 py-1.5 hover:bg-gray-700 disabled:opacity-50">Not now</button>
          </>
        )}
      </div>
    </section>
  )
}

function ResultLine({ result }: { result?: Result }) {
  if (!result) return null
  if (result.status === 'working') return <span className="text-gray-400">Working…</span>
  if (result.status === 'done') return <span className="text-green-300">Done</span>
  return <span className="text-red-300" role="alert">Failed: {result.message}</span>
}

function NameRow({ kind, current, newName, checked, onToggle, disabled, result }: {
  kind: string; current: string; newName: string; checked: boolean; onToggle: () => void; disabled: boolean; result?: Result
}) {
  const same = current.trim() === newName.trim()
  return (
    <li className="flex flex-wrap items-start justify-between gap-2 rounded-md border border-gray-800 bg-gray-950 px-3 py-2.5">
      <label className={`flex gap-2 ${same ? 'text-gray-500' : 'text-gray-200'}`}>
        <input type="checkbox" className="mt-0.5" checked={checked} onChange={onToggle} disabled={disabled || same} />
        <span>
          <span className="block">{same ? `Already called ${newName}` : `Rename to ${newName}`}</span>
          <span className="block text-xs text-gray-500">{kind} &ldquo;{current}&rdquo;</span>
        </span>
      </label>
      <ResultLine result={result} />
    </li>
  )
}

/** A World row: ticking it runs the deploy card's own Redeploy now (the owner's wallet signs in sign mode). */
function DclRow({ dest, checked, onToggle, disabled, result, register }: {
  dest: DclDestination; checked: boolean; onToggle: () => void; disabled: boolean; result?: Result; register: (fn: Deployer) => void
}) {
  const signing = useWorldSigning(dest)
  const latest = useRef(signing)
  latest.current = signing
  register(async () => {
    const ok = await latest.current.deploy()
    return ok ? { ok: true } : { ok: false, message: 'The redeploy did not finish.' }
  })
  // The hook keeps the reason a deploy failed; show it rather than the generic line.
  const shown: Result | undefined = result?.status === 'failed' && signing.view.error ? { status: 'failed', message: signing.view.error } : result
  const available = canRedeploy(dest)
  // A World by its name; Genesis City parcels (no World name) by their place
  const place = placeLabel(destinationLocation(dest))

  return (
    <li className="flex flex-wrap items-start justify-between gap-2 rounded-md border border-gray-800 bg-gray-950 px-3 py-2.5">
      <label className={`flex gap-2 ${available ? 'text-gray-200' : 'text-gray-500'}`}>
        <input type="checkbox" className="mt-0.5" checked={checked} onChange={onToggle} disabled={disabled || !available} />
        <span>
          <span className="block">Redeploy {place} so Decentraland shows the new name</span>
          <span className="block text-xs text-gray-500">
            {dest.adopted ? (
              'Its name comes from your own project: change the title in its scene.json and deploy it from Creator Hub.'
            ) : !available ? (
              <>Virvi&apos;s permission isn&apos;t signed yet. <Link href={`/deploy?scene=${dest.sceneId}`} className="text-blue-400 hover:text-blue-300">Open Deploy</Link></>
            ) : dest.mode === 'sign' ? 'You sign with the wallet that owns it.' : 'Virvi deploys it for you.'}
          </span>
        </span>
      </label>
      <span className="text-right">
        {signing.asking ? <span className="text-blue-200" role="status">Check your wallet: sign once with the wallet that {dest.kind === 'parcels' ? 'owns or operates these parcels' : `owns ${place}`}.</span> : <ResultLine result={shown} />}
      </span>
    </li>
  )
}
