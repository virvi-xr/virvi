'use client'
import { useEffect, useState } from 'react'
import dynamic from 'next/dynamic'
import { DEFAULT_ROOM_SET_OPTIONS, type RoomSetOptions } from '@virvixr/shared'
import { useApi, type RoomScanSummary } from '@/lib/api'
import { wizardErrorMessage } from '@/lib/wizard/run'
import { defaultSpawn } from '@/lib/wizard/state'
import { RoomSetOptionsFields } from '@/components/room-set/RoomSetOptionsFields'
import { useRoomScanPreview } from '@/components/wizard/useRoomSetPreview'

const Preview3D = dynamic(() => import('@/components/wizard/Preview3D'), {
  ssr: false,
  loading: () => <div className="h-full min-h-[320px] w-full animate-pulse rounded-lg border border-gray-800 bg-gray-900" />,
})

const fieldClass = 'w-full rounded-md border border-gray-800 bg-gray-950 px-3 py-2 text-sm outline-none focus:border-blue-400'
const noop = () => {}

/** "Make a model from a room scan": pick a scan, name it, choose its look, see it, and save it as a private model. */
export function RoomAssetDialog({ onCreated, onClose }: { onCreated: (asset: any) => void; onClose: () => void }) {
  const api = useApi()
  const [scans, setScans] = useState<RoomScanSummary[] | null | 'error'>(null)
  const [scanId, setScanId] = useState('')
  const [name, setName] = useState('')
  const [options, setOptions] = useState<RoomSetOptions>(DEFAULT_ROOM_SET_OPTIONS)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    api.getRoomScans().then((r) => {
      setScans(r.scans)
      const first = r.scans.find((s) => s.plot) ?? r.scans[0]
      if (first) { setScanId(first.id); setName(first.name) }
    }, () => setScans('error'))
  }, [])

  useEffect(() => {
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape' && !saving) onClose() }
    document.addEventListener('keydown', esc)
    return () => document.removeEventListener('keydown', esc)
  }, [onClose, saving])

  const scan = Array.isArray(scans) ? scans.find((s) => s.id === scanId) ?? null : null
  const preview = useRoomScanPreview(scan?.plot ? scan.id : null, options)

  const choose = (id: string) => {
    const next = Array.isArray(scans) ? scans.find((s) => s.id === id) : undefined
    // The name follows the scan until it has been typed over
    if (next && (!name.trim() || name === scan?.name)) setName(next.name)
    setScanId(id)
  }

  const create = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!scan || !name.trim()) return
    setSaving(true)
    setError(null)
    try {
      const { asset } = await api.createRoomSetAsset({ scanId: scan.id, name: name.trim(), options })
      onCreated(asset)
    } catch (err) {
      setError(wizardErrorMessage(err))
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" onMouseDown={(e) => { if (e.target === e.currentTarget && !saving) onClose() }}>
      <div role="dialog" aria-modal="true" aria-labelledby="room-asset-title" className="max-h-[90vh] w-full max-w-3xl overflow-y-auto rounded-lg border border-gray-800 bg-gray-900 p-5">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 id="room-asset-title" className="text-lg font-semibold">Make a model from a room scan</h2>
            <p className="mt-1 text-sm text-gray-400">The room becomes one model, at real size, that you can place in any of your scenes. It stays private in your library, but anyone visiting a World you deploy it to will see the room&apos;s layout.</p>
          </div>
          <button type="button" onClick={onClose} disabled={saving} aria-label="Close" className="px-2 text-lg text-gray-400 hover:text-white">&times;</button>
        </div>

        {scans === null ? (
          <div className="mt-6 h-40 animate-pulse rounded-lg bg-gray-800/50" aria-hidden="true" />
        ) : scans === 'error' ? (
          <p className="mt-6 text-sm text-gray-400" role="alert">Your room scans couldn&apos;t be loaded just now.</p>
        ) : scans.length === 0 ? (
          <p className="mt-6 text-sm text-gray-400">You have no room scans yet. Scanning a room needs the Virvi AR app on a personal Quest.</p>
        ) : (
          <form onSubmit={create} className="mt-5 grid gap-5 text-sm md:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)]">
            <div className="space-y-4">
              <label className="block space-y-1">
                <span className="text-gray-300">Room scan</span>
                <select value={scanId} onChange={(e) => choose(e.target.value)} className={fieldClass}>
                  {scans.map((s) => (
                    <option key={s.id} value={s.id}>{s.name} ({s.roomCount} {s.roomCount === 1 ? 'room' : 'rooms'})</option>
                  ))}
                </select>
              </label>
              <label className="block space-y-1">
                <span className="text-gray-300">Name</span>
                <input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} required className={fieldClass} />
              </label>
              <RoomSetOptionsFields options={options} onChange={(c) => setOptions((o) => ({ ...o, ...c }))} disabled={saving} />
              {scan && !scan.plot && <p className="text-xs text-red-300" role="alert">That room scan is too big for a Decentraland plot.</p>}
              {preview.loading && <p className="text-xs text-gray-500" role="status">Building the preview…</p>}
              {preview.error && <p className="text-xs text-red-300" role="alert">{preview.error}</p>}
              {error && <p className="text-xs text-red-300" role="alert">{error}</p>}
              <div className="flex justify-end gap-2 pt-1">
                <button type="button" onClick={onClose} disabled={saving} className="rounded-md px-4 py-2 text-gray-300 hover:bg-white/5">Cancel</button>
                <button type="submit" disabled={saving || !scan?.plot || !name.trim()} className="rounded-md bg-blue-600 px-4 py-2 font-medium hover:bg-blue-700 disabled:opacity-50">
                  {saving ? 'Making the model…' : 'Make model'}
                </button>
              </div>
            </div>
            <div className="h-[320px] md:h-auto md:min-h-[360px]">
              {scan?.plot && (
                <Preview3D plot={scan.plot} items={[]} room={preview.url} spawn={defaultSpawn(scan.plot)} selectedKey={null} editable={false}
                  onMove={noop} onRotate={noop} onSelect={noop} onMoveSpawn={noop} />
              )}
            </div>
          </form>
        )}
      </div>
    </div>
  )
}
