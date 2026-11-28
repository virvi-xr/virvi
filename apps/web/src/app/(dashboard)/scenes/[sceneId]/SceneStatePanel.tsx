'use client'
import { useEffect, useState } from 'react'
import { useApi } from '@/lib/api'
import { useAuth } from '@/lib/auth'

/** The value as one short line of JSON. */
export function previewValue(v: unknown, max = 80): string {
  const s = JSON.stringify(v) ?? String(v)
  return s.length > max ? `${s.slice(0, max - 1)}…` : s
}

/** Scene state (LIV-158): what the scene's code has saved, and who may change it. */
export function SceneStatePanel({ sceneId }: { sceneId: string }) {
  const api = useApi()
  const { token } = useAuth()
  const [data, setData] = useState<Awaited<ReturnType<typeof api.getSceneState>> | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const load = async () => {
    try { setData(await api.getSceneState(sceneId)); setError(null) } catch (e: any) { setError(e?.message ?? 'Could not load the scene state') }
  }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { load() }, [sceneId, token])

  const setWrites = async (writes: 'staff' | 'everyone') => {
    setBusy(true)
    try { await api.setSceneStateWrites(sceneId, writes); setData((d) => d && { ...d, writes }) } catch (e: any) { setError(e?.message ?? 'Could not save') } finally { setBusy(false) }
  }
  const remove = async (key: string) => {
    setBusy(true)
    try { await api.deleteSceneStateKey(sceneId, key); await load() } catch (e: any) { setError(e?.message ?? 'Could not delete') } finally { setBusy(false) }
  }

  const keys = data ? Object.keys(data.state).sort() : []
  return (
    <section aria-labelledby="scene-state-heading" className="rounded-lg border border-gray-800 bg-gray-900 p-6">
      <div className="mb-1 flex items-center justify-between">
        <h2 id="scene-state-heading" className="text-sm font-medium text-gray-300">Scene state</h2>
        <button type="button" onClick={() => load()} className="text-xs text-gray-400 hover:text-gray-200">Refresh</button>
      </div>
      <p className="mb-4 text-sm text-gray-400">
        Values your scene&apos;s code saves with <code className="text-gray-300">virvi.state.set</code>. They&apos;re kept between visits, and every visitor sees the same ones.
      </p>
      {error && <p role="alert" className="mb-3 text-sm text-red-300">{error}</p>}
      {data && (
        <>
          <fieldset className="mb-4">
            <legend className="mb-2 text-xs text-gray-400">Who can change it from in-world</legend>
            <label className="mb-1 flex items-center gap-2 text-sm text-gray-300">
              <input type="radio" name="state-writes" checked={data.writes === 'staff'} disabled={busy} onChange={() => setWrites('staff')} className="accent-blue-500" />
              Editors only
            </label>
            <label className="flex items-center gap-2 text-sm text-gray-300">
              <input type="radio" name="state-writes" checked={data.writes === 'everyone'} disabled={busy} onChange={() => setWrites('everyone')} className="accent-blue-500" />
              Every visitor&apos;s scene code (anyone could change these values, so don&apos;t trust them)
            </label>
          </fieldset>
          {keys.length === 0 ? (
            <p className="text-sm text-gray-400">Nothing saved yet.</p>
          ) : (
            <ul className="divide-y divide-gray-800 text-sm">
              {keys.map((k) => (
                <li key={k} className="flex items-center justify-between gap-3 py-2">
                  <span className="min-w-0"><span className="font-medium text-gray-200">{k}</span> <span className="break-all text-gray-400">{previewValue(data.state[k])}</span></span>
                  <button type="button" disabled={busy} onClick={() => remove(k)} aria-label={`Delete ${k}`} className="shrink-0 text-xs text-red-300 hover:text-red-200">Delete</button>
                </li>
              ))}
            </ul>
          )}
          <p className="mt-3 text-xs text-gray-400">{keys.length} of {data.limits.keys} keys; each value up to {data.limits.valueBytes / 1024} KB.</p>
        </>
      )}
    </section>
  )
}
