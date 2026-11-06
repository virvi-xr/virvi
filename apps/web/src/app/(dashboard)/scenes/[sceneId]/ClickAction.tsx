'use client'
import { useEffect, useState, type ComponentType } from 'react'
import { describeClick, HOVER_TEXT_MAX, type ClickEvent } from '@virvixr/shared'
import type { useApi } from '@/lib/api'
import { blankClickForm, clickFormOf, clickFromForm, CLICK_KINDS, HOVER_PLACEHOLDER, type ClickForm } from '@/lib/click-actions'

type Api = ReturnType<typeof useApi>
type Picker = ComponentType<{ api: Api; accept?: string; onSelect: (url: string) => void; onClose: () => void }>

const INPUT = 'rounded-md border border-gray-700 bg-gray-950 px-2 py-1 text-sm text-white outline-none focus:border-blue-400'
const BTN = 'rounded-md border border-gray-700 px-2.5 py-1 text-xs text-gray-300 hover:border-gray-500 hover:text-white disabled:opacity-50'

/**
 * What clicking the item does in-world (LIV-126): open a link (Decentraland asks the visitor first), play a sound,
 * move the visitor or teleport them, with its hover text. On a copy, "Same as the item" uses the item's action.
 */
export function ClickActionField({ value, onSave, api, MediaPicker, inherited }: {
  value: Partial<ClickEvent> | null | undefined
  onSave: (clickEvent: ClickEvent | null) => Promise<void> | void
  api: Api
  MediaPicker: Picker
  /** On a copy: the item's own action, which the copy uses unless it has one. */
  inherited?: Partial<ClickEvent> | null
}) {
  const own = value && value.type ? value : null
  const [editing, setEditing] = useState(false)
  const [form, setForm] = useState<ClickForm>(() => clickFormOf(own))
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [picking, setPicking] = useState(false)
  useEffect(() => { if (!editing) setForm(clickFormOf(own)) }, [own, editing]) // eslint-disable-line react-hooks/exhaustive-deps

  const forCopy = inherited !== undefined
  const summary = own
    ? describeClick(own)
    : forCopy ? `Same as the item${inherited?.type ? ` (${describeClick(inherited)})` : ''}` : 'Nothing'
  const set = <K extends keyof ClickForm>(k: K, v: ClickForm[K]) => setForm((f) => ({ ...f, [k]: v }))
  const setAt = (k: 'move' | 'camera', i: number, v: string) => setForm((f) => { const t = [...f[k]] as ClickForm['move']; t[i] = v; return { ...f, [k]: t } })

  const save = async () => {
    const c = clickFromForm(form)
    if (!c.ok) return setError(c.error)
    setBusy(true)
    setError('')
    try {
      await onSave(c.value)
      setEditing(false)
    } catch (e: any) {
      setError(e?.body?.message || e?.message || 'Could not save the click action')
    } finally {
      setBusy(false)
    }
  }

  if (!editing) {
    return (
      <div className="flex flex-wrap items-center gap-2 text-xs text-gray-400">
        <span>{forCopy ? 'This copy on click:' : 'On click:'} <span className="text-gray-200">{summary}</span>{own?.hoverText ? <span className="text-gray-500"> · “{own.hoverText}”</span> : null}</span>
        <button type="button" className={BTN} onClick={() => { setForm(clickFormOf(own)); setError(''); setEditing(true) }}>{forCopy ? 'Set for this copy' : 'Edit'}</button>
        {forCopy && own && <button type="button" className={BTN} disabled={busy} onClick={() => void onSave(null)}>Use the item's</button>}
      </div>
    )
  }

  return (
    <div className="space-y-2 rounded-md border border-gray-800 bg-gray-950 p-3 text-sm text-gray-300">
      <label className="flex items-center gap-2">When a visitor clicks
        <select className={INPUT} value={form.kind} onChange={(e) => set('kind', e.target.value as ClickForm['kind'])}>
          {CLICK_KINDS.map((k) => <option key={k.kind} value={k.kind}>{forCopy && k.kind === 'none' ? 'Same as the item' : k.label}</option>)}
        </select>
      </label>
      {form.kind === 'link' && (
        <label className="flex flex-col gap-1">Link
          <input className={`${INPUT} w-full`} value={form.link} placeholder="https://" onChange={(e) => set('link', e.target.value)} />
          <span className="text-xs text-gray-500">Decentraland asks the visitor before it opens.</span>
        </label>
      )}
      {form.kind === 'sound' && (
        <div className="flex flex-wrap items-center gap-2">
          <input className={`${INPUT} min-w-0 flex-1`} value={form.sound} placeholder="https:// (an mp3 or ogg)" onChange={(e) => set('sound', e.target.value)} />
          <button type="button" className={BTN} onClick={() => setPicking(true)}>Choose from library</button>
          {picking && <MediaPicker api={api} accept="audio/*" onSelect={(url) => { set('sound', url); setPicking(false) }} onClose={() => setPicking(false)} />}
        </div>
      )}
      {form.kind === 'move' && (
        <div className="space-y-1">
          <div className="flex flex-wrap items-center gap-2">To (scene metres)
            {(['x', 'y', 'z'] as const).map((a, i) => <input key={a} aria-label={`Move to ${a}`} className={`${INPUT} w-20`} value={form.move[i]} placeholder={a} onChange={(e) => setAt('move', i, e.target.value)} />)}
          </div>
          <label className="flex items-center gap-2 text-xs"><input type="checkbox" className="accent-blue-500" checked={form.aimCamera} onChange={(e) => set('aimCamera', e.target.checked)} /> Turn the camera to look at</label>
          {form.aimCamera && (
            <div className="flex flex-wrap items-center gap-2">
              {(['x', 'y', 'z'] as const).map((a, i) => <input key={a} aria-label={`Look at ${a}`} className={`${INPUT} w-20`} value={form.camera[i]} placeholder={a} onChange={(e) => setAt('camera', i, e.target.value)} />)}
            </div>
          )}
        </div>
      )}
      {form.kind === 'teleport' && (
        <label className="flex flex-col gap-1">Parcel
          <input className={`${INPUT} w-40`} value={form.teleport} placeholder="52,-20" onChange={(e) => set('teleport', e.target.value)} />
          <span className="text-xs text-gray-500">Decentraland asks the visitor before it teleports them.</span>
        </label>
      )}
      {form.kind !== 'none' && (
        <div className="flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-2">Hover text
            <input className={`${INPUT} w-48`} value={form.hoverText} maxLength={HOVER_TEXT_MAX} placeholder={HOVER_PLACEHOLDER[form.kind]} onChange={(e) => set('hoverText', e.target.value)} />
          </label>
          <label className="flex items-center gap-2 text-xs"><input type="checkbox" className="accent-blue-500" checked={form.showFeedback} onChange={(e) => set('showFeedback', e.target.checked)} /> Highlight when pointed at</label>
        </div>
      )}
      {error && <p role="alert" className="text-xs text-red-400">{error}</p>}
      <div className="flex gap-2">
        <button type="button" className="rounded-md bg-blue-600 px-3 py-1 text-xs font-medium text-white hover:bg-blue-500 disabled:opacity-50" disabled={busy} onClick={() => void save()}>Save</button>
        <button type="button" className={BTN} onClick={() => { setEditing(false); setForm(blankClickForm()) }}>Cancel</button>
      </div>
    </div>
  )
}
