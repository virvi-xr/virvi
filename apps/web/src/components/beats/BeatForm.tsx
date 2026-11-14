'use client'
// The BEAT create and edit form (LIV-11): the fields of the spec's Flow 1, with each server refusal beside its field.
import { useEffect, useState } from 'react'
import {
  BEAT_DESCRIPTION_MAX, BEAT_MIN_PRESENT_MAX_MINUTES, BEAT_NAME_MAX, BEAT_SUPPLY_CAP_MAX, type PublicBeat,
} from '@virvixr/shared'
import { useApi } from '@/lib/api'
import { BEAT_FROZEN_NOTE, BEAT_IMAGE_HINT, beatFormError, type BeatField, type BeatInput, type FieldError } from '@/lib/beats'
import { MediaPicker } from '@/components/MediaPicker'

const INPUT = 'rounded-md bg-gray-950 px-3 py-2 text-sm text-white outline-none border border-gray-800 focus:border-blue-400 disabled:opacity-60'
const LABEL = 'block text-xs text-gray-400'

type SceneOption = { id: string; name: string }

function FieldNote({ error, field }: { error: FieldError | null; field: BeatField }) {
  if (!error || error.field !== field) return null
  return <p role="alert" className="mt-1 text-xs text-red-400">{error.message}</p>
}

/**
 * `editing`: the BEAT being changed (a paid one keeps its supply and tradeable; a frozen one its name, description and
 * artwork). `error` is the last refusal, shown beside its field; `submitLabel` names the button.
 */
export function BeatForm({ initial, editing, error, busy, submitLabel, onSubmit, onCancel }: {
  initial: BeatInput
  editing?: PublicBeat
  error: FieldError | null
  busy: boolean
  submitLabel: string
  onSubmit: (f: BeatInput) => void
  onCancel?: () => void
}) {
  const api = useApi()
  const [f, setF] = useState<BeatInput>(initial)
  const [local, setLocal] = useState<FieldError | null>(null)
  const [picking, setPicking] = useState(false)
  const [scenes, setScenes] = useState<SceneOption[] | null>(null)
  const set = (patch: Partial<BeatInput>) => { setLocal(null); setF((cur) => ({ ...cur, ...patch })) }

  useEffect(() => {
    let live = true
    api.getScenes()
      .then((r) => { if (live) setScenes((r.scenes ?? []).filter((s: any) => s.relationship !== 'org_admin').map((s: any) => ({ id: s.id, name: s.name }))) })
      .catch(() => { if (live) setScenes([]) })
    return () => { live = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const paid = !!editing && editing.status !== 'draft'
  const frozen = !!editing?.frozen
  const shown = local ?? error
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

  return (
    <form onSubmit={submit} className="space-y-5 rounded-lg border border-gray-800 bg-gray-900 p-6">
      {shown?.field === 'form' && <div role="alert" className="rounded-md border border-red-700 bg-red-900/50 px-4 py-2 text-sm text-red-300">{shown.message}</div>}
      {frozen && <p className="text-sm text-gray-400">{BEAT_FROZEN_NOTE}</p>}

      <label className={LABEL}>Name
        <input className={`${INPUT} mt-1 w-full`} value={f.name} maxLength={BEAT_NAME_MAX} disabled={frozen} onChange={(e) => set({ name: e.target.value })} />
        <FieldNote error={shown} field="name" />
      </label>

      <label className={LABEL}>Description
        <textarea className={`${INPUT} mt-1 w-full`} rows={3} value={f.description} maxLength={BEAT_DESCRIPTION_MAX} disabled={frozen}
          onChange={(e) => set({ description: e.target.value })} />
        <FieldNote error={shown} field="description" />
      </label>

      <div>
        <span className={LABEL}>Artwork</span>
        <div className="mt-1 flex items-center gap-4">
          {f.imageUrl
            ? <img src={f.imageUrl} alt="" className="h-20 w-20 rounded-md border border-gray-800 object-cover" />
            : <div className="h-20 w-20 rounded-md border border-dashed border-gray-700" />}
          <div>
            <button type="button" disabled={frozen} onClick={() => setPicking(true)}
              className="rounded-md bg-gray-800 px-3 py-1.5 text-sm text-gray-300 hover:bg-gray-700 disabled:opacity-50">
              {f.imageUrl ? 'Change image' : 'Pick image'}
            </button>
            <p className="mt-1 text-xs text-gray-500">{BEAT_IMAGE_HINT}</p>
          </div>
        </div>
        <FieldNote error={shown} field="image" />
        {picking && (
          <MediaPicker api={api} accept="image/png,image/jpeg,image/webp" onClose={() => setPicking(false)}
            onSelect={(url, asset) => { set({ imageMediaId: asset.id, imageUrl: url }); setPicking(false) }} />
        )}
      </div>

      <div>
        <div className="flex flex-wrap gap-4">
          <label className={LABEL}>Starts
            <input type="datetime-local" className={`${INPUT} mt-1 block`} value={f.startsAt} onChange={(e) => set({ startsAt: e.target.value })} />
          </label>
          <label className={LABEL}>Ends
            <input type="datetime-local" className={`${INPUT} mt-1 block`} value={f.endsAt} onChange={(e) => set({ endsAt: e.target.value })} />
          </label>
          <label className={LABEL}>Minimum minutes present
            <input type="number" min={0} max={BEAT_MIN_PRESENT_MAX_MINUTES} className={`${INPUT} mt-1 block w-28`} value={f.minPresentMinutes}
              onChange={(e) => set({ minPresentMinutes: Number(e.target.value) })} />
          </label>
        </div>
        <FieldNote error={shown} field="window" />
        <FieldNote error={shown} field="minutes" />
      </div>

      <fieldset>
        <legend className={LABEL}>Scenes</legend>
        {scenes === null && f.sceneIds.length === 0 ? <p className="mt-1 text-sm text-gray-500">Loading…</p>
          : options.length === 0 ? <p className="mt-1 text-sm text-gray-500">You have no scenes yet.</p> : (
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

      <div className="flex flex-wrap items-end gap-6">
        <label className={LABEL}>Supply cap
          <input type="number" min={1} max={BEAT_SUPPLY_CAP_MAX} className={`${INPUT} mt-1 block w-28`} value={f.supplyCap} disabled={paid}
            onChange={(e) => set({ supplyCap: Number(e.target.value) })} />
        </label>
        <label className="inline-flex items-center gap-2 pb-2 text-sm text-gray-200">
          <input type="checkbox" checked={f.tradeable} disabled={paid} onChange={(e) => set({ tradeable: e.target.checked })} />
          Tradeable
        </label>
      </div>
      {paid && <p className="-mt-3 text-xs text-gray-500">The supply and tradeable are set once paid. Use Raise cap for more supply.</p>}
      <FieldNote error={shown} field="cap" />

      <div className="flex gap-2">
        <button type="submit" disabled={busy} className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-50">{submitLabel}</button>
        {onCancel && <button type="button" onClick={onCancel} className="rounded-md bg-gray-800 px-4 py-2 text-sm text-gray-300 hover:bg-gray-700">Back</button>}
      </div>
    </form>
  )
}
