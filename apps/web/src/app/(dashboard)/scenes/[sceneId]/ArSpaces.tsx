'use client'
import { useEffect, useMemo, useRef, useState } from 'react'
import { ringMarkerSvg, type ArFloorView, type ArMarkerView, type ArSpaceView } from '@virvixr/shared'
import { useApi } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import {
  AR_DEFAULT_DIAMETER_MM, AR_MAX_DIAMETER_MM, AR_MIN_DIAMETER_MM, alignmentStatus, friendlyArError, resizeNote, shareUrl, spaceReadiness,
  type ArFileFormat, type ArMounting,
} from '@/lib/ar'

const friendly = (err: any): string => friendlyArError(err?.message)
/**
 * Runs a change, then reloads. Resolves to an error message, or null on success.
 * `lock` disables the create/delete buttons meanwhile (double-submit guard); field saves never lock, so focus and clicks survive.
 * `quiet` leaves the banner alone because the caller shows the message inline next to its field.
 */
type Run = (fn: () => Promise<unknown>, opts?: { lock?: boolean; quiet?: boolean }) => Promise<string | null>
const BLANK = 'This can\'t be blank.'

const MOUNTINGS: { value: ArMounting; label: string }[] = [
  { value: 'none', label: 'No mounting' },
  { value: 'tape', label: 'Double-sided tape' },
  { value: 'magnets', label: 'Magnets' },
  { value: 'screws', label: 'Screws' },
  { value: 'keyhole', label: 'Keyhole (hang on a screw)' },
]
const DOWNLOADS: { format: ArFileFormat; label: string }[] = [
  { format: 'pdf', label: 'Paper (PDF)' },
  { format: '3mf', label: '3MF (two colours)' },
  { format: 'stl-base', label: 'STL base' },
  { format: 'stl-raised', label: 'STL raised' },
]
const input = 'rounded-lg bg-gray-800 px-3 py-2 text-sm text-white outline-none focus:ring-2 focus:ring-blue-500'
const smallBtn = 'rounded-lg bg-gray-800 px-3 py-1.5 text-xs text-gray-200 hover:bg-gray-700 disabled:opacity-50'

/**
 * Text input that saves on blur, only when the value changed. `onSave` resolves to an error message to show inline
 * (the field then goes back to the last saved value), or nothing on success.
 */
function BlurField({ value, onSave, className = input, wrap = '', ...rest }: { value: string; onSave: (v: string) => Promise<string | null | void> | string | null | void; wrap?: string } & Omit<React.InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange'>) {
  const [v, setV] = useState(value)
  const [err, setErr] = useState<string | null>(null)
  const saved = useRef(value)
  saved.current = value
  useEffect(() => setV(value), [value])
  const commit = async () => {
    if (v === value) return
    const msg = await onSave(v)
    if (msg) { setErr(msg); setV(saved.current) } else setErr(null)
  }
  return (
    <span className={`flex flex-col ${wrap}`}>
      <input {...rest} className={className} value={v} onChange={(e) => setV(e.target.value)} onBlur={commit} />
      {err && <span className="mt-1 text-xs text-red-400">{err}</span>}
    </span>
  )
}

