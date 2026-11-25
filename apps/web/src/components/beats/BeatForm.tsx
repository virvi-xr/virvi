'use client'
// The BEAT create and edit form (LIV-11): the fields of the spec's Flow 1, with each server refusal beside its field.
import { useEffect, useRef, useState } from 'react'
import dynamic from 'next/dynamic'
import {
  BEAT_DESCRIPTION_MAX, BEAT_LOCATION_MAX, BEAT_MIN_PRESENT_MAX_MINUTES, BEAT_NAME_MAX, BEAT_PIN_RADIUS, BEAT_SUPPLY_CAP_MAX, type PublicBeat,
} from '@virvixr/shared'
import { useApi } from '@/lib/api'
import {
  BEAT_IMAGE_HINT, FIELD_IDS, HOLD_HINT, HOLD_LABEL, LOCATION_SCENE_ONLY, LOCATION_TYPE_LABELS, MINUTES_HINT, PAID_SUPPLY_HINT, SUPPLY_HINT,
  TRADEABLE_HINT, beatFormError, fieldsOfPatch, shownFieldError,
  type BeatField, type BeatInput, type BeatLocationType, type FieldError, type LocationInput,
} from '@/lib/beats'
import { MediaPicker } from '@/components/MediaPicker'
import { PIN_COPY, clampRadius, shouldAutoSuggest, type LatLng } from '@/lib/venue-pin'

// Leaflet reads `window`, so the map is client-only (the site is a static export)
const VenuePin = dynamic(() => import('./VenuePin'), { ssr: false, loading: () => <div className="h-64 w-full rounded-md border border-gray-800 bg-gray-950" /> })

const INPUT = 'rounded-md bg-gray-950 px-3 py-2 text-sm text-white outline-none border border-gray-800 focus:border-blue-400 disabled:opacity-60 aria-[invalid=true]:border-red-500'
const LABEL = 'block text-xs text-gray-400'
const HINT = 'mt-1 text-xs text-gray-400'

type SceneOption = { id: string; name: string }

const errId = (field: BeatField) => `${FIELD_IDS[field as keyof typeof FIELD_IDS] ?? 'beat-form'}-error`

/** The refusal for one field, outside its label, so it isn't read out as part of the field's name (plain-ux I13). */
function FieldNote({ error, field }: { error: FieldError | null; field: BeatField }) {
  if (!error || error.field !== field) return null
  return <p id={errId(field)} role="alert" className="mt-1 text-xs text-red-400">{error.message}</p>
}

/** A number input that keeps what is typed (an empty box stays empty) and gives the number on each change. */
function NumberInput({ id, value, min, max, disabled, invalid, describedBy, onChange }: {
  id: string; value: number; min: number; max: number; disabled?: boolean; invalid: boolean; describedBy?: string; onChange: (n: number) => void
}) {
  const [text, setText] = useState(Number.isFinite(value) ? String(value) : '')
  useEffect(() => { if (Number(text) !== value && Number.isFinite(value)) setText(String(value)) }, [value]) // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <input id={id} type="number" min={min} max={max} className={`${INPUT} mt-1 block w-28`} value={text} disabled={disabled}
      aria-invalid={invalid} aria-describedby={describedBy}
      onChange={(e) => { setText(e.target.value); onChange(e.target.value === '' ? Number.NaN : Number(e.target.value)) }} />
  )
}

/**
 * `editing`: the BEAT being changed (a paid one keeps its supply; one that has started is never edited here, as Edit
 * isn't offered). `error` is the last refusal, shown beside its field until that field is edited; `submitLabel` names
 * the button, and `busyLabel` replaces it while it works.
 */
