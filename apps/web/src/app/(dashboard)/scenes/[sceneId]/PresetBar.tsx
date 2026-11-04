'use client'
import { useState } from 'react'
import type { useApi } from '@/lib/api'
import { copyName, PRESET_NAME_MAX, presetDisplayName } from '@/lib/presets'

type Api = ReturnType<typeof useApi>
interface PresetItem { id: string; name: string }

const BTN = 'rounded-md border border-gray-700 px-2.5 py-1 text-xs text-gray-300 hover:border-gray-500 hover:text-white disabled:opacity-50'
const INPUT = 'rounded-md border border-gray-700 bg-gray-950 px-2 py-1 text-sm text-white outline-none focus:border-blue-400'

/**
 * The scene editor's preset bar (LIV-84): which preset is live and which one is being edited (they can differ), and
 * New, Rename, Duplicate, Delete and Make live. Server refusals (e.g. "This is the default preset for venue X") show
 * under the bar.
 */
export function PresetBar({ api, sceneId, presets, activePresetId, editingId, onSelect, onCreated, onRenamed, onDeleted, onMadeLive }: {
  api: Api
  sceneId: string
  presets: PresetItem[]
  activePresetId: string | null
  editingId: string | undefined
  onSelect: (id: string) => void
  onCreated: (id: string) => void
  onRenamed: (id: string, name: string) => void
  onDeleted: (id: string) => void
  onMadeLive: (id: string) => void
}) {
  const editing = presets.find((p) => p.id === editingId)
  const [mode, setMode] = useState<null | 'new' | 'rename' | 'delete' | 'live'>(null)
  const [name, setName] = useState('')
  const [copy, setCopy] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const names = presets.map((p) => p.name)

  const run = async (work: () => Promise<void>) => {
    setBusy(true)
    setError('')
    try {
      await work()
      setMode(null)
    } catch (e: any) {
      setError(e?.body?.message || e?.message || 'Something went wrong')
    } finally {
      setBusy(false)
    }
  }

  const open = (m: typeof mode) => {
    setError('')
    setMode(m)
    if (m === 'new') { setCopy(true); setName(editing ? copyName(editing.name, names) : 'New preset') }
    if (m === 'rename' && editing) setName(editing.name)
  }

  const create = () => run(async () => {
    const { preset } = await api.createPreset(sceneId, { name: name.trim(), ...(copy && editing ? { fromPresetId: editing.id } : {}) })
    onCreated(preset.id)
  })
  const rename = () => run(async () => {
    if (!editing) return
    const { preset } = await api.renamePreset(editing.id, name.trim())
    onRenamed(preset.id, preset.name)
  })
  const remove = () => run(async () => {
    if (!editing) return
    await api.deletePreset(editing.id)
    onDeleted(editing.id)
  })
  const makeLive = () => run(async () => {
    if (!editing) return
    await api.activatePreset(editing.id)
    onMadeLive(editing.id)
  })

  const isLive = !!editing && editing.id === activePresetId
  const nameOk = name.trim().length > 0 && name.trim().length <= PRESET_NAME_MAX

  return (
    <div className="mb-4 rounded-lg border border-gray-800 bg-gray-900 px-4 py-3">
      <div className="flex flex-wrap items-center gap-3">
        <label htmlFor="preset-select" className="text-xs font-medium uppercase tracking-wider text-gray-500">Preset</label>
        <select id="preset-select" value={editingId ?? ''} onChange={(e) => { setMode(null); setError(''); onSelect(e.target.value) }}
          className="rounded-md border border-gray-700 bg-gray-950 px-2 py-1 text-sm text-white">
          {presets.map((p) => (
            <option key={p.id} value={p.id}>{presetDisplayName(p.name)}{p.id === activePresetId ? ' (live)' : ''}</option>
          ))}
        </select>
        {editing && (isLive
          ? <span className="inline-flex items-center gap-1.5 text-xs text-green-400"><span className="h-1.5 w-1.5 rounded-full bg-green-400" />Live: visitors see this preset</span>
          : <span className="text-xs text-amber-300">Editing a preset that isn&apos;t live. Visitors see {presetDisplayName(presets.find((p) => p.id === activePresetId)?.name ?? 'nothing')}.</span>)}
        <span className="ml-auto flex flex-wrap gap-2">
          {editing && !isLive && <button type="button" className="rounded-md bg-green-700 px-2.5 py-1 text-xs font-medium text-white hover:bg-green-600 disabled:opacity-50" disabled={busy} onClick={() => open('live')}>Make live</button>}
          <button type="button" className={BTN} disabled={busy} onClick={() => open('new')}>New preset</button>
          {editing && <button type="button" className={BTN} disabled={busy} onClick={() => open('rename')}>Rename</button>}
          {editing && <button type="button" className={BTN} disabled={busy} onClick={() => run(async () => {
            const { preset } = await api.createPreset(sceneId, { name: copyName(editing.name, names), fromPresetId: editing.id })
            onCreated(preset.id)
          })}>Duplicate</button>}
          {editing && <button type="button" className={`${BTN} hover:border-red-500 hover:text-red-300`} disabled={busy} onClick={() => open('delete')}>Delete</button>}
        </span>
      </div>

      {mode === 'new' && (
        <form className="mt-3 flex flex-wrap items-center gap-3 border-t border-gray-800 pt-3" onSubmit={(e) => { e.preventDefault(); if (nameOk) void create() }}>
          <input aria-label="New preset name" className={INPUT} value={name} maxLength={PRESET_NAME_MAX} onChange={(e) => setName(e.target.value)} autoFocus />
          {editing && (
            <span className="flex gap-3 text-sm text-gray-300">
              <label className="flex items-center gap-1.5"><input type="radio" checked={copy} onChange={() => { setCopy(true); setName(copyName(editing.name, names)) }} />Copy of {presetDisplayName(editing.name)}</label>
              <label className="flex items-center gap-1.5"><input type="radio" checked={!copy} onChange={() => { setCopy(false); setName('New preset') }} />Blank</label>
            </span>
          )}
          <button type="submit" className="rounded-md bg-blue-600 px-3 py-1 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-50" disabled={busy || !nameOk}>Create</button>
          <button type="button" className="text-sm text-gray-400 hover:text-white" onClick={() => setMode(null)}>Cancel</button>
        </form>
      )}

      {mode === 'rename' && editing && (
        <form className="mt-3 flex flex-wrap items-center gap-3 border-t border-gray-800 pt-3" onSubmit={(e) => { e.preventDefault(); if (nameOk) void rename() }}>
          <input aria-label="Preset name" className={INPUT} value={name} maxLength={PRESET_NAME_MAX} onChange={(e) => setName(e.target.value)} autoFocus />
          <button type="submit" className="rounded-md bg-blue-600 px-3 py-1 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-50" disabled={busy || !nameOk}>Save</button>
          <button type="button" className="text-sm text-gray-400 hover:text-white" onClick={() => setMode(null)}>Cancel</button>
        </form>
      )}

      {mode === 'delete' && editing && (
        <div className="mt-3 flex flex-wrap items-center gap-3 border-t border-gray-800 pt-3 text-sm text-gray-300">
          Delete {presetDisplayName(editing.name)} and everything in it? This can&apos;t be undone.
          <button type="button" className="rounded-md bg-red-600 px-3 py-1 text-sm font-medium text-white hover:bg-red-500 disabled:opacity-50" disabled={busy} onClick={() => void remove()}>Delete</button>
          <button type="button" className="text-gray-400 hover:text-white" onClick={() => setMode(null)}>Cancel</button>
        </div>
      )}

      {mode === 'live' && editing && (
        <div className="mt-3 flex flex-wrap items-center gap-3 border-t border-gray-800 pt-3 text-sm text-gray-300">
          Make {presetDisplayName(editing.name)} live? Everyone in the scene sees the change now.
          <button type="button" className="rounded-md bg-green-700 px-3 py-1 text-sm font-medium text-white hover:bg-green-600 disabled:opacity-50" disabled={busy} onClick={() => void makeLive()}>Make live</button>
          <button type="button" className="text-gray-400 hover:text-white" onClick={() => setMode(null)}>Cancel</button>
        </div>
      )}

      {error && <p role="alert" className="mt-2 text-sm text-red-400">{error}</p>}
    </div>
  )
}
