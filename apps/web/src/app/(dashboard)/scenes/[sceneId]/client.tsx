'use client'
import { useApi, fileToBase64, mediaContentType, uploadErrorMessage, isGlbAsset } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { AD_SHAPES, type AdFormats } from '@virvixr/shared'
import { shapeLabel, offImageLabel, adModeHint, isAdsMode, adSpaceRefreshKey } from '@/lib/ads'
import AdSpaceContent from '@/components/AdSpaceContent'
import { useSceneRoom } from '@/lib/colyseus'
import { SceneRoles } from './SceneRoles'
import { ArSpaces } from './ArSpaces'
import { RoomSetPanel } from './RoomSetPanel'
import { sceneHasRoomSet } from '@/lib/room-set'
import { mediaLabel, useMediaNames } from '@/lib/media-names'
import { imageSourceRow, pastedSource } from '@/lib/image-source'
import { EditableSceneTitle, UseNameEverywhere, connectedNamesDiffer, hasConnected, useConnected } from './SceneName'
import { useParams, useSearchParams } from 'next/navigation'
import { useEffect, useState, useCallback, useRef } from 'react'
import { Badge, PageHeader, Skeleton, type Tone } from '@/components/ui'


// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ElementType = 'video' | 'image' | 'sound' | 'model' | 'widget' | 'ad_space'
type TabKey = ElementType | 'moderation' | 'roles' | 'ar'

interface Instance {
  id: string
  position: { x: number; y: number; z: number }
  rotation: { x: number; y: number; z: number }
  scale: { x: number; y: number; z: number }
  enabled: boolean
}

interface Element {
  id: string
  type: ElementType
  name: string
  enabled: boolean
  properties: Record<string, any>
  instances: Instance[]
  /** Model elements: the room set behind this model, null for an ordinary model. */
  roomSetId?: string | null
}

interface Preset {
  id: string
  name: string
  elements: Element[]
}

interface Scene {
  id: string
  name: string
  presets: Preset[]
}

// ---------------------------------------------------------------------------
// Tab config
// ---------------------------------------------------------------------------

const TABS: { key: TabKey; label: string }[] = [
  { key: 'video', label: 'Videos' },
  { key: 'image', label: 'Images' },
  { key: 'model', label: 'Models' },
  { key: 'sound', label: 'Sounds' },
  { key: 'widget', label: 'Widgets' },
  { key: 'ad_space', label: 'Ad spaces' },
  { key: 'moderation', label: 'Moderation' },
  { key: 'roles', label: 'Roles' },
  { key: 'ar', label: 'AR spaces' },
]

const CONTROL_TYPES = [
  { value: 0, label: 'None' },
  { value: 1, label: 'Toggle' },
  { value: 2, label: 'Text' },
  { value: 3, label: 'Selector' },
  { value: 4, label: 'DateTime' },
  { value: 5, label: 'Trigger' },
  { value: 6, label: 'Slider' },
]

const OFF_TYPES: { value: number; label: string }[] = [
  { value: 0, label: 'None' },
  { value: 1, label: 'Image' },
  { value: 2, label: 'Playlist' },
  { value: 4, label: 'Ads' },
  { value: 5, label: 'Playlist + ads' },
]

const AD_SPACE_FORMATS: { value: AdFormats; label: string }[] = [
  { value: 'both', label: 'Images and video' },
  { value: 'image', label: 'Images only' },
  { value: 'video', label: 'Video only' },
]

const ELEMENT_TYPE_LABELS: Record<ElementType, string> = {
  video: 'Video', image: 'Image', model: 'Model', sound: 'Sound', widget: 'Widget', ad_space: 'Ad space',
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function NumberInput({ value, onChange, label }: { value: number; onChange: (v: number) => void; label: string }) {
  const [local, setLocal] = useState(String(value))
  const ref = useRef<HTMLInputElement>(null)

  useEffect(() => { setLocal(String(value)) }, [value])

  const commit = () => {
    const n = parseFloat(local)
    if (!isNaN(n) && n !== value) onChange(n)
    else setLocal(String(value))
  }

  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs text-gray-500">{label}</span>
      <input ref={ref} type="number" step="any" value={local}
        onChange={e => setLocal(e.target.value)}
        onBlur={commit}
        onKeyDown={e => { if (e.key === 'Enter') ref.current?.blur() }}
        className="w-20 rounded bg-gray-950 px-2 py-1 text-sm text-white outline-none focus:border-blue-400 border border-gray-800" />
    </div>
  )
}