function MarkerCard({ marker, busy, run }: { marker: ArMarkerView; busy: boolean; run: Run }) {
  const api = useApi()
  const [mounting, setMounting] = useState<ArMounting>('none')
  const [diameter, setDiameter] = useState(String(marker.diameterMm))
  const [diameterErr, setDiameterErr] = useState<string | null>(null)
  const [resized, setResized] = useState(false)
  const [dlError, setDlError] = useState<string | null>(null)
  const svg = useMemo(() => ringMarkerSvg(marker.ringId, marker.diameterMm), [marker.ringId, marker.diameterMm])
  useEffect(() => setDiameter(String(marker.diameterMm)), [marker.diameterMm])
  const [copied, setCopied] = useState(false)
  const aligned = alignmentStatus(marker) === 'aligned'
  const link = shareUrl(marker.code)

  const saveDiameter = async () => {
    const n = Number(diameter)
    if (n === marker.diameterMm) return
    const msg = !Number.isFinite(n) || diameter.trim() === '' || n < AR_MIN_DIAMETER_MM || n > AR_MAX_DIAMETER_MM
      ? friendlyArError('bad_diameter')
      : await run(() => api.updateArMarker(marker.id, { diameterMm: n }), { quiet: true })
    setDiameterErr(msg)
    if (msg) setDiameter(String(marker.diameterMm))
    else setResized(true)
  }
  const download = async (format: ArFileFormat) => {
    setDlError(null)
    try {
      const { blob, filename } = await api.downloadArMarkerFile(marker.id, format, mounting)
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = filename
      a.click()
      setTimeout(() => URL.revokeObjectURL(url), 10_000)
    } catch (err: any) { setDlError(friendly(err)) }
  }

  return (
    <div className="rounded-lg border border-gray-800 bg-gray-950/40 p-4 flex flex-col gap-4 sm:flex-row">
      <div className="w-40 shrink-0">
        {/* Our own generator's output, never user markup */}
        <div className="rounded-lg bg-white p-2 [&>svg]:h-auto [&>svg]:w-full" dangerouslySetInnerHTML={{ __html: svg }} />
        <p className="mt-2 text-center font-mono text-xs text-gray-400">{marker.code}</p>
      </div>
      <div className="flex-1 space-y-3 text-sm">
        <div className="flex flex-wrap items-center gap-2">
          <label className="text-xs text-gray-400">Size (mm)</label>
          <input aria-label="Size (mm)" type="number" min={AR_MIN_DIAMETER_MM} max={AR_MAX_DIAMETER_MM} value={diameter} onChange={(e) => setDiameter(e.target.value)} onBlur={saveDiameter} className={`${input} w-24`} />
          {diameterErr && <span className="text-xs text-red-400">{diameterErr}</span>}
          {!diameterErr && (resized || diameter !== String(marker.diameterMm)) && <span className="text-xs text-yellow-400">{resizeNote(marker)}</span>}
          <span className={`text-xs ${aligned ? 'text-green-400' : 'text-yellow-400'}`}>{aligned ? 'Aligned' : 'Not aligned yet: align it with the Quest app'}</span>
          <button disabled={busy} onClick={() => { if (confirm('Remove this marker?')) run(() => api.deleteArMarker(marker.id), { lock: true }) }} className="ml-auto text-xs text-red-400 hover:underline">Remove</button>
        </div>
        <div>
          <label className="block text-xs text-gray-400 mb-1">Where to find it</label>
          <BlurField value={marker.whereText ?? ''} placeholder="e.g. By the lobby door, at eye height" maxLength={500} className={`${input} w-full`} wrap="w-full"
            onSave={(v) => run(() => api.updateArMarker(marker.id, { whereText: v.trim() || null }), { quiet: true })} />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-gray-400">Share link</span>
          <code className="rounded bg-gray-800 px-2 py-1 text-xs text-gray-200">{link}</code>
          <button className={smallBtn} onClick={async () => { try { await navigator.clipboard.writeText(link); setCopied(true); setTimeout(() => setCopied(false), 1500) } catch { /* clipboard unavailable */ } }}>{copied ? 'Copied' : 'Copy'}</button>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <label className="text-xs text-gray-400">Mounting (3D files)</label>
          <select aria-label="Mounting (3D files)" value={mounting} onChange={(e) => setMounting(e.target.value as ArMounting)} className="rounded-lg bg-gray-800 px-3 py-1.5 text-xs text-white">
            {MOUNTINGS.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
          </select>
        </div>
        <div className="flex flex-wrap gap-2">
          {DOWNLOADS.map((d) => <button key={d.format} className={smallBtn} onClick={() => download(d.format)}>{d.label}</button>)}
        </div>
        {dlError && <p className="text-xs text-red-400">{dlError}</p>}
        <p className="text-xs text-gray-500">Print at 100%. Change filament at 4.0 mm. Matte filament works best.</p>
        <div className="flex items-center gap-2">
          <button disabled className="rounded-lg bg-gray-800 px-3 py-1.5 text-xs text-gray-500 cursor-not-allowed">Order a printed marker</button>
          <span className="text-xs text-gray-500">Coming later</span>
        </div>
      </div>
    </div>
  )
}

function FloorCard({ floor, busy, run }: { floor: ArFloorView; busy: boolean; run: Run }) {
  const api = useApi()
  return (
    <div className="rounded-lg bg-gray-800/50 p-4 space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <BlurField value={floor.name} maxLength={200} aria-label="Floor name" onSave={(v) => v.trim() ? run(() => api.updateArFloor(floor.id, { name: v.trim() }), { quiet: true }) : BLANK} />
        <label className="text-xs text-gray-400">Height (m)</label>
        <BlurField type="number" step="0.1" value={String(floor.heightM)} aria-label="Floor height in metres" className={`${input} w-full`} wrap="w-24"
          onSave={(v) => Number.isFinite(Number(v)) && v.trim() !== '' ? run(() => api.updateArFloor(floor.id, { heightM: Number(v) }), { quiet: true }) : 'Height must be a number.'} />
        <button disabled={busy} onClick={() => { if (confirm(`Remove floor "${floor.name}" and its markers?`)) run(() => api.deleteArFloor(floor.id), { lock: true }) }} className="ml-auto text-xs text-red-400 hover:underline">Remove floor</button>
      </div>
      {floor.markers.map((m) => <MarkerCard key={m.id} marker={m} busy={busy} run={run} />)}
      <button disabled={busy} onClick={() => run(() => api.addArMarker(floor.id, { diameterMm: AR_DEFAULT_DIAMETER_MM }), { lock: true })} className={smallBtn}>+ Add marker</button>
    </div>
  )
}

function SpaceCard({ space, busy, run }: { space: ArSpaceView; busy: boolean; run: Run }) {
  const api = useApi()
  const [floorName, setFloorName] = useState('')
  const [floorHeight, setFloorHeight] = useState('0')
  const readiness = spaceReadiness(space)
  const note = readiness.ok
    ? 'Ready: every marker is aligned.'
    : `Still missing: ${readiness.missing.map((m) => (m === 'marker' ? 'a marker' : 'aligned markers')).join(' and ')}. You can publish anyway.`

  return (
    <div className="rounded-xl border border-gray-800 bg-gray-900 p-6 space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <BlurField value={space.name} maxLength={200} aria-label="Space name" onSave={(v) => v.trim() ? run(() => api.updateArSpace(space.id, { name: v.trim() }), { quiet: true }) : BLANK} />
        <BlurField value={space.place ?? ''} maxLength={500} placeholder="Place (e.g. address)" aria-label="Place" className={`${input} w-full`} wrap="flex-1 min-w-48"
          onSave={(v) => run(() => api.updateArSpace(space.id, { place: v.trim() || null }), { quiet: true })} />
        <button disabled={busy} onClick={() => { if (confirm(`Delete AR space "${space.name}"?`)) run(() => api.deleteArSpace(space.id), { lock: true }) }} className="text-xs text-red-400 hover:underline">Delete</button>
      </div>
      <div>
        <label className="flex items-center gap-2 text-sm text-gray-200">
          <input type="checkbox" role="switch" checked={space.published} onChange={(e) => run(() => api.updateArSpace(space.id, { published: e.target.checked }))} />
          Published
        </label>
        <p className={`mt-1 text-xs ${readiness.ok ? 'text-green-400' : 'text-yellow-400'}`}>{note}</p>
      </div>
      <div className="space-y-3">
        {space.floors.map((f) => <FloorCard key={f.id} floor={f} busy={busy} run={run} />)}
        <form className="flex flex-wrap items-center gap-2" onSubmit={(e) => {
          e.preventDefault()
          run(async () => { await api.addArFloor(space.id, { name: floorName.trim(), heightM: Number(floorHeight) }); setFloorName(''); setFloorHeight('0') }, { lock: true })
        }}>
          <input aria-label="New floor name" value={floorName} onChange={(e) => setFloorName(e.target.value)} placeholder="New floor name" required maxLength={200} className={input} />
          <input type="number" step="0.1" value={floorHeight} onChange={(e) => setFloorHeight(e.target.value)} required aria-label="New floor height in metres" className={`${input} w-24`} />
          <span className="text-xs text-gray-400">m</span>
          <button type="submit" disabled={busy} className={smallBtn}>+ Add floor</button>
        </form>
      </div>
    </div>
  )
}

/** The scene's AR spaces: floors, ring markers with a live preview, and print downloads. */
export function ArSpaces({ sceneId }: { sceneId: string }) {
  const { token } = useAuth()
  const api = useApi()
  const [spaces, setSpaces] = useState<ArSpaceView[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [place, setPlace] = useState('')
  const [busy, setBusy] = useState(false)

  const load = async () => {
    try { setSpaces(await api.getArSpaces(sceneId)) } catch (err: any) { setError(friendly(err)) }
  }
  // useApi() returns new functions every render; reload when the scene or session changes
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { load() }, [sceneId, token])

  const run: Run = async (fn, { lock = false, quiet = false } = {}) => {
    if (lock) setBusy(true)
    let msg: string | null = null
    try { await fn(); setError(null) } catch (err: any) { msg = friendly(err); if (!quiet) setError(msg) }
    await load()
    if (lock) setBusy(false)
    return msg
  }

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-gray-800 bg-gray-900 p-6">
        <h3 className="text-sm font-medium text-gray-300 mb-1">AR spaces</h3>
        <p className="text-xs text-gray-500 mb-4">Real places that visitors can enter with a headset. Each floor has ring markers you print and mount.</p>
        {error && <div className="mb-3 rounded-lg bg-red-900/50 border border-red-700 px-4 py-2 text-sm text-red-300">{error}</div>}
        <form className="flex flex-wrap gap-2" onSubmit={(e) => {
          e.preventDefault()
          run(async () => { await api.createArSpace(sceneId, { name: name.trim(), place: place.trim() || null }); setName(''); setPlace('') }, { lock: true })
        }}>
          <input aria-label="Space name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Space name" required maxLength={200} className={`${input} flex-1 min-w-40`} />
          <input aria-label="Place (optional)" value={place} onChange={(e) => setPlace(e.target.value)} placeholder="Place (optional)" maxLength={500} className={`${input} flex-1 min-w-40`} />
          <button type="submit" disabled={busy} className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium hover:bg-blue-700 disabled:opacity-50">Add AR space</button>
        </form>
      </div>
      {spaces?.length === 0 && <p className="text-sm text-gray-500">No AR spaces yet.</p>}
      {spaces?.map((s) => <SpaceCard key={s.id} space={s} busy={busy} run={run} />)}
    </div>
  )
}
