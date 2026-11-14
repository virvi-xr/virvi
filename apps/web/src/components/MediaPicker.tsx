'use client'
// The media library picker (Images & Video, or your 3D Models when picking a model), shared by the scene editor and BEATs.

import { useEffect, useRef, useState } from 'react'
import { fileToBase64, isGlbAsset, mediaContentType, uploadErrorMessage, type useApi } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { ASSET_LIBRARY, MEDIA_LIBRARY, asPickerModel, modelPickerQuery } from '@/lib/libraries'
import { SearchField, Skeleton } from '@/components/ui'
import { askSceneSignUp } from '@/components/TrialLock'
import { sceneTabLocked, TRIAL_LOCK_LABELS } from '@/lib/trial-scene'

const useTrial = () => !!useAuth().user?.trial

/** A trial has no Images & Video (GET /api/media is account-only): opening a picker opens the sign-up sheet instead and
 *  closes, so pickers reached from other parts (a click action's sound) never fetch it either. */
export function MediaPicker(props: Parameters<typeof LibraryPicker>[0]) {
  const trial = useTrial()
  return sceneTabLocked('media-library', trial) ? <LockedPicker onClose={props.onClose} /> : <LibraryPicker {...props} />
}

function LockedPicker({ onClose }: { onClose: () => void }) {
  useEffect(() => { askSceneSignUp('media-library', TRIAL_LOCK_LABELS['media-library']); onClose() }, []) // eslint-disable-line react-hooks/exhaustive-deps
  return null
}

function LibraryPicker({ api, accept, onSelect, onClose }: {
  api: ReturnType<typeof useApi>
  accept?: string
  /** The picked file's URL, and the media item itself (its id, type and name). */
  onSelect: (url: string, asset: any) => void
  onClose: () => void
}) {
  const [assets, setAssets] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const fileRef = useRef<HTMLInputElement>(null)
  const [uploading, setUploading] = useState(false)
  const [uploadError, setUploadError] = useState('')
  // Picking a model lists your 3D Models (LIV-132); everything else lists Images & Video
  const modelsOnly = !!accept && accept.split(',').every(t => ['.glb', 'model/gltf-binary'].includes(t.trim().toLowerCase()))

  // `accept` is a comma-separated list like an <input accept>: "image/*", "model/gltf-binary", ".glb".
  // GLBs match by content type or by a .glb filename (old uploads may be stored as octet-stream).
  const matchesAccept = (a: any) => {
    if (!accept) return true
    return accept.split(',').map(t => t.trim().toLowerCase()).filter(Boolean).some(t => {
      if (t === '.glb' || t === 'model/gltf-binary') return isGlbAsset(a)
      if (t.startsWith('.')) return !!a.filename?.toLowerCase().endsWith(t)
      if (t.endsWith('/*')) return !!a.contentType?.startsWith(t.slice(0, -1))
      return a.contentType === t
    })
  }

  // Your 3D Models come a page at a time, newest first, with a search box, so every one of them can be reached
  const [search, setSearch] = useState('')
  const [total, setTotal] = useState(0)
  const [loadingMore, setLoadingMore] = useState(false)
  const loadModels = (offset: number) =>
    api.getAssets(modelPickerQuery(search, offset)).then(data => {
      setTotal(data.total)
      return data.assets.map(asPickerModel)
    })

  useEffect(() => {
    if (modelsOnly) return
    api.getMedia().then(data => {
      setAssets(data.assets.filter(matchesAccept))
      setLoading(false)
    }).catch(() => setLoading(false))
  }, [])

  useEffect(() => {
    if (!modelsOnly) return
    let live = true
    const t = setTimeout(() => {
      loadModels(0).then(list => { if (live) { setAssets(list); setLoading(false) } }).catch(() => { if (live) setLoading(false) })
    }, search ? 250 : 0)
    return () => { live = false; clearTimeout(t) }
  }, [search])

  const loadMore = () => {
    setLoadingMore(true)
    loadModels(assets.length).then(list => setAssets(prev => [...prev, ...list])).catch(() => {}).finally(() => setLoadingMore(false))
  }

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    setUploading(true)
    setUploadError('')
    try {
      const base64 = await fileToBase64(file)
      const { asset } = await api.uploadMedia(file.name, mediaContentType(file), base64)
      setAssets(prev => [asset, ...prev])
    } catch (err: any) {
      console.error('Upload failed:', err)
      setUploadError(uploadErrorMessage(err))
    }
    setUploading(false)
    if (fileRef.current) fileRef.current.value = ''
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div className="w-full max-w-2xl max-h-[80vh] rounded-lg border border-gray-700 bg-gray-900 shadow-2xl flex flex-col" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-gray-800 px-4 py-3">
          <h3 className="font-semibold">{modelsOnly ? `Your ${ASSET_LIBRARY.name}` : MEDIA_LIBRARY.name}</h3>
          <div className="flex items-center gap-2">
            {!modelsOnly && <label className={`rounded bg-blue-600 px-3 py-1.5 text-sm text-white hover:bg-blue-500 transition-colors cursor-pointer ${uploading ? 'opacity-50 pointer-events-none' : ''}`}>
              {uploading ? 'Uploading...' : 'Upload New'}
              <input ref={fileRef} type="file" accept={accept} onChange={handleUpload} className="hidden" />
            </label>}
            <button onClick={onClose} className="text-gray-400 hover:text-white text-lg px-2">&times;</button>
          </div>
        </div>
        {uploadError && <p className="px-4 pt-3 text-xs text-red-400">{uploadError}</p>}
        {modelsOnly && <div className="px-4 pt-3"><SearchField value={search} onChange={setSearch} placeholder="Search your models..." label="Search your models" /></div>}
        <div className="flex-1 overflow-y-auto p-4">
          {loading ? (
            <Skeleton rows={2} className="h-12" />
          ) : assets.length === 0 ? (
            <p className="text-gray-500 text-sm text-center py-8">{modelsOnly ? (search.trim() ? 'No models match your search.' : 'No models in your 3D Models yet. Use Upload GLB to add one.') : 'No images or video yet. Upload one above.'}</p>
          ) : (
            <div className="grid grid-cols-3 gap-3">
              {assets.map((asset: any) => (
                <button key={asset.id} onClick={() => { onSelect(asset.publicUrl, asset); onClose() }}
                  className="rounded-lg border border-gray-700 bg-gray-800 overflow-hidden hover:border-blue-500 transition-colors text-left group">
                  {asset.contentType?.startsWith('image/') ? (
                    <img src={asset.publicUrl} alt={asset.filename}
                      className="w-full h-24 object-cover" />
                  ) : (
                    <div className="w-full h-24 flex items-center justify-center text-gray-500 text-2xl">
                      {isGlbAsset(asset) ? 'GLB' : asset.contentType?.startsWith('video/') ? 'V' : asset.contentType?.startsWith('audio/') ? 'A' : 'F'}
                    </div>
                  )}
                  <div className="px-2 py-1.5">
                    <p className="text-xs text-gray-300 truncate">{asset.filename}</p>
                  </div>
                </button>
              ))}
            </div>
          )}
          {modelsOnly && !loading && assets.length < total && (
            <div className="mt-4 text-center">
              <button type="button" onClick={loadMore} disabled={loadingMore}
                className="rounded border border-gray-700 px-3 py-1.5 text-sm text-gray-300 hover:border-gray-500 disabled:opacity-50">
                {loadingMore ? 'Loading…' : `Load more (${assets.length} of ${total})`}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