export function BeatForm({ initial, editing, error, busy, submitLabel, busyLabel, onSubmit, onCancel }: {
  initial: BeatInput
  editing?: PublicBeat
  error: FieldError | null
  busy: boolean
  submitLabel: string
  busyLabel?: string
  onSubmit: (f: BeatInput) => void
  onCancel?: () => void
}) {
  const api = useApi()
  const formRef = useRef<HTMLFormElement>(null)
  const [f, setF] = useState<BeatInput>(initial)
  const [local, setLocal] = useState<FieldError | null>(null)
  const [picking, setPicking] = useState(false)
  const [fileName, setFileName] = useState<string | null>(null)
  const [scenes, setScenes] = useState<SceneOption[] | null>(null)
  // The fields edited since the last server refusal: its message goes once its own field changes
  const [edited, setEdited] = useState<ReadonlySet<BeatField>>(new Set())
  useEffect(() => { setEdited(new Set()) }, [error])
  const set = (patch: Partial<BeatInput>) => {
    setLocal(null)
    setEdited((cur) => new Set([...cur, ...fieldsOfPatch(patch)]))
    setF((cur) => ({ ...cur, ...patch }))
  }
  // Merges into the latest location, so a suggestion that arrives after more typing keeps it; like `set`, it clears a stale location error
  const setLoc = (patch: Partial<LocationInput>) => {
    setLocal(null)
    setEdited((cur) => new Set([...cur, ...fieldsOfPatch({ location: f.location })]))
    setF((cur) => ({ ...cur, location: { ...cur.location, ...patch } }))
  }

  // Venue pin: suggested from the address at most once on its own (when the address first becomes complete, checked as a
  // field is left, not on every key), and never over a pin the host placed. The button suggests again on request.
  const [pinNote, setPinNote] = useState<'suggested' | 'failed' | string | null>(null)
  const [suggesting, setSuggesting] = useState(false)
  const suggestedOnce = useRef(false)
  const checkedLoc = useRef(initial.location)
  const pinRef = useRef<LatLng | null>(f.location.pin)
  pinRef.current = f.location.pin
  const suggestPin = async (loc: LocationInput, auto: boolean) => {
    const venue = loc.venue.trim(), address = loc.address.trim()
    if (!venue && !address) { if (!auto) setPinNote('failed'); return }
    if (auto) suggestedOnce.current = true
    setSuggesting(true)
    try {
      const r = await api.suggestBeatPin({ ...(venue ? { venue } : {}), ...(address ? { address } : {}), ...(loc.city.trim() ? { city: loc.city.trim() } : {}), country: loc.country.trim() })
      if (r.pin && !(auto && pinRef.current)) {
        setLoc({ pin: r.pin })
        setPinNote('suggested')
      } else if (!r.pin && !(auto && pinRef.current)) setPinNote('failed')
    } catch (err) {
      if (auto && pinRef.current) { setSuggesting(false); return }
      setPinNote((err as { status?: number }).status === 429 ? (err as Error).message : 'failed')
    }
    setSuggesting(false)
  }
  const onAddressBlur = () => {
    const next = f.location
    if (shouldAutoSuggest(checkedLoc.current, next, suggestedOnce.current)) void suggestPin(next, true)
    checkedLoc.current = next
  }
  const placePin = (p: LatLng) => { setLoc({ pin: p }); setPinNote(null) }

  useEffect(() => {
    let live = true
    api.getScenes()
      .then((r) => { if (live) setScenes((r.scenes ?? []).filter((s: any) => s.relationship !== 'org_admin').map((s: any) => ({ id: s.id, name: s.name }))) })
      .catch(() => { if (live) setScenes([]) })
    return () => { live = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const paid = !!editing && editing.status !== 'draft'
  const shown = local ?? shownFieldError(error, edited)
  // A refusal moves focus to its field (or the form's message), so a keyboard user lands on what to fix
  useEffect(() => {
    if (!shown) return
    const id = shown.field === 'form' || shown.field === 'pay' ? 'beat-form-error' : FIELD_IDS[shown.field]
    const el = formRef.current?.querySelector<HTMLElement>(`#${id}`)
    el?.focus()
  }, [shown])
  const bad = (field: BeatField) => shown?.field === field
  const aria = (field: BeatField, hint?: string) => ({
    'aria-invalid': bad(field), 'aria-describedby': [hint, bad(field) ? errId(field) : null].filter(Boolean).join(' ') || undefined,
  })

  // A scene picked before the list loads (the scene page's link), or one the host can't open from here, still shows
  const options: SceneOption[] = [
    ...(scenes ?? []),
    ...f.sceneIds.filter((id) => !scenes?.some((s) => s.id === id)).map((id) => ({ id, name: scenes ? 'A scene you picked' : 'Loading…' })),
  ]

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    const why = beatFormError(f, { editing: !!editing })
    if (why) { setLocal(why); return }
    onSubmit(f)
  }
  const toggleScene = (id: string) => set({ sceneIds: f.sceneIds.includes(id) ? f.sceneIds.filter((s) => s !== id) : [...f.sceneIds, id] })
  const M = BEAT_LOCATION_MAX

  return (
    <form ref={formRef} onSubmit={submit} noValidate className="space-y-5 rounded-lg border border-gray-800 bg-gray-900 p-6">
      {shown && (shown.field === 'form' || shown.field === 'pay') && (
        <div id="beat-form-error" tabIndex={-1} role="alert" className="rounded-md border border-red-700 bg-red-900/50 px-4 py-2 text-sm text-red-300">{shown.message}</div>
      )}

      <div>
        <label htmlFor="beat-name" className={LABEL}>Name</label>
        <input id="beat-name" className={`${INPUT} mt-1 w-full`} value={f.name} maxLength={BEAT_NAME_MAX} {...aria('name')} onChange={(e) => set({ name: e.target.value })} />
        <FieldNote error={shown} field="name" />
      </div>

      <div>
        <label htmlFor="beat-description" className={LABEL}>Description</label>
        <textarea id="beat-description" className={`${INPUT} mt-1 w-full`} rows={3} value={f.description} maxLength={BEAT_DESCRIPTION_MAX}
          {...aria('description', 'beat-description-hint')} onChange={(e) => set({ description: e.target.value })} />
        <p id="beat-description-hint" className={HINT}>It's public once the BEAT starts, and stays with the token. Don't put anyone's personal details in it.</p>
        <FieldNote error={shown} field="description" />
      </div>

      <div>
        <span id="beat-image-label" className={LABEL}>Artwork</span>
        <div className="mt-1 flex items-center gap-4">
          {f.imageUrl
            ? <img src={f.imageUrl} alt="Selected artwork" className="h-20 w-20 rounded-md border border-gray-800 object-cover" />
            : <div className="h-20 w-20 rounded-md border border-dashed border-gray-700" />}
          <div>
            <button id="beat-image" type="button" onClick={() => setPicking(true)} aria-labelledby="beat-image-label beat-image" {...aria('image', 'beat-image-hint')}
              className="rounded-md bg-gray-800 px-3 py-1.5 text-sm text-gray-300 hover:bg-gray-700 disabled:opacity-50">
              {f.imageUrl ? 'Change image' : 'Pick image'}
            </button>
            {fileName && <p className="mt-1 text-xs text-gray-300">{fileName}</p>}
            <p id="beat-image-hint" className={HINT}>{BEAT_IMAGE_HINT}</p>
          </div>
        </div>
        <FieldNote error={shown} field="image" />
        {picking && (
          <MediaPicker api={api} accept="image/png,image/jpeg,image/webp" onClose={() => setPicking(false)}
            onSelect={(url, asset) => { set({ imageMediaId: asset.id, imageUrl: url }); setFileName((asset as { filename?: string }).filename ?? null); setPicking(false) }} />
        )}
      </div>

      <div>
        <div className="flex flex-wrap gap-4">
          <div>
            <label htmlFor="beat-starts" className={LABEL}>Starts</label>
            <input id="beat-starts" type="datetime-local" className={`${INPUT} mt-1 block`} value={f.startsAt} {...aria('window')} onChange={(e) => set({ startsAt: e.target.value })} />
          </div>
          <div>
            <label htmlFor="beat-ends" className={LABEL}>Ends</label>
            <input id="beat-ends" type="datetime-local" className={`${INPUT} mt-1 block`} value={f.endsAt} {...aria('window')} onChange={(e) => set({ endsAt: e.target.value })} />
          </div>
          <div>
            <label htmlFor="beat-minutes" className={LABEL}>Minimum minutes present</label>
            <NumberInput id="beat-minutes" min={0} max={BEAT_MIN_PRESENT_MAX_MINUTES} value={f.minPresentMinutes} invalid={bad('minutes')}
              describedBy={['beat-minutes-hint', bad('minutes') ? errId('minutes') : ''].filter(Boolean).join(' ')} onChange={(n) => set({ minPresentMinutes: n })} />
          </div>
        </div>
        <p id="beat-minutes-hint" className={HINT}>{MINUTES_HINT}</p>
        <FieldNote error={shown} field="window" />
        <FieldNote error={shown} field="minutes" />
      </div>

      <fieldset id="beat-scenes" tabIndex={-1} aria-invalid={bad('scenes')} aria-describedby={bad('scenes') ? errId('scenes') : undefined}>
        <legend className={LABEL}>Scenes</legend>
        {scenes === null && f.sceneIds.length === 0 ? <p className="mt-1 text-sm text-gray-400">Loading…</p>
          : options.length === 0 ? <p className="mt-1 text-sm text-gray-400">You have no scenes yet.</p> : (
            <div className="mt-1 flex flex-wrap gap-x-5 gap-y-2">
              {options.map((s) => (
                <label key={s.id} className="inline-flex items-center gap-2 text-sm text-gray-200">
                  <input type="checkbox" checked={f.sceneIds.includes(s.id)} onChange={() => toggleScene(s.id)} />
                  {s.name}
                </label>
              ))}
            </div>
          )}
        <FieldNote error={shown} field="scenes" />
      </fieldset>

      <fieldset id="beat-location" tabIndex={-1} aria-describedby={bad('location') ? errId('location') : undefined} className="space-y-3">
        <legend className="text-sm font-medium text-gray-300">Where is it?</legend>
        <div className="flex flex-wrap gap-x-5 gap-y-2">
          {(Object.keys(LOCATION_TYPE_LABELS) as BeatLocationType[]).map((t) => (
            <label key={t} className="inline-flex items-center gap-2 text-sm text-gray-200">
              <input type="radio" name="beat-location-type" checked={f.location.type === t} onChange={() => setLoc({ type: t })} />
              {LOCATION_TYPE_LABELS[t]}
            </label>
          ))}
        </div>
        {f.location.type === 'scene' && <p className={HINT}>The token names your scene, with its World name or coordinates.</p>}
        {f.location.type === 'online' && (
          <div className="flex flex-wrap gap-4">
            <div>
              <label htmlFor="beat-loc-platform" className={LABEL}>Platform name</label>
              <input id="beat-loc-platform" className={`${INPUT} mt-1 block w-56`} maxLength={M.platform} value={f.location.platform} aria-invalid={bad('location')} onChange={(e) => setLoc({ platform: e.target.value })} />
            </div>
            <div className="min-w-0 flex-1">
              <label htmlFor="beat-loc-url" className={LABEL}>Event link</label>
              <input id="beat-loc-url" type="url" placeholder="https://" className={`${INPUT} mt-1 block w-full`} maxLength={M.url} value={f.location.url} aria-invalid={bad('location')} onChange={(e) => setLoc({ url: e.target.value })} />
            </div>
          </div>
        )}
        {f.location.type === 'in_person' && (
          <div className="grid gap-4 sm:grid-cols-2">
            {([
              ['venue', 'Venue name', M.venue, false], ['address', 'Street address (optional)', M.address, false],
              ['city', 'City or region', M.city, false], ['country', 'Country', M.country, false], ['mapUrl', 'Map link (optional)', M.mapUrl, true],
            ] as const).map(([k, label, max, url]) => (
              <div key={k}>
                <label htmlFor={`beat-loc-${k}`} className={LABEL}>{label}</label>
                <input id={`beat-loc-${k}`} type={url ? 'url' : 'text'} placeholder={url ? 'https://' : undefined} className={`${INPUT} mt-1 block w-full`} maxLength={max}
                  value={f.location[k]} aria-invalid={bad('location')} onBlur={onAddressBlur} onChange={(e) => setLoc({ [k]: e.target.value } as Partial<LocationInput>)} />
              </div>
            ))}
          </div>
        )}
        {f.location.type === 'in_person' && (
          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-3">
              <button type="button" onClick={() => void suggestPin(f.location, false)} disabled={suggesting}
                className="rounded-md bg-gray-800 px-3 py-1.5 text-sm text-gray-300 hover:bg-gray-700 disabled:opacity-50">{PIN_COPY.button}</button>
              {f.location.pin && (
                <button type="button" onClick={() => { setLoc({ pin: null }); setPinNote(null) }}
                  className="rounded-md bg-gray-800 px-3 py-1.5 text-sm text-gray-300 hover:bg-gray-700">{PIN_COPY.clear}</button>
              )}
              <div>
                <label htmlFor="beat-pin-radius" className={LABEL}>Radius (metres)</label>
                <NumberInput id="beat-pin-radius" min={BEAT_PIN_RADIUS.minM} max={BEAT_PIN_RADIUS.maxM} value={f.location.radiusM} invalid={false}
                  describedBy="beat-pin-radius-hint" onChange={(n) => setLoc({ radiusM: n })} />
              </div>
            </div>
            <p id="beat-pin-radius-hint" className={HINT}>Visitors must be within this distance of the pin, from {BEAT_PIN_RADIUS.minM} to {BEAT_PIN_RADIUS.maxM} metres.</p>
            <p id="beat-pin-optional-hint" className={HINT}>{PIN_COPY.optional}</p>
            <p role="status" className={pinNote && pinNote !== 'suggested' ? 'text-xs text-amber-300' : HINT}>
              {pinNote === 'suggested' ? PIN_COPY.suggested : pinNote === 'failed' ? PIN_COPY.failed : (pinNote ?? '')}
            </p>
            <VenuePin pin={f.location.pin} radiusM={clampRadius(f.location.radiusM)} onPin={placePin} />
          </div>
        )}
        {f.location.type === 'online' && <p role="note" className="rounded-md border border-gray-700 bg-gray-950 px-3 py-2 text-sm text-gray-300">{LOCATION_SCENE_ONLY}</p>}
        <FieldNote error={shown} field="location" />
      </fieldset>

      <div className="space-y-3">
        <div>
          <label htmlFor="beat-cap" className={LABEL}>Supply cap</label>
          <NumberInput id="beat-cap" min={1} max={BEAT_SUPPLY_CAP_MAX} value={f.supplyCap} disabled={paid} invalid={bad('cap')}
            describedBy={['beat-cap-hint', bad('cap') ? errId('cap') : ''].filter(Boolean).join(' ')} onChange={(n) => set({ supplyCap: n })} />
          <p id="beat-cap-hint" className={HINT}>{paid ? PAID_SUPPLY_HINT : SUPPLY_HINT}</p>
          <FieldNote error={shown} field="cap" />
        </div>
        <div>
          <label className="inline-flex items-center gap-2 text-sm text-gray-200">
            <input type="checkbox" checked={f.tradeable} aria-describedby="beat-tradeable-hint" onChange={(e) => set({ tradeable: e.target.checked })} />
            Tradeable
          </label>
          <p id="beat-tradeable-hint" className={HINT}>{TRADEABLE_HINT}</p>
        </div>
        <div>
          <label className="inline-flex items-center gap-2 text-sm text-gray-200">
            <input type="checkbox" checked={f.holdMints} aria-describedby="beat-hold-hint" onChange={(e) => set({ holdMints: e.target.checked })} />
            {HOLD_LABEL}
          </label>
          <p id="beat-hold-hint" className={HINT}>{HOLD_HINT}</p>
        </div>
      </div>

      <div className="flex gap-2">
        <button type="submit" disabled={busy} className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-50">{busy && busyLabel ? busyLabel : submitLabel}</button>
        {onCancel && <button type="button" onClick={onCancel} className="rounded-md bg-gray-800 px-4 py-2 text-sm text-gray-300 hover:bg-gray-700">Back</button>}
      </div>
    </form>
  )
}