function TextInput({ value, onChange, label, readOnly }: { value: string; onChange: (v: string) => void; label: string; readOnly?: boolean }) {
  const [local, setLocal] = useState(value)
  const ref = useRef<HTMLInputElement>(null)

  useEffect(() => { setLocal(value) }, [value])

  const commit = () => {
    if (local !== value) onChange(local)
  }

  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs text-gray-500">{label}</span>
      <input ref={ref} type="text" value={local} readOnly={readOnly}
        onChange={e => setLocal(e.target.value)}
        onBlur={commit}
        onKeyDown={e => { if (e.key === 'Enter') ref.current?.blur() }}
        className={`w-full rounded bg-gray-950 px-3 py-1.5 text-sm text-white outline-none ${readOnly ? 'opacity-60 cursor-not-allowed' : ''} focus:border-blue-400 border border-gray-800`} />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Instance Editor
// ---------------------------------------------------------------------------

function InstanceEditor({ instance, onUpdate, onDelete }: { instance: Instance; onUpdate: (data: Partial<Instance>) => void; onDelete: () => void }) {
  const updatePos = (axis: 'x' | 'y' | 'z', v: number) => {
    onUpdate({ position: { ...instance.position, [axis]: v } })
  }
  const updateRot = (axis: 'x' | 'y' | 'z', v: number) => {
    onUpdate({ rotation: { ...instance.rotation, [axis]: v } })
  }
  const updateScale = (axis: 'x' | 'y' | 'z', v: number) => {
    onUpdate({ scale: { ...instance.scale, [axis]: v } })
  }

  return (
    <div className="rounded-lg border border-gray-700 bg-gray-800/50 p-3 space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-xs font-mono text-gray-500">Instance {instance.id.slice(0, 8)}</span>
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-1.5 text-xs text-gray-400">
            <input type="checkbox" checked={instance.enabled}
              onChange={e => onUpdate({ enabled: e.target.checked })}
              className="accent-blue-500" />
            Enabled
          </label>
          <button onClick={onDelete} className="text-xs text-red-400 hover:text-red-300">Delete</button>
        </div>
      </div>

      <div>
        <p className="text-xs text-gray-500 mb-1">Position</p>
        <div className="flex gap-2">
          <NumberInput label="X" value={instance.position.x} onChange={v => updatePos('x', v)} />
          <NumberInput label="Y" value={instance.position.y} onChange={v => updatePos('y', v)} />
          <NumberInput label="Z" value={instance.position.z} onChange={v => updatePos('z', v)} />
        </div>
      </div>

      <div>
        <p className="text-xs text-gray-500 mb-1">Rotation</p>
        <div className="flex gap-2">
          <NumberInput label="X" value={instance.rotation.x} onChange={v => updateRot('x', v)} />
          <NumberInput label="Y" value={instance.rotation.y} onChange={v => updateRot('y', v)} />
          <NumberInput label="Z" value={instance.rotation.z} onChange={v => updateRot('z', v)} />
        </div>
      </div>

      <div>
        <p className="text-xs text-gray-500 mb-1">Scale</p>
        <div className="flex gap-2">
          <NumberInput label="X" value={instance.scale.x} onChange={v => updateScale('x', v)} />
          <NumberInput label="Y" value={instance.scale.y} onChange={v => updateScale('y', v)} />
          <NumberInput label="Z" value={instance.scale.z} onChange={v => updateScale('z', v)} />
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Video Element Editor
// ---------------------------------------------------------------------------

function VideoElementEditor({ element, sceneId, onUpdateElement, onUpdateInstance, onDeleteInstance, onAddInstance, api }: {
  element: Element
  sceneId: string
  onUpdateElement: (id: string, data: Record<string, any>) => void
  onUpdateInstance: (id: string, data: Partial<Instance>) => void
  onDeleteInstance: (id: string) => void
  onAddInstance: (elementId: string) => void
  api: ReturnType<typeof import('@/lib/api').useApi>
}) {
  const props = element.properties || {}
  const playlist: string[] = props.playlist || []
  // The playlist stores URLs only: names are looked up, so a rename in the Media Library shows here
  const names = useMediaNames(api, sceneId, playlist)
  const fileRef = useRef<HTMLInputElement>(null)
  const [uploading, setUploading] = useState(false)
  const [showPicker, setShowPicker] = useState(false)
  const [urlInput, setUrlInput] = useState('')
  const [dragIdx, setDragIdx] = useState<number | null>(null)
  const [uploadError, setUploadError] = useState('')

  const updateProp = (key: string, value: any) => {
    onUpdateElement(element.id, { properties: { ...props, [key]: value } })
  }

  const addToPlaylist = (url: string) => {
    updateProp('playlist', [...playlist, url])
  }

  const removeFromPlaylist = (idx: number) => {
    updateProp('playlist', playlist.filter((_, i) => i !== idx))
  }

  const handleDragStart = (idx: number) => setDragIdx(idx)

  const handleDragOver = (e: React.DragEvent, idx: number) => {
    e.preventDefault()
    if (dragIdx === null || dragIdx === idx) return
    const reordered = [...playlist]
    const [moved] = reordered.splice(dragIdx, 1)
    reordered.splice(idx, 0, moved)
    updateProp('playlist', reordered)
    setDragIdx(idx)
  }

  const handleDragEnd = () => setDragIdx(null)

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files
    if (!files?.length) return
    setUploading(true)
    setUploadError('')
    for (const file of Array.from(files)) {
      try {
        const base64 = await fileToBase64(file)
        const { asset } = await api.uploadMedia(file.name, mediaContentType(file), base64)
        addToPlaylist(asset.publicUrl)
      } catch (err: any) {
        console.error('Upload failed:', err)
        setUploadError(uploadErrorMessage(err))
      }
    }
    setUploading(false)
    if (fileRef.current) fileRef.current.value = ''
  }

  const handleAddUrl = () => {
    if (!urlInput.trim()) return
    addToPlaylist(urlInput.trim())
    setUrlInput('')
  }

  return (
    <div className="rounded-lg border border-gray-800 bg-gray-900 p-4 space-y-4">
      <div className="flex items-center justify-between">
        <h4 className="font-semibold">{element.name}</h4>
        <label className="flex items-center gap-2 text-sm text-gray-400">
          <input type="checkbox" checked={element.enabled}
            onChange={e => onUpdateElement(element.id, { enabled: e.target.checked })}
            className="accent-blue-500" />
          Enabled
        </label>
      </div>

      <TextInput label="Live Stream URL" value={props.liveSrc || ''} onChange={v => updateProp('liveSrc', v)} />

      <div className="flex items-center gap-4">
        <div className="flex items-center gap-2 text-sm">
          <span className={`inline-block h-2 w-2 rounded-full ${props.isLive ? 'bg-green-400' : 'bg-gray-600'}`} />
          <span className="text-gray-400">{props.isLive ? 'Live' : 'Offline'}</span>
        </div>
      </div>

      <div className="flex flex-col gap-1">
        <span className="text-xs text-gray-500">Off Type</span>
        <select value={props.offType ?? 0}
          onChange={e => updateProp('offType', parseInt(e.target.value))}
          className="w-48 rounded bg-gray-950 px-3 py-1.5 text-sm text-white outline-none focus:border-blue-400 border border-gray-800">
          {OFF_TYPES.map(t => (
            <option key={t.value} value={t.value}>{t.label}</option>
          ))}
        </select>
      </div>

      {offImageLabel(props.offType ?? 0) && (
        <ImageSourceField label={offImageLabel(props.offType ?? 0)!} value={props.offImageSrc} onChange={v => updateProp('offImageSrc', v)} api={api} sceneId={sceneId} />
      )}

      {adModeHint(props.offType ?? 0) && (
        <p className="text-xs text-gray-500">{adModeHint(props.offType ?? 0)}</p>
      )}

      {isAdsMode(props.offType ?? 0) && <AdSpaceContent elementId={element.id} refreshKey={adSpaceRefreshKey(props)} api={api} />}

      {/* Playlist */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <span className="text-xs text-gray-500">Playlist ({playlist.length} video{playlist.length !== 1 ? 's' : ''}) — loops automatically</span>
        </div>

        {playlist.length > 0 && (
          <div className="space-y-1">
            {playlist.map((url, idx) => (
              <div key={idx} draggable onDragStart={() => handleDragStart(idx)}
                onDragOver={e => handleDragOver(e, idx)} onDragEnd={handleDragEnd}
                className={`flex items-center gap-2 rounded-md border bg-gray-800/50 px-3 py-2 text-sm cursor-grab active:cursor-grabbing ${
                  dragIdx === idx ? 'border-blue-500 bg-blue-900/20' : 'border-gray-700'
                }`}>
                <span className="text-gray-500 text-xs w-5 shrink-0">{idx + 1}.</span>
                {(() => {
                  const { label, missing } = mediaLabel(url, names)
                  return <span className={`truncate flex-1 ${missing ? 'text-amber-300 italic' : 'text-gray-300'}`} title={url}>{label}</span>
                })()}
                <button onClick={() => removeFromPlaylist(idx)} className="text-red-400 hover:text-red-300 text-xs shrink-0">Remove</button>
              </div>
            ))}
          </div>
        )}

        <div className="flex items-center gap-2">
          <label className={`rounded bg-gray-700 px-3 py-1.5 text-sm text-white hover:bg-gray-600 transition-colors cursor-pointer shrink-0 ${uploading ? 'opacity-50 pointer-events-none' : ''}`}>
            {uploading ? 'Uploading...' : 'Upload'}
            <input ref={fileRef} type="file" accept="video/*" multiple onChange={handleUpload} className="hidden" />
          </label>
          <button onClick={() => setShowPicker(true)}
            className="rounded bg-gray-700 px-3 py-1.5 text-sm text-white hover:bg-gray-600 transition-colors shrink-0">
            Media Library
          </button>
        </div>
        {uploadError && <p className="text-xs text-red-400">{uploadError}</p>}

        <div className="flex items-center gap-2">
          <input type="text" value={urlInput} onChange={e => setUrlInput(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') handleAddUrl() }}
            placeholder="Paste video URL and press Enter"
            className="flex-1 rounded bg-gray-950 px-3 py-1.5 text-sm text-white outline-none focus:border-blue-400 border border-gray-800" />
          <button onClick={handleAddUrl} disabled={!urlInput.trim()}
            className="rounded bg-blue-600 px-3 py-1.5 text-sm text-white hover:bg-blue-500 transition-colors disabled:opacity-50">
            Add
          </button>
        </div>
      </div>

      {showPicker && (
        <MediaPicker api={api} accept="video/*" onSelect={url => { addToPlaylist(url); setShowPicker(false) }} onClose={() => setShowPicker(false)} />
      )}

      <div className="flex flex-col gap-1">
        <span className="text-xs text-gray-500">Volume</span>
        <div className="flex items-center gap-3">
          <input type="range" min={0} max={1} step={0.01} value={props.volume ?? 1}
            onChange={e => updateProp('volume', parseFloat(e.target.value))}
            className="flex-1 accent-blue-500" />
          <span className="text-sm text-gray-400 w-10 text-right">{Math.round((props.volume ?? 1) * 100)}%</span>
        </div>
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <p className="text-sm text-gray-400">Instances ({element.instances.length})</p>
          <button onClick={() => onAddInstance(element.id)} className="text-xs text-blue-400 hover:text-blue-300">+ Add Instance</button>
        </div>
        {element.instances.map(inst => (
          <InstanceEditor key={inst.id} instance={inst}
            onUpdate={data => onUpdateInstance(inst.id, data)}
            onDelete={() => onDeleteInstance(inst.id)} />
        ))}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Media Library Picker
// ---------------------------------------------------------------------------

function MediaPicker({ api, accept, onSelect, onClose }: {
  api: ReturnType<typeof import('@/lib/api').useApi>
  accept?: string
  onSelect: (url: string) => void
  onClose: () => void
}) {
  const [assets, setAssets] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const fileRef = useRef<HTMLInputElement>(null)
  const [uploading, setUploading] = useState(false)
  const [uploadError, setUploadError] = useState('')

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

  useEffect(() => {
    api.getMedia().then(data => {
      setAssets(data.assets.filter(matchesAccept))
      setLoading(false)
    }).catch(() => setLoading(false))
  }, [])

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
          <h3 className="font-semibold">Media Library</h3>
          <div className="flex items-center gap-2">
            <label className={`rounded bg-blue-600 px-3 py-1.5 text-sm text-white hover:bg-blue-500 transition-colors cursor-pointer ${uploading ? 'opacity-50 pointer-events-none' : ''}`}>
              {uploading ? 'Uploading...' : 'Upload New'}
              <input ref={fileRef} type="file" accept={accept} onChange={handleUpload} className="hidden" />
            </label>
            <button onClick={onClose} className="text-gray-400 hover:text-white text-lg px-2">&times;</button>
          </div>
        </div>
        {uploadError && <p className="px-4 pt-3 text-xs text-red-400">{uploadError}</p>}
        <div className="flex-1 overflow-y-auto p-4">
          {loading ? (
            <Skeleton rows={2} className="h-12" />
          ) : assets.length === 0 ? (
            <p className="text-gray-500 text-sm text-center py-8">No media yet. Upload one above.</p>
          ) : (
            <div className="grid grid-cols-3 gap-3">
              {assets.map((asset: any) => (
                <button key={asset.id} onClick={() => { onSelect(asset.publicUrl); onClose() }}
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
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Image Element Editor
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Image field: upload, pick from the Media Library, or paste a URL
// ---------------------------------------------------------------------------

/** An image an element shows (texture, ad fallback, video off image), named as it is in the Media Library. */
function ImageSourceField({ label, value, onChange, hint, api, sceneId }: {
  label: string
  value: string | undefined
  onChange: (url: string) => void
  hint?: string
  api: ReturnType<typeof import('@/lib/api').useApi>
  sceneId: string
}) {
  const names = useMediaNames(api, sceneId, value ? [value] : [])
  const row = imageSourceRow(value, names)
  const fileRef = useRef<HTMLInputElement>(null)
  const [uploading, setUploading] = useState(false)
  const [showPicker, setShowPicker] = useState(false)
  const [urlInput, setUrlInput] = useState('')
  const [uploadError, setUploadError] = useState('')

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    setUploading(true)
    setUploadError('')
    try {
      const base64 = await fileToBase64(file)
      const { asset } = await api.uploadMedia(file.name, mediaContentType(file), base64)
      onChange(asset.publicUrl)
    } catch (err: any) {
      console.error('Upload failed:', err)
      setUploadError(uploadErrorMessage(err))
    }
    setUploading(false)
    if (fileRef.current) fileRef.current.value = ''
  }

  const handlePaste = () => {
    const url = pastedSource(urlInput)
    if (!url) return
    onChange(url)
    setUrlInput('')
  }

  return (
    <div className="space-y-2">
      <span className="text-xs text-gray-500">{label}</span>
      {row && (
        <div className="flex items-center gap-3 rounded-md border border-gray-700 bg-gray-800/50 p-2">
          <img src={value} alt="" className="h-14 w-14 shrink-0 rounded bg-gray-950 object-contain" />
          <span className={`min-w-0 flex-1 truncate text-sm ${row.missing ? 'italic text-amber-300' : 'text-gray-300'}`} title={row.title}>{row.label}</span>
          <button type="button" onClick={() => onChange('')} className="shrink-0 text-xs text-red-400 hover:text-red-300">Clear</button>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <label className={`shrink-0 cursor-pointer rounded bg-gray-700 px-3 py-1.5 text-sm text-white transition-colors hover:bg-gray-600 ${uploading ? 'pointer-events-none opacity-50' : ''}`}>
          {uploading ? 'Uploading...' : 'Upload'}
          <input ref={fileRef} type="file" accept="image/*" onChange={handleUpload} className="hidden" />
        </label>
        <button type="button" onClick={() => setShowPicker(true)}
          className="shrink-0 rounded bg-gray-700 px-3 py-1.5 text-sm text-white transition-colors hover:bg-gray-600">
          Media Library
        </button>
        <input type="text" value={urlInput} onChange={e => setUrlInput(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') handlePaste() }} onBlur={handlePaste}
          placeholder="or paste an image URL" aria-label={`${label}: paste an image URL`}
          className="min-w-40 flex-1 rounded border border-gray-800 bg-gray-950 px-3 py-1.5 text-sm text-white outline-none focus:border-blue-400" />
      </div>
      {hint && <p className="text-xs text-gray-500">{hint}</p>}
      {uploadError && <p className="text-xs text-red-400">{uploadError}</p>}
      {showPicker && (
        <MediaPicker api={api} accept="image/*" onSelect={url => { onChange(url); setShowPicker(false) }} onClose={() => setShowPicker(false)} />
      )}
    </div>
  )
}

function ImageElementEditor({ element, sceneId, onUpdateElement, onUpdateInstance, onDeleteInstance, onAddInstance, api }: {
  element: Element
  onUpdateElement: (id: string, data: Record<string, any>) => void
  onUpdateInstance: (id: string, data: Partial<Instance>) => void
  onDeleteInstance: (id: string) => void
  onAddInstance: (elementId: string) => void
  api: ReturnType<typeof import('@/lib/api').useApi>
  sceneId: string
}) {
  const props = element.properties || {}

  const setTexture = (url: string) => {
    onUpdateElement(element.id, { properties: { ...props, textureSrc: url } })
  }

  return (
    <div className="rounded-lg border border-gray-800 bg-gray-900 p-4 space-y-4">
      <div className="flex items-center justify-between">
        <h4 className="font-semibold">{element.name}</h4>
        <label className="flex items-center gap-2 text-sm text-gray-400">
          <input type="checkbox" checked={element.enabled}
            onChange={e => onUpdateElement(element.id, { enabled: e.target.checked })}
            className="accent-blue-500" />
          Enabled
        </label>
      </div>

      <ImageSourceField label="Texture" value={props.textureSrc} onChange={setTexture} api={api} sceneId={sceneId} />

      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <p className="text-sm text-gray-400">Instances ({element.instances.length})</p>
          <button onClick={() => onAddInstance(element.id)} className="text-xs text-blue-400 hover:text-blue-300">+ Add Instance</button>
        </div>
        {element.instances.map(inst => (
          <InstanceEditor key={inst.id} instance={inst}
            onUpdate={data => onUpdateInstance(inst.id, data)}
            onDelete={() => onDeleteInstance(inst.id)} />
        ))}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Ad Space Element Editor
// ---------------------------------------------------------------------------

function AdSpaceElementEditor({ element, sceneId, onUpdateElement, onUpdateInstance, onDeleteInstance, onAddInstance, api }: {
  element: Element
  onUpdateElement: (id: string, data: Record<string, any>) => void
  onUpdateInstance: (id: string, data: Partial<Instance>) => void
  onDeleteInstance: (id: string) => void
  onAddInstance: (elementId: string) => void
  api: ReturnType<typeof import('@/lib/api').useApi>
  sceneId: string
}) {
  const props = element.properties || {}

  const updateProp = (key: string, value: any) => {
    onUpdateElement(element.id, { properties: { ...props, [key]: value } })
  }

  return (
    <div className="rounded-lg border border-gray-800 bg-gray-900 p-4 space-y-4">
      <div className="flex items-center justify-between">
        <h4 className="font-semibold">{element.name}</h4>
        <label className="flex items-center gap-2 text-sm text-gray-400">
          <input type="checkbox" checked={element.enabled}
            onChange={e => onUpdateElement(element.id, { enabled: e.target.checked })}
            className="accent-blue-500" />
          Enabled
        </label>
      </div>

      <div className="flex flex-wrap gap-4">
        <div className="flex flex-col gap-1">
          <span className="text-xs text-gray-500">Shape</span>
          <select value={props.shape ?? '16:9'}
            onChange={e => updateProp('shape', e.target.value)}
            className="w-48 rounded bg-gray-950 px-3 py-1.5 text-sm text-white outline-none focus:border-blue-400 border border-gray-800">
            {AD_SHAPES.map(s => (
              <option key={s} value={s}>{shapeLabel(s)}</option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <span className="text-xs text-gray-500">Formats</span>
          <select value={props.formats ?? 'both'}
            onChange={e => updateProp('formats', e.target.value)}
            className="w-48 rounded bg-gray-950 px-3 py-1.5 text-sm text-white outline-none focus:border-blue-400 border border-gray-800">
            {AD_SPACE_FORMATS.map(f => (
              <option key={f.value} value={f.value}>{f.label}</option>
            ))}
          </select>
        </div>
      </div>
      <p className="text-xs text-gray-500">
        Only ads made for this exact shape appear here. Video ads pause while a live stream plays.
      </p>

      <AdSpaceContent elementId={element.id} refreshKey={adSpaceRefreshKey(props)} api={api} />

      <ImageSourceField label="Fallback image" value={props.fallbackImageSrc} onChange={v => updateProp('fallbackImageSrc', v)}
        hint="Shown when there is no ad. Without one, the space hides itself." api={api} sceneId={sceneId} />

      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <p className="text-sm text-gray-400">Instances ({element.instances.length})</p>
          <button onClick={() => onAddInstance(element.id)} className="text-xs text-blue-400 hover:text-blue-300">+ Add Instance</button>
        </div>
        {element.instances.map(inst => (
          <InstanceEditor key={inst.id} instance={inst}
            onUpdate={data => onUpdateInstance(inst.id, data)}
            onDelete={() => onDeleteInstance(inst.id)} />
        ))}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Model Element Editor
// ---------------------------------------------------------------------------

function ModelElementEditor({ element, onUpdateElement, onRoomSetSaved, onUpdateInstance, onDeleteInstance, onAddInstance, api }: {
  element: Element
  onUpdateElement: (id: string, data: Record<string, any>) => void
  /** The room set rewrote this element's model on the server: show the new URL. */
  onRoomSetSaved: (id: string, modelSrc: string) => void
  onUpdateInstance: (id: string, data: Partial<Instance>) => void
  onDeleteInstance: (id: string) => void
  onAddInstance: (elementId: string) => void
  api: ReturnType<typeof import('@/lib/api').useApi>
}) {
  const props = element.properties || {}
  const fileRef = useRef<HTMLInputElement>(null)
  const [uploading, setUploading] = useState(false)
  const [showPicker, setShowPicker] = useState(false)
  const [uploadError, setUploadError] = useState('')

  const setModel = (url: string) => {
    onUpdateElement(element.id, { properties: { ...props, modelSrc: url } })
  }

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    setUploading(true)
    setUploadError('')
    try {
      const base64 = await fileToBase64(file)
      const { asset } = await api.uploadMedia(file.name, mediaContentType(file), base64)
      setModel(asset.publicUrl)
    } catch (err: any) {
      console.error('Upload failed:', err)
      setUploadError(uploadErrorMessage(err))
    }
    setUploading(false)
    if (fileRef.current) fileRef.current.value = ''
  }

  return (
    <div className="rounded-lg border border-gray-800 bg-gray-900 p-4 space-y-4">
      <div className="flex items-center justify-between">
        <h4 className="font-semibold">{element.name}</h4>
        <label className="flex items-center gap-2 text-sm text-gray-400">
          <input type="checkbox" checked={element.enabled}
            onChange={e => onUpdateElement(element.id, { enabled: e.target.checked })}
            className="accent-blue-500" />
          Enabled
        </label>
      </div>

      {element.roomSetId && <RoomSetPanel roomSetId={element.roomSetId} onSaved={(url) => onRoomSetSaved(element.id, url)} />}

      <div className="space-y-2">
        <TextInput label="Model URL" value={props.modelSrc || ''} onChange={setModel} />
        <div className="flex items-center gap-2">
          <label className={`rounded bg-gray-700 px-3 py-1.5 text-sm text-white hover:bg-gray-600 transition-colors cursor-pointer ${uploading ? 'opacity-50 pointer-events-none' : ''}`}>
            {uploading ? 'Uploading...' : 'Upload GLB'}
            <input ref={fileRef} type="file" accept=".glb,model/gltf-binary" onChange={handleUpload} className="hidden" />
          </label>
          <button onClick={() => setShowPicker(true)}
            className="rounded bg-gray-700 px-3 py-1.5 text-sm text-white hover:bg-gray-600 transition-colors">
            Choose from Media
          </button>
        </div>
        {uploadError && <p className="text-xs text-red-400">{uploadError}</p>}
        <p className="text-xs text-gray-500">GLBs need <code className="text-gray-400">npx @virvixr/dcl sync</code> + a redeploy before they appear in-world.</p>
      </div>

      {showPicker && (
        <MediaPicker api={api} accept=".glb,model/gltf-binary" onSelect={setModel} onClose={() => setShowPicker(false)} />
      )}

      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <p className="text-sm text-gray-400">Instances ({element.instances.length})</p>
          <button onClick={() => onAddInstance(element.id)} className="text-xs text-blue-400 hover:text-blue-300">+ Add Instance</button>
        </div>
        {element.instances.map(inst => (
          <InstanceEditor key={inst.id} instance={inst}
            onUpdate={data => onUpdateInstance(inst.id, data)}
            onDelete={() => onDeleteInstance(inst.id)} />
        ))}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Sound Element Editor
// ---------------------------------------------------------------------------

function SoundElementEditor({ element, onUpdateElement, onUpdateInstance, onDeleteInstance, onAddInstance }: {
  element: Element
  onUpdateElement: (id: string, data: Record<string, any>) => void
  onUpdateInstance: (id: string, data: Partial<Instance>) => void
  onDeleteInstance: (id: string) => void
  onAddInstance: (elementId: string) => void
}) {
  const props = element.properties || {}

  const updateProp = (key: string, value: any) => {
    onUpdateElement(element.id, { properties: { ...props, [key]: value } })
  }

  return (
    <div className="rounded-lg border border-gray-800 bg-gray-900 p-4 space-y-4">
      <div className="flex items-center justify-between">
        <h4 className="font-semibold">{element.name}</h4>
        <label className="flex items-center gap-2 text-sm text-gray-400">
          <input type="checkbox" checked={element.enabled}
            onChange={e => onUpdateElement(element.id, { enabled: e.target.checked })}
            className="accent-blue-500" />
          Enabled
        </label>
      </div>

      <TextInput label="Audio URL" value={props.audioSrc || ''} onChange={v => updateProp('audioSrc', v)} />

      <div className="flex flex-col gap-1">
        <span className="text-xs text-gray-500">Volume</span>
        <div className="flex items-center gap-3">
          <input type="range" min={0} max={1} step={0.01} value={props.volume ?? 1}
            onChange={e => updateProp('volume', parseFloat(e.target.value))}
            className="flex-1 accent-blue-500" />
          <span className="text-sm text-gray-400 w-10 text-right">{Math.round((props.volume ?? 1) * 100)}%</span>
        </div>
      </div>

      <label className="flex items-center gap-2 text-sm text-gray-400">
        <input type="checkbox" checked={props.loop ?? false}
          onChange={e => updateProp('loop', e.target.checked)}
          className="accent-blue-500" />
        Loop
      </label>

      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <p className="text-sm text-gray-400">Instances ({element.instances.length})</p>
          <button onClick={() => onAddInstance(element.id)} className="text-xs text-blue-400 hover:text-blue-300">+ Add Instance</button>
        </div>
        {element.instances.map(inst => (
          <InstanceEditor key={inst.id} instance={inst}
            onUpdate={data => onUpdateInstance(inst.id, data)}
            onDelete={() => onDeleteInstance(inst.id)} />
        ))}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Widget Value Editor (renders appropriate input based on controlType)
// ---------------------------------------------------------------------------

function WidgetValueEditor({ controlType, value, onChange }: { controlType: number; value: any; onChange: (v: any) => void }) {
  switch (controlType) {
    case 1: // Toggle
      return (
        <label className="flex items-center gap-2 text-sm text-gray-400">
          <input type="checkbox" checked={!!value} onChange={e => onChange(e.target.checked)} className="accent-blue-500" />
          {value ? 'On' : 'Off'}
        </label>
      )
    case 2: // Text
      return <TextInput label="Value" value={value || ''} onChange={onChange} />
    case 3: // Selector
      return <TextInput label="Options (comma-separated)" value={value || ''} onChange={onChange} />
    case 4: // DateTime
      return (
        <div className="flex flex-col gap-1">
          <span className="text-xs text-gray-500">Date/Time</span>
          <input type="datetime-local" value={value || ''}
            onChange={e => onChange(e.target.value)}
            className="w-64 rounded bg-gray-950 px-3 py-1.5 text-sm text-white outline-none focus:border-blue-400 border border-gray-800" />
        </div>
      )
    case 5: // Trigger
      return (
        <button onClick={() => onChange(true)}
          className="rounded bg-blue-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-blue-500 transition-colors">
          Trigger
        </button>
      )
    case 6: // Slider
      return (
        <div className="flex flex-col gap-1">
          <span className="text-xs text-gray-500">Value: {value ?? 50}</span>
          <div className="flex items-center gap-3">
            <span className="text-xs text-gray-500">0</span>
            <input type="range" min={0} max={100} step={1} value={value ?? 50}
              onChange={e => onChange(parseInt(e.target.value))}
              className="flex-1 accent-blue-500" />
            <span className="text-xs text-gray-500">100</span>
          </div>
        </div>
      )
    default: // None
      return <span className="text-xs text-gray-500 italic">No control</span>
  }
}

// ---------------------------------------------------------------------------
// Widget Element Editor
// ---------------------------------------------------------------------------

function WidgetElementEditor({ element, onUpdateElement, onDelete }: {
  element: Element
  onUpdateElement: (id: string, data: Record<string, any>) => void
  onDelete: (id: string) => void
}) {
  const props = element.properties || {}

  const updateProp = (key: string, value: any) => {
    onUpdateElement(element.id, { properties: { ...props, [key]: value } })
  }

  return (
    <div className="rounded-lg border border-gray-800 bg-gray-900 p-4 space-y-4">
      <div className="flex items-center justify-between">
        <h4 className="font-semibold">{element.name}</h4>
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-2 text-sm text-gray-400">
            <input type="checkbox" checked={element.enabled}
              onChange={e => onUpdateElement(element.id, { enabled: e.target.checked })}
              className="accent-blue-500" />
            Enabled
          </label>
          <button onClick={() => onDelete(element.id)} className="text-xs text-red-400 hover:text-red-300">Delete</button>
        </div>
      </div>

      <TextInput label="Name" value={element.name} onChange={v => onUpdateElement(element.id, { name: v })} />

      <div className="flex flex-col gap-1">
        <span className="text-xs text-gray-500">Control Type</span>
        <select value={props.controlType ?? 0}
          onChange={e => updateProp('controlType', parseInt(e.target.value))}
          className="w-48 rounded bg-gray-950 px-3 py-1.5 text-sm text-white outline-none focus:border-blue-400 border border-gray-800">
          {CONTROL_TYPES.map(ct => (
            <option key={ct.value} value={ct.value}>{ct.label}</option>
          ))}
        </select>
      </div>

      <WidgetValueEditor controlType={props.controlType ?? 0} value={props.value} onChange={v => updateProp('value', v)} />

      <NumberInput label="Display Order" value={props.order ?? 0} onChange={v => updateProp('order', v)} />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Moderation Panel
// ---------------------------------------------------------------------------

interface ModerationAction {
  id: string
  type: string
  detail: string
  timestamp: Date
}

function ModerationPanel({ sendMessage }: { sendMessage: (type: string, payload: any) => void }) {
  const [msgText, setMsgText] = useState('')
  const [msgColor, setMsgColor] = useState('#ffffff')
  const [msgFontSize, setMsgFontSize] = useState(16)
  const [msgDelay, setMsgDelay] = useState(5000)
  const [crashTarget, setCrashTarget] = useState('')
  const [actions, setActions] = useState<ModerationAction[]>([])

  const addAction = (type: string, detail: string) => {
    setActions(prev => [{ id: crypto.randomUUID(), type, detail, timestamp: new Date() }, ...prev].slice(0, 50))
  }

  const handleSendMessage = () => {
    if (!msgText.trim()) return
    sendMessage('scene_moderator_message', {
      message: msgText,
      color: msgColor,
      fontSize: msgFontSize,
      delay: msgDelay,
    })
    addAction('Message', msgText)
    setMsgText('')
  }

  const handleCrashUser = () => {
    if (!crashTarget.trim()) return
    sendMessage('scene_moderator_crash', { connectedWallet: crashTarget })
    addAction('Crash', crashTarget)
    setCrashTarget('')
  }

  return (
    <div className="space-y-6">
      {/* Send Message */}
      <div className="rounded-lg border border-gray-800 bg-gray-900 p-4 space-y-4">
        <h4 className="font-semibold">Send Message</h4>
        <div className="flex flex-col gap-1">
          <span className="text-xs text-gray-500">Message Text</span>
          <textarea value={msgText} onChange={e => setMsgText(e.target.value)}
            placeholder="Type a message to display in-world..."
            className="w-full rounded bg-gray-950 px-3 py-2 text-sm text-white outline-none resize-y min-h-[60px] focus:border-blue-400 border border-gray-800" />
        </div>
        <div className="flex items-end gap-4">
          <div className="flex flex-col gap-1">
            <span className="text-xs text-gray-500">Color</span>
            <input type="color" value={msgColor} onChange={e => setMsgColor(e.target.value)}
              className="h-8 w-12 rounded bg-gray-800 border border-gray-700 cursor-pointer" />
          </div>
          <NumberInput label="Font Size" value={msgFontSize} onChange={setMsgFontSize} />
          <NumberInput label="Delay (ms)" value={msgDelay} onChange={setMsgDelay} />
          <button onClick={handleSendMessage}
            className="rounded bg-blue-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-blue-500 transition-colors disabled:opacity-50"
            disabled={!msgText.trim()}>
            Send
          </button>
        </div>
      </div>

      {/* Crash User */}
      <div className="rounded-lg border border-gray-800 bg-gray-900 p-4 space-y-4">
        <h4 className="font-semibold">Crash User</h4>
        <div className="flex items-end gap-4">
          <div className="flex-1">
            <TextInput label="Wallet / User ID" value={crashTarget} onChange={setCrashTarget} />
          </div>
          <button onClick={handleCrashUser}
            className="rounded bg-red-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-red-500 transition-colors disabled:opacity-50"
            disabled={!crashTarget.trim()}>
            Crash
          </button>
        </div>
      </div>

      {/* Recent Actions */}
      <div className="rounded-lg border border-gray-800 bg-gray-900 p-4 space-y-3">
        <h4 className="font-semibold">Recent Actions</h4>
        {actions.length === 0 ? (
          <p className="text-gray-500 text-sm">No moderation actions yet.</p>
        ) : (
          <div className="space-y-2 max-h-64 overflow-y-auto">
            {actions.map(action => (
              <div key={action.id} className="flex items-center gap-3 text-sm border-b border-gray-800 pb-2">
                <Badge tone={action.type === 'Message' ? 'info' : 'danger'}>{action.type}</Badge>
                <span className="text-gray-400 truncate flex-1">{action.detail}</span>
                <span className="text-xs text-gray-600 whitespace-nowrap">{action.timestamp.toLocaleTimeString()}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main Scene Editor Page
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Collaborators Section
// ---------------------------------------------------------------------------

interface Collaborator {
  userId: string
  displayName: string
  email: string | null
  role: string
}

function CollaboratorsSection({ sceneId, api, currentUserId }: {
  sceneId: string
  api: ReturnType<typeof import('@/lib/api').useApi>
  currentUserId: string
}) {
  const [collaborators, setCollaborators] = useState<Collaborator[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')
  const [email, setEmail] = useState('')
  const [role, setRole] = useState<'editor' | 'viewer'>('editor')
  const [adding, setAdding] = useState(false)

  const isOwner = collaborators.some(c => c.userId === currentUserId && c.role === 'owner')

  const loadCollaborators = useCallback(async () => {
    try {
      const data = await api.getSceneCollaborators(sceneId)
      setCollaborators(data.collaborators)
      setError('')
    } catch (err: any) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }, [api, sceneId])

  useEffect(() => {
    loadCollaborators()
  }, [loadCollaborators])

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!email.trim()) return
    setAdding(true)
    setError('')
    setSuccess('')
    try {
      const data = await api.addSceneCollaborator(sceneId, email.trim(), role)
      setCollaborators(prev => [...prev, data.collaborator])
      setEmail('')
      setSuccess(`Added ${data.collaborator.displayName || data.collaborator.email} as ${role}`)
      setTimeout(() => setSuccess(''), 3000)
    } catch (err: any) {
      setError(err.message)
    } finally {
      setAdding(false)
    }
  }

  const handleChangeRole = async (userId: string, newRole: string) => {
    setError('')
    try {
      await api.updateSceneCollaborator(sceneId, userId, newRole)
      setCollaborators(prev =>
        prev.map(c => c.userId === userId ? { ...c, role: newRole } : c)
      )
    } catch (err: any) {
      setError(err.message)
    }
  }

  const handleRemove = async (userId: string) => {
    setError('')
    try {
      await api.removeSceneCollaborator(sceneId, userId)
      setCollaborators(prev => prev.filter(c => c.userId !== userId))
    } catch (err: any) {
      setError(err.message)
    }
  }

  const roleTone = (r: string): Tone => (r === 'owner' ? 'violet' : r === 'editor' ? 'info' : 'neutral')

  return (
    <div className="rounded-lg border border-gray-800 bg-gray-900 p-4 space-y-4">
      <h3 className="text-lg font-semibold">Collaborators</h3>

      {error && (
        <div className="rounded-md bg-red-900/30 border border-red-800 px-3 py-2 text-sm text-red-400">
          {error}
        </div>
      )}
      {success && (
        <div className="rounded-md bg-green-900/30 border border-green-800 px-3 py-2 text-sm text-green-400">
          {success}
        </div>
      )}

      {loading ? (
        <Skeleton rows={2} className="h-12" />
      ) : (
        <div className="space-y-2">
          {collaborators.map(c => (
            <div key={c.userId} className="flex items-center justify-between rounded-md border border-gray-700 bg-gray-800/50 px-3 py-2">
              <div className="flex items-center gap-3 min-w-0">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-white truncate">{c.displayName}</p>
                  {c.email && <p className="text-xs text-gray-500 truncate">{c.email}</p>}
                </div>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                {c.role === 'owner' ? (
                  <Badge tone={roleTone(c.role)}>{c.role}</Badge>
                ) : isOwner ? (
                  <select
                    value={c.role}
                    onChange={e => handleChangeRole(c.userId, e.target.value)}
                    className="rounded bg-gray-700 px-2 py-1 text-xs text-white outline-none focus:border-blue-400 border border-gray-800"
                  >
                    <option value="editor">editor</option>
                    <option value="viewer">viewer</option>
                  </select>
                ) : (
                  <Badge tone={roleTone(c.role)}>{c.role}</Badge>
                )}
                {c.role !== 'owner' && (isOwner || c.userId === currentUserId) && (
                  <button
                    onClick={() => handleRemove(c.userId)}
                    className="text-xs text-red-400 hover:text-red-300"
                  >
                    Remove
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {isOwner && (
        <form onSubmit={handleAdd} className="flex items-end gap-2 pt-2 border-t border-gray-800">
          <div className="flex-1">
            <label className="text-xs text-gray-500 mb-1 block">Email</label>
            <input
              type="email"
              value={email}
              onChange={e => setEmail(e.target.value)}
              placeholder="user@example.com"
              className="w-full rounded bg-gray-950 px-3 py-1.5 text-sm text-white outline-none focus:border-blue-400 border border-gray-800"
              required
            />
          </div>
          <div>
            <label className="text-xs text-gray-500 mb-1 block">Role</label>
            <select
              value={role}
              onChange={e => setRole(e.target.value as 'editor' | 'viewer')}
              className="rounded bg-gray-950 px-3 py-1.5 text-sm text-white outline-none focus:border-blue-400 border border-gray-800"
            >
              <option value="editor">Editor</option>
              <option value="viewer">Viewer</option>
            </select>
          </div>
          <button
            type="submit"
            disabled={adding || !email.trim()}
            className="rounded bg-blue-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-blue-500 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {adding ? 'Adding...' : 'Add'}
          </button>
        </form>
      )}
    </div>
  )
}

export default function SceneEditorPage() {
  const params = useParams()
  const searchParams = useSearchParams()
  const sceneId = (searchParams.get('id') || params.sceneId) as string
  const { token, user } = useAuth()
  const api = useApi()
  const { room, connected, sendMessage } = useSceneRoom(sceneId, token)

  const [scene, setScene] = useState<Scene | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [activeTab, setActiveTab] = useState<TabKey>('video')
  const [copied, setCopied] = useState(false)
  const { connected: linked, reload: reloadConnected } = useConnected(sceneId)
  /** The name before this visit's last rename, while "Use the new name everywhere?" can still compare against it. */
  const [renamedFrom, setRenamedFrom] = useState<string | null>(null)
  const [namePanel, setNamePanel] = useState(false)

  // -----------------------------------------------------------------------
  // Load scene
  // -----------------------------------------------------------------------

  useEffect(() => {
    if (!token || !sceneId || sceneId === '_') return
    api.getScene(sceneId)
      .then(data => { setScene(data.scene); setLoading(false) })
      .catch(err => { setError(err.message); setLoading(false) })
  }, [token, sceneId])

  // -----------------------------------------------------------------------
  // Listen for Colyseus broadcasts
  // -----------------------------------------------------------------------

  useEffect(() => {
    if (!room) return

    const handler = (message: any) => {
      // Update local state based on incoming broadcast
      setScene(prev => {
        if (!prev) return prev
        return applyRemoteUpdate(prev, message)
      })
    }

    room.onMessage('scene_preset_update', handler)

    return () => {
      // Colyseus SDK does not have a removeListener for onMessage in all versions,
      // but the room cleanup on unmount handles this via the parent useEffect.
    }
  }, [room])

  // -----------------------------------------------------------------------
  // Apply remote update to local scene state
  // -----------------------------------------------------------------------

  const applyRemoteUpdate = useCallback((scene: Scene, message: any): Scene => {
    const { action, element: elType, elementData, instanceData } = message

    return {
      ...scene,
      presets: scene.presets.map(preset => ({
        ...preset,
        elements: preset.elements.map(el => {
          // Match element update
          if (action === 'update' && elementData && el.id === elementData.id) {
            return {
              ...el,
              ...elementData,
              properties: { ...el.properties, ...(elementData.properties || {}) },
              instances: el.instances, // keep instances unless explicitly included
            }
          }

          // Match instance update
          if (instanceData && el.instances.some(i => i.id === instanceData.id)) {
            return {
              ...el,
              instances: el.instances.map(inst =>
                inst.id === instanceData.id ? { ...inst, ...instanceData } : inst
              ),
            }
          }

          return el
        }),
      })),
    }
  }, [])

  // -----------------------------------------------------------------------
  // Get active preset elements
  // -----------------------------------------------------------------------

  const activePreset = scene?.presets?.[0] // Use first preset as active for now
  const elements = activePreset?.elements || []
  const filteredElements = activeTab === 'moderation' || activeTab === 'roles' || activeTab === 'ar' ? [] : elements.filter(el => el.type === activeTab)

  // -----------------------------------------------------------------------
  // Update handlers
  // -----------------------------------------------------------------------

  const handleUpdateElement = useCallback(async (elementId: string, data: Record<string, any>) => {
    try {
      // The server broadcasts the full element upsert to the scene room after this write.
      await api.updateElement(elementId, data)

      // Update local state
      setScene(prev => {
        if (!prev) return prev
        return {
          ...prev,
          presets: prev.presets.map(preset => ({
            ...preset,
            elements: preset.elements.map(el => {
              if (el.id !== elementId) return el
              return {
                ...el,
                ...data,
                properties: data.properties ? { ...el.properties, ...data.properties } : el.properties,
              }
            }),
          })),
        }
      })
    } catch (err: any) {
      console.error('Failed to update element:', err)
    }
  }, [api])

  // The server already wrote the element (and told the scene room): local state only.
  const handleRoomSetSaved = useCallback((elementId: string, modelSrc: string) => {
    setScene(prev => prev && {
      ...prev,
      presets: prev.presets.map(preset => ({
        ...preset,
        elements: preset.elements.map(el => (el.id === elementId ? { ...el, properties: { ...el.properties, modelSrc } } : el)),
      })),
    })
  }, [])

  const handleUpdateInstance = useCallback(async (instanceId: string, data: Partial<Instance>) => {
    try {
      await api.updateInstance(instanceId, data)

      // Update local state
      setScene(prev => {
        if (!prev) return prev
        return {
          ...prev,
          presets: prev.presets.map(preset => ({
            ...preset,
            elements: preset.elements.map(el => ({
              ...el,
              instances: el.instances.map(inst =>
                inst.id === instanceId ? { ...inst, ...data } : inst
              ),
            })),
          })),
        }
      })
    } catch (err: any) {
      console.error('Failed to update instance:', err)
    }
  }, [api])

  const handleDeleteInstance = useCallback(async (instanceId: string) => {
    try {
      await api.deleteInstance(instanceId)

      // Remove from local state
      setScene(prev => {
        if (!prev) return prev
        return {
          ...prev,
          presets: prev.presets.map(preset => ({
            ...preset,
            elements: preset.elements.map(el => ({
              ...el,
              instances: el.instances.filter(inst => inst.id !== instanceId),
            })),
          })),
        }
      })
    } catch (err: any) {
      console.error('Failed to delete instance:', err)
    }
  }, [api])

  const handleAddInstance = useCallback(async (elementId: string) => {
    try {
      const { instance } = await api.createInstance(elementId, {
        position: { x: 8, y: 1, z: 8 },
        rotation: { x: 0, y: 0, z: 0 },
        scale: { x: 1, y: 1, z: 1 },
        enabled: true,
      })

      // Add to local state
      setScene(prev => {
        if (!prev) return prev
        return {
          ...prev,
          presets: prev.presets.map(preset => ({
            ...preset,
            elements: preset.elements.map(el => {
              if (el.id !== elementId) return el
              return { ...el, instances: [...el.instances, instance] }
            }),
          })),
        }
      })
    } catch (err: any) {
      console.error('Failed to create instance:', err)
    }
  }, [api])

  // -----------------------------------------------------------------------
  // Widget: Add / Delete
  // -----------------------------------------------------------------------

  const handleAddElement = useCallback(async (type: ElementType) => {
    if (!activePreset) return
    const count = elements.filter(e => e.type === type).length + 1
    const defaults: Record<ElementType, Record<string, any>> = {
      video: { liveSrc: '', offType: 0, volume: 1, isLive: false },
      image: { textureSrc: '' },
      model: { modelSrc: '' },
      sound: { audioSrc: '', volume: 1, loop: false },
      widget: { controlType: 1, value: false, order: 0 },
      ad_space: { shape: '16:9', formats: 'both' },
    }
    try {
      const { element } = await api.createElement(activePreset.id, {
        type,
        name: `${ELEMENT_TYPE_LABELS[type]} ${count}`,
        enabled: true,
        properties: defaults[type],
      })
      const { instance } = await api.createInstance(element.id, {
        position: { x: 8, y: 1, z: 8 },
        rotation: { x: 0, y: 0, z: 0 },
        scale: { x: 1, y: 1, z: 1 },
        enabled: true,
      })
      setScene(prev => {
        if (!prev) return prev
        return {
          ...prev,
          presets: prev.presets.map(preset => {
            if (preset.id !== activePreset.id) return preset
            return { ...preset, elements: [...preset.elements, { ...element, instances: [instance] }] }
          }),
        }
      })
    } catch (err: any) {
      console.error(`Failed to add ${type}:`, err)
    }
  }, [api, activePreset, elements])

  const handleAddWidget = useCallback(async () => {
    if (!activePreset) return
    try {
      const { element } = await api.createElement(activePreset.id, {
        type: 'widget',
        name: `Widget ${elements.filter(e => e.type === 'widget').length + 1}`,
        enabled: true,
        properties: { controlType: 1, value: false, order: 0 },
      })
      // Add to local state (widgets have no instances)
      setScene(prev => {
        if (!prev) return prev
        return {
          ...prev,
          presets: prev.presets.map(preset => {
            if (preset.id !== activePreset.id) return preset
            return { ...preset, elements: [...preset.elements, { ...element, instances: [] }] }
          }),
        }
      })
    } catch (err: any) {
      console.error('Failed to add widget:', err)
    }
  }, [api, activePreset, elements])

  const handleDeleteWidget = useCallback(async (elementId: string) => {
    try {
      await api.deleteElement(elementId)
      setScene(prev => {
        if (!prev) return prev
        return {
          ...prev,
          presets: prev.presets.map(preset => ({
            ...preset,
            elements: preset.elements.filter(el => el.id !== elementId),
          })),
        }
      })
    } catch (err: any) {
      console.error('Failed to delete widget:', err)
    }
  }, [api])

  // -----------------------------------------------------------------------
  // Copy scene ID
  // -----------------------------------------------------------------------

  const renameScene = async (name: string) => {
    const old = scene?.name ?? ''
    const { scene: updated } = await api.updateScene(sceneId, { name })
    setScene((prev) => (prev ? { ...prev, name: updated.name } : prev))
    if (updated.name === old) return
    setRenamedFrom(old)
    await reloadConnected()
    setNamePanel(true)
  }

  const copySceneId = () => {
    navigator.clipboard.writeText(sceneId)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  // -----------------------------------------------------------------------
  // Render
  // -----------------------------------------------------------------------

  if (loading) return <Skeleton />
  if (error) return <p className="text-red-400">Error: {error}</p>
  if (!scene) return <p className="text-gray-400">Scene not found.</p>

  return (
    <div className="space-y-6">
      <PageHeader
        crumbs={['Workspace', { label: 'Scenes', href: '/scenes' }, scene.name]}
        title={<EditableSceneTitle name={scene.name} onSave={renameScene} />}
        subtitle={
          <>
            {!namePanel && hasConnected(linked) && (
              <button type="button" onClick={() => setNamePanel(true)} className="mb-1 text-xs text-blue-400 hover:text-blue-300">
                {connectedNamesDiffer(linked, scene.name) ? 'Names differ — update?' : 'Use name everywhere'}
              </button>
            )}
            <div className="flex items-center gap-2">
              <code className="text-sm text-gray-500 font-mono">{sceneId}</code>
              <button onClick={copySceneId} className="text-xs text-blue-400 hover:text-blue-300">
                {copied ? 'Copied!' : 'Copy ID'}
              </button>
            </div>
            {activePreset && <p className="mt-1 text-sm text-gray-500">Preset: {activePreset.name}</p>}
          </>
        }
        actions={
          <Badge tone={connected ? 'success' : 'neutral'}>
            <span className={`inline-block h-1.5 w-1.5 rounded-full ${connected ? 'bg-green-400' : 'bg-gray-600'}`} />
            {connected ? 'Connected' : 'Disconnected'}
          </Badge>
        }
      />

      {namePanel && linked && hasConnected(linked) && (
        <UseNameEverywhere key={`${scene.name}:${renamedFrom ?? ''}`} sceneName={scene.name} oldName={renamedFrom} connected={linked}
          hasRoomSet={sceneHasRoomSet(scene.presets.flatMap((p) => p.elements))}
          onDone={reloadConnected} onClose={() => setNamePanel(false)} />
      )}

      {/* Tabs */}
      <div className="flex gap-1 border-b border-gray-800 pb-px">
        {TABS.map(tab => {
          const count = tab.key === 'moderation' || tab.key === 'roles' || tab.key === 'ar' ? 0 : elements.filter(el => el.type === tab.key).length
          return (
            <button key={tab.key} onClick={() => setActiveTab(tab.key)}
              className={`px-4 py-2 text-sm font-medium rounded-t-lg transition-colors ${
                activeTab === tab.key
                  ? 'bg-gray-800 text-white border-b-2 border-blue-500'
                  : 'text-gray-500 hover:text-gray-300 hover:bg-gray-800/50'
              }`}>
              {tab.label} {count > 0 && <span className="ml-1 text-xs text-gray-500">({count})</span>}
            </button>
          )
        })}
      </div>

      {/* Moderation tab */}
      {activeTab === 'moderation' && (
        <ModerationPanel sendMessage={sendMessage} />
      )}

      {/* Roles tab */}
      {activeTab === 'roles' && <SceneRoles sceneId={sceneId} />}

      {/* AR spaces tab */}
      {activeTab === 'ar' && <ArSpaces sceneId={sceneId} />}

      {/* Widget tab */}
      {activeTab === 'widget' && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <p className="text-sm text-gray-400">Widgets ({filteredElements.length})</p>
            <button onClick={handleAddWidget} className="rounded bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-500 transition-colors">
              + Add Widget
            </button>
          </div>
          {filteredElements.length === 0 ? (
            <p className="text-gray-500 text-sm py-8 text-center">No widgets in this preset.</p>
          ) : (
            filteredElements
              .sort((a, b) => (a.properties?.order ?? 0) - (b.properties?.order ?? 0))
              .map(el => (
                <WidgetElementEditor key={el.id} element={el}
                  onUpdateElement={handleUpdateElement}
                  onDelete={handleDeleteWidget} />
              ))
          )}
        </div>
      )}

      {/* Element list (video/image/model/sound) */}
      {activeTab !== 'moderation' && activeTab !== 'widget' && activeTab !== 'roles' && activeTab !== 'ar' && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <p className="text-sm text-gray-400">{ELEMENT_TYPE_LABELS[activeTab as ElementType]}s ({filteredElements.length})</p>
            <button onClick={() => handleAddElement(activeTab as ElementType)}
              className="rounded bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-500 transition-colors">
              + Add {ELEMENT_TYPE_LABELS[activeTab as ElementType]}
            </button>
          </div>
          {filteredElements.length === 0 ? (
            <p className="text-gray-500 text-sm py-8 text-center">No {ELEMENT_TYPE_LABELS[activeTab as ElementType].toLowerCase()} elements in this preset.</p>
          ) : (
            filteredElements.map(el => {
              const editorProps = {
                element: el,
                onUpdateElement: handleUpdateElement,
                onUpdateInstance: handleUpdateInstance,
                onDeleteInstance: handleDeleteInstance,
                onAddInstance: handleAddInstance,
              }

              switch (el.type) {
                case 'video': return <VideoElementEditor key={el.id} {...editorProps} sceneId={sceneId} api={api} />
                case 'image': return <ImageElementEditor key={el.id} {...editorProps} sceneId={sceneId} api={api} />
                case 'model': return <ModelElementEditor key={el.id} {...editorProps} onRoomSetSaved={handleRoomSetSaved} api={api} />
                case 'sound': return <SoundElementEditor key={el.id} {...editorProps} />
                case 'ad_space': return <AdSpaceElementEditor key={el.id} {...editorProps} sceneId={sceneId} api={api} />
                default: return null
              }
            })
          )}
        </div>
      )}

      {/* Collaborators */}
      <CollaboratorsSection sceneId={sceneId} api={api} currentUserId={user?.id || ''} />
    </div>
  )
}
