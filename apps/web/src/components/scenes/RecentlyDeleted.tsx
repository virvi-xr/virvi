'use client'
// The Scenes page's Recently deleted list (LIV-83): each deleted scene with the day it goes for good, Restore,
// "Delete forever now" (type the name), and its removals still to finish.
import { useState } from 'react'
import { useApi } from '@/lib/api'
import { wizardErrorMessage } from '@/lib/wizard/run'
import { nameMatches, purgeDateText, RESTORE_NOTE, restoredNote, unfinished, type DeletedScene, type Removal } from '@/lib/scene-delete'
import { RemovalList } from './DeleteSceneDialog'

const smallButton = 'rounded-md bg-gray-800 px-3 py-1.5 text-xs hover:bg-gray-700 disabled:opacity-50'

function DeletedRow({ scene, first, onRestored, onPurged, onRemoval }: {
  scene: DeletedScene
  first: boolean
  onRestored: (note: string) => void
  onPurged: () => void
  onRemoval: (r: Removal) => void
}) {
  const api = useApi()
  const [busy, setBusy] = useState<null | 'restore' | 'purge'>(null)
  const [purging, setPurging] = useState(false)
  const [typed, setTyped] = useState('')
  const [error, setError] = useState<string | null>(null)

  const restore = async () => {
    setBusy('restore')
    setError(null)
    try {
      const { scene: back, notRestored } = await api.restoreScene(scene.id)
      onRestored(restoredNote(back.name, notRestored))
    } catch (err) {
      setError(wizardErrorMessage(err))
      setBusy(null)
    }
  }

  const purge = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!nameMatches(typed, scene.name)) return
    setBusy('purge')
    setError(null)
    try {
      await api.purgeScene(scene.id, scene.name)
      onPurged()
    } catch (err) {
      setError(wizardErrorMessage(err))
      setBusy(null)
    }
  }

  const todo = unfinished(scene.removals)
  return (
    <li className={`px-4 py-3 ${first ? '' : 'border-t border-gray-800'}`}>
      <div className="flex flex-wrap items-center gap-3">
        <div className="min-w-0 flex-1">
          <p className="truncate font-medium">{scene.name}</p>
          <p className="text-xs text-gray-500">
            {purgeDateText(scene.purgeAt)}
            {scene.orgDeleted ? ' · Its organization was deleted: restoring makes it your own scene' : scene.orgName ? ` · ${scene.orgName}` : ''}
          </p>
        </div>
        <button type="button" onClick={restore} disabled={!!busy} title={RESTORE_NOTE} className={smallButton}>{busy === 'restore' ? 'Restoring…' : 'Restore'}</button>
        <button type="button" onClick={() => setPurging((p) => !p)} disabled={!!busy} className="rounded-md px-3 py-1.5 text-xs text-red-300 hover:bg-red-500/10 disabled:opacity-50">Delete forever now</button>
      </div>
      {purging && (
        <form onSubmit={purge} className="mt-3 flex flex-wrap items-center gap-2 text-sm">
          <label className="flex-1">
            <span className="mb-1 block text-xs text-gray-400">Type <strong className="text-white">{scene.name}</strong> to delete it for good. This can&apos;t be undone.</span>
            <input type="text" value={typed} onChange={(e) => setTyped(e.target.value)} autoFocus autoComplete="off" spellCheck={false}
              className="w-full rounded-md border border-gray-800 bg-gray-950 px-3 py-1.5 text-sm outline-none focus:border-red-400" />
          </label>
          <button type="submit" disabled={!!busy || !nameMatches(typed, scene.name)} className="self-end rounded-md bg-red-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-500 disabled:opacity-50">
            {busy === 'purge' ? 'Deleting…' : 'Delete forever'}
          </button>
        </form>
      )}
      {todo.length > 0 && (
        <div className="mt-3">
          <p className="mb-2 text-xs text-gray-400">Still to finish from the delete:</p>
          <RemovalList sceneId={scene.id} removals={todo} onChange={onRemoval} />
        </div>
      )}
      {error && <p className="mt-2 text-xs text-red-300" role="alert">{error}</p>}
    </li>
  )
}

export function RecentlyDeleted({ scenes, onRestored, onPurged, onRemoval }: {
  scenes: DeletedScene[]
  onRestored: (id: string, note: string) => void
  onPurged: (id: string) => void
  onRemoval: (sceneId: string, r: Removal) => void
}) {
  if (!scenes.length) return null
  return (
    <section className="mt-10" aria-labelledby="recently-deleted">
      <h2 id="recently-deleted" className="mb-1 text-lg font-semibold">Recently deleted</h2>
      <p className="mb-3 text-sm text-gray-400">Deleted scenes are kept for 30 days, then removed for good. {RESTORE_NOTE}</p>
      <ul className="overflow-hidden rounded-lg border border-gray-800 bg-gray-900">
        {scenes.map((s, i) => (
          <DeletedRow key={s.id} scene={s} first={i === 0}
            onRestored={(note) => onRestored(s.id, note)} onPurged={() => onPurged(s.id)} onRemoval={(r) => onRemoval(s.id, r)} />
        ))}
      </ul>
    </section>
  )
}
