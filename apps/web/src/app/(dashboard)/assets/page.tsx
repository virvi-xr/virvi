'use client'
import { useApi, fileToBase64 } from '@/lib/api'
import { ASSET_LIBRARY } from '@/lib/libraries'
import { useAuth } from '@/lib/auth'
import { useEffect, useState, useRef, useCallback } from 'react'
import { useSearchParams, useRouter } from 'next/navigation'
import { CATALOG_STYLES, CATALOG_VENUES, type CatalogPack } from '@virvixr/shared'
import Link from 'next/link'
import { creditLine, licenseLabel } from '@/lib/catalog'
import { countLabel, formatBytes, plural } from '@/lib/format'
import { CubeIcon, GridIcon, LayersIcon, ListIcon, PlusIcon } from '@/components/icons'
import { RoomAssetDialog } from './RoomAssetDialog'
import { assetListScope, assetViewHref, readAssetView, visibilityLabel, type AssetView, type MineKind } from '@/lib/asset-views'
import { Badge, ConfirmAction, EmptyState, PageHeader, PrimaryButton, RowMenu, SearchField, SelectField, useStoredView, ViewToggle, Skeleton } from '@/components/ui'

const VIEW_KEY = 'virvi.assets.view'
const fieldClass = 'w-full rounded-md border border-gray-800 bg-gray-950 px-3 py-2 text-sm outline-none focus:border-blue-400'
const assetHref = (id: string) => `/assets?id=${id}`

/** Private assets always say so; `showPublic` (My Models, the detail page) labels public ones too. */
function VisibilityBadge({ asset, showPublic = false }: { asset: any; showPublic?: boolean }) {
  if (asset.isPublic && !showPublic) return null
  return <Badge tone={asset.isPublic ? 'neutral' : 'violet'}>{visibilityLabel(asset)}</Badge>
}

function formatTriangles(count: number): string {
  if (count >= 1_000_000) return (count / 1_000_000).toFixed(1) + 'M'
  if (count >= 1_000) return (count / 1_000).toFixed(1) + 'K'
  return String(count)
}

// ── Upload Form ─────────────────────────────────────────────────────────────

function UploadForm({ onUploaded, onClose }: { onUploaded: (asset: any) => void; onClose: () => void }) {
  const api = useApi()
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [category, setCategory] = useState('')
  const [tagsInput, setTagsInput] = useState('')
  const [license, setLicense] = useState('cc0')
  const [author, setAuthor] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  const reset = () => {
    setName('')
    setDescription('')
    setCategory('')
    setTagsInput('')
    setLicense('cc0')
    setAuthor('')
    setFile(null)
    if (fileRef.current) fileRef.current.value = ''
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!file || !name) return
    setUploading(true)
    setError(null)
    try {
      const base64 = await fileToBase64(file)
      const tags = tagsInput
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean)
      const contentType = 'model/gltf-binary'
      const { asset } = await api.uploadAsset({
        name,
        description: description || undefined,
        category: category || undefined,
        tags: tags.length > 0 ? tags : undefined,
        fileData: base64,
        contentType,
        filename: file.name,
        license: license || undefined,
        author: author || undefined,
      })
      onUploaded(asset)
      reset()
      onClose()
    } catch (err: any) {
      setError('Upload failed: ' + (err.message || 'Unknown error'))
    } finally {
      setUploading(false)
    }
  }

  return (
        <form onSubmit={handleSubmit} className="mb-6 space-y-4 rounded-lg border border-gray-800 bg-gray-900 p-5">
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <div>
              <label className="block text-xs text-gray-400 mb-1">File (.glb) *</label>
              <input
                ref={fileRef}
                type="file"
                accept=".glb"
                onChange={(e) => {
                  const f = e.target.files?.[0] || null
                  setFile(f)
                  if (f && !name) setName(f.name.replace(/\.(glb|gltf)$/i, ''))
                }}
                className={fieldClass}
              />
            </div>
            <div>
              <label className="block text-xs text-gray-400 mb-1">Name *</label>
              <input aria-label="Name"
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Model name"
                className={fieldClass}
              />
            </div>
            <div className="md:col-span-2">
              <label className="block text-xs text-gray-400 mb-1">Description</label>
              <textarea aria-label="Description"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={2}
                placeholder="Optional description"
                className={fieldClass}
              />
            </div>
            <div>
              <label className="block text-xs text-gray-400 mb-1">Category</label>
              <input aria-label="Category"
                type="text"
                value={category}
                onChange={(e) => setCategory(e.target.value)}
                placeholder="e.g. architecture, nature, furniture"
                className={fieldClass}
              />
            </div>
            <div>
              <label className="block text-xs text-gray-400 mb-1">Tags (comma separated)</label>
              <input aria-label="Tags (comma separated)"
                type="text"
                value={tagsInput}
                onChange={(e) => setTagsInput(e.target.value)}
                placeholder="modern, outdoor, low-poly"
                className={fieldClass}
              />
            </div>
            <div>
              <label className="block text-xs text-gray-400 mb-1">License</label>
              <select aria-label="License"
                value={license}
                onChange={(e) => setLicense(e.target.value)}
                className={fieldClass}
              >
                <option value="cc0">CC0 (Public Domain)</option>
                <option value="cc-by">CC-BY (Attribution)</option>
                <option value="proprietary">Proprietary</option>
              </select>
            </div>
            <div>
              <label className="block text-xs text-gray-400 mb-1">Author</label>
              <input aria-label="Author"
                type="text"
                value={author}
                onChange={(e) => setAuthor(e.target.value)}
                placeholder="Author name"
                className={fieldClass}
              />
            </div>
          </div>
          {error && <p className="text-sm text-red-400" role="alert">{error}</p>}
          <div className="flex flex-wrap items-center justify-end gap-2">
            <p className="mr-auto max-w-md text-xs text-gray-500">{ASSET_LIBRARY.uploadHelp}</p>
            <button type="button" onClick={onClose} className="rounded-md bg-gray-800 px-4 py-2 text-sm hover:bg-gray-700">
              Cancel
            </button>
            <button
              type="submit"
              disabled={uploading || !file || !name}
              className="rounded-md bg-blue-600 px-5 py-2 text-sm font-medium hover:bg-blue-700 disabled:opacity-50"
            >
              {uploading ? 'Uploading...' : 'Upload'}
            </button>
          </div>
        </form>
  )
}

// ── Asset Detail View ───────────────────────────────────────────────────────

function AssetDetail({ assetId, onDeleted }: { assetId: string; onDeleted: (id: string) => void }) {
  const api = useApi()
  const { token } = useAuth()
  const [asset, setAsset] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [editing, setEditing] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  // Edit state
  const [editName, setEditName] = useState('')
  const [editDescription, setEditDescription] = useState('')
  const [editCategory, setEditCategory] = useState('')
  const [editTags, setEditTags] = useState('')

  useEffect(() => {
    if (!token) return
    setLoading(true)
    api.getAsset(assetId)
      .then((data) => {
        setAsset(data.asset)
        setLoading(false)
      })
      .catch(() => setLoading(false))
  }, [token, assetId])

  const startEditing = () => {
    if (!asset) return
    setEditName(asset.name)
    setEditDescription(asset.description || '')
    setEditCategory(asset.category || '')
    setEditTags((asset.tags || []).join(', '))
    setEditing(true)
  }

  const handleSave = async () => {
    setSaving(true)
    setError(null)
    try {
      const tags = editTags
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean)
      const { asset: updated } = await api.updateAsset(assetId, {
        name: editName,
        description: editDescription || null,
        category: editCategory || null,
        tags: tags.length > 0 ? tags : null,
      })
      setAsset(updated)
      setEditing(false)
    } catch (err: any) {
      setError('Save failed: ' + (err.message || 'Unknown error'))
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async () => {
    try {
      await api.deleteAsset(assetId)
      onDeleted(assetId)
    } catch (err: any) {
      setError('Delete failed: ' + (err.message || 'Unknown error'))
    }
  }

  const copyUrl = () => {
    if (asset?.cdnUrl) {
      navigator.clipboard.writeText(asset.cdnUrl)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    }
  }

  if (loading) return <Skeleton />
  if (!asset) return <p className="text-gray-500">Model not found.</p>

  // Uploads store { width, height, depth }; catalog models store their bounding box { x, y, z } in meters
  const raw = asset.dimensions as { width?: number; height?: number; depth?: number; x?: number; y?: number; z?: number } | null
  const dims = raw ? { width: raw.width ?? raw.x, height: raw.height ?? raw.y, depth: raw.depth ?? raw.z } : null

  return (
    <div className="mx-auto max-w-7xl">
      <PageHeader
        crumbs={['Tools', { label: ASSET_LIBRARY.name, href: '/assets' }, asset.name]}
        title={asset.name}
        subtitle={asset.description || undefined}
        actions={!asset.packId && !editing && (
          // Catalog models are Virvi's, not yours: view and add only
          <div className="flex items-center gap-2">
            <button onClick={startEditing} className="rounded-md bg-gray-800 px-3 py-1.5 text-xs hover:bg-gray-700">Edit</button>
            <ConfirmAction prompt="Delete this model?" confirmLabel="Delete" onConfirm={handleDelete}
              className="rounded-md bg-red-900/30 px-3 py-1.5 text-xs text-red-400 hover:bg-red-900/50">
              Delete
            </ConfirmAction>
          </div>
        )}
      />

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        {/* Thumbnail */}
        <div className="lg:col-span-1">
          <div className="rounded-lg border border-gray-800 bg-gray-900 overflow-hidden aspect-square flex items-center justify-center">
            {asset.thumbnailUrl ? (
              <img src={asset.thumbnailUrl} alt={asset.name} className="w-full h-full object-cover" />
            ) : (
              <div className="text-center text-gray-500">
                <div className="text-5xl mb-2">&#9651;</div>
                <div className="text-xs">3D model</div>
              </div>
            )}
          </div>
        </div>

        {/* Metadata */}
        <div className="lg:col-span-2 space-y-4">
          {error && <p className="text-sm text-red-400" role="alert">{error}</p>}
          {editing ? (
            <div className="space-y-3">
              <div>
                <label className="block text-xs text-gray-400 mb-1">Name</label>
                <input aria-label="Name"
                  type="text"
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  className="w-full rounded-md bg-gray-950 px-3 py-2 text-sm outline-none focus:border-blue-400 border border-gray-800"
                />
              </div>
              <div>
                <label className="block text-xs text-gray-400 mb-1">Description</label>
                <textarea aria-label="Description"
                  value={editDescription}
                  onChange={(e) => setEditDescription(e.target.value)}
                  rows={3}
                  className="w-full rounded-md bg-gray-950 px-3 py-2 text-sm outline-none focus:border-blue-400 border border-gray-800"
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs text-gray-400 mb-1">Category</label>
                  <input aria-label="Category"
                    type="text"
                    value={editCategory}
                    onChange={(e) => setEditCategory(e.target.value)}
                    className="w-full rounded-md bg-gray-950 px-3 py-2 text-sm outline-none focus:border-blue-400 border border-gray-800"
                  />
                </div>
                <div>
                  <label className="block text-xs text-gray-400 mb-1">Tags (comma separated)</label>
                  <input aria-label="Tags (comma separated)"
                    type="text"
                    value={editTags}
                    onChange={(e) => setEditTags(e.target.value)}
                    className="w-full rounded-md bg-gray-950 px-3 py-2 text-sm outline-none focus:border-blue-400 border border-gray-800"
                  />
                </div>
              </div>
              <div className="flex gap-2">
                <button
                  onClick={handleSave}
                  disabled={saving}
                  className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium hover:bg-blue-700 disabled:opacity-50"
                >
                  {saving ? 'Saving...' : 'Save'}
                </button>
                <button
                  onClick={() => setEditing(false)}
                  className="rounded-md bg-gray-800 px-4 py-2 text-sm hover:bg-gray-700"
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <>
              {asset.pack && <p className="text-xs text-gray-500">{creditLine(asset)}</p>}

              <AddToScene assetId={asset.id} />

              {/* Badges row */}
              <div className="flex flex-wrap items-center gap-2">
                {asset.category && <Badge tone="info">{asset.category}</Badge>}
                <VisibilityBadge asset={asset} showPublic />
                {asset.tags?.map((tag: string) => <Badge key={tag}>{tag}</Badge>)}
                {asset.license && <span className="text-xs text-gray-400 first-letter:uppercase">{licenseLabel(asset.license)}</span>}
              </div>

              {/* Stats grid */}
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <div className="rounded-lg bg-gray-900 border border-gray-800 p-3">
                  <p className="text-xs text-gray-500">File Size</p>
                  <p className="text-sm font-medium mt-0.5">{formatBytes(asset.fileSizeBytes)}</p>
                </div>
                {asset.triangleCount != null && (
                  <div className="rounded-lg bg-gray-900 border border-gray-800 p-3">
                    <p className="text-xs text-gray-500">Triangles</p>
                    <p className="text-sm font-medium mt-0.5">{formatTriangles(asset.triangleCount)}</p>
                  </div>
                )}
                {asset.textureCount != null && (
                  <div className="rounded-lg bg-gray-900 border border-gray-800 p-3">
                    <p className="text-xs text-gray-500">Textures</p>
                    <p className="text-sm font-medium mt-0.5">{asset.textureCount}</p>
                  </div>
                )}
                {asset.materialCount != null && (
                  <div className="rounded-lg bg-gray-900 border border-gray-800 p-3">
                    <p className="text-xs text-gray-500">Materials</p>
                    <p className="text-sm font-medium mt-0.5">{asset.materialCount}</p>
                  </div>
                )}
                {dims && (
                  <div className="rounded-lg bg-gray-900 border border-gray-800 p-3">
                    <p className="text-xs text-gray-500">Dimensions</p>
                    <p className="text-sm font-medium mt-0.5">
                      {dims.width?.toFixed(1)} x {dims.height?.toFixed(1)} x {dims.depth?.toFixed(1)}
                    </p>
                  </div>
                )}
                {asset.author && (
                  <div className="rounded-lg bg-gray-900 border border-gray-800 p-3">
                    <p className="text-xs text-gray-500">Author</p>
                    <p className="text-sm font-medium mt-0.5">{asset.author}</p>
                  </div>
                )}
              </div>

              {/* CDN URL */}
              {asset.cdnUrl && (
                <div>
                  <p className="text-xs text-gray-500 mb-1">CDN URL</p>
                  <div className="flex items-center gap-2">
                    <code className="flex-1 rounded-md bg-gray-800 px-3 py-2 text-xs text-gray-300 truncate block">
                      {asset.cdnUrl}
                    </code>
                    <button
                      onClick={copyUrl}
                      className="rounded-md bg-gray-800 px-3 py-2 text-xs hover:bg-gray-700 whitespace-nowrap"
                    >
                      {copied ? 'Copied!' : 'Copy'}
                    </button>
                  </div>
                </div>
              )}

              {/* Storage key */}
              <div>
                <p className="text-xs text-gray-500 mb-1">Storage Key</p>
                <code className="rounded-md bg-gray-800 px-3 py-2 text-xs text-gray-400 block">
                  {asset.storageKey}
                </code>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

// ── Add to scene ────────────────────────────────────────────────────────────

/** Links the model into one of your scenes' library, ready to place (catalog models use no storage). */
function AddToScene({ assetId }: { assetId: string }) {
  const api = useApi()
  const [scenes, setScenes] = useState<any[] | null>(null)
  const [sceneId, setSceneId] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null)

  useEffect(() => {
    api.getScenes().then((d) => {
      setScenes(d.scenes)
      if (d.scenes[0]) setSceneId(d.scenes[0].id)
    }, () => setScenes([]))
  }, [])

  const add = async () => {
    if (!sceneId) return
    setBusy(true)
    setMessage(null)
    try {
      await api.addModelToSceneLibrary(sceneId, assetId)
      const name = scenes?.find((s) => s.id === sceneId)?.name ?? 'the scene'
      setMessage({ text: `Added to ${name}, ready to place`, error: false })
    } catch (err: any) {
      setMessage({ text: err.message === 'pack_disabled' ? 'This pack is no longer available' : err.message === 'forbidden' ? "You can't add models to that scene" : 'Could not add the model', error: true })
    } finally {
      setBusy(false)
    }
  }

  if (scenes === null) return null
  if (scenes.length === 0) return <p className="text-xs text-gray-500">Create a scene to add this model to it.</p>
  return (
    <div className="rounded-lg border border-gray-800 bg-gray-900 p-3">
      <p className="text-xs text-gray-500 mb-2">Add to a scene, ready to place</p>
      <div className="flex gap-2">
        <select aria-label="Scene" value={sceneId} onChange={(e) => setSceneId(e.target.value)} className="flex-1 rounded-md bg-gray-950 px-3 py-2 text-sm outline-none focus:border-blue-400 border border-gray-800">
          {scenes.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
        <button onClick={add} disabled={busy} className="rounded-md bg-blue-600 px-4 py-2 text-sm hover:bg-blue-700 disabled:opacity-50">
          {busy ? 'Adding…' : 'Add to scene'}
        </button>
      </div>
      {message && <p className={`mt-2 text-xs ${message.error ? 'text-red-400' : 'text-green-400'}`}>{message.text}</p>}
    </div>
  )
}

// ── Main Page ───────────────────────────────────────────────────────────────

/** The catalog holds thousands of models: the list loads a page at a time. */
const PAGE_SIZE = 48

export default function AssetsPage() {
  const { token } = useAuth()
  const api = useApi()
  const router = useRouter()
  const searchParams = useSearchParams()
  const selectedId = searchParams.get('id')

  const [assets, setAssets] = useState<any[]>([])
  const [total, setTotal] = useState(0)
  const [categories, setCategories] = useState<string[]>([])
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [listError, setListError] = useState<string | null>(null)
  const [libraryTotal, setLibraryTotal] = useState<number | null>(null)
  const [showUpload, setShowUpload] = useState(false)
  const [showRoomAsset, setShowRoomAsset] = useState(false)
  const [view, chooseView] = useStoredView(VIEW_KEY, ['grid', 'list'], 'grid')

  // Filters
  const [search, setSearch] = useState('')
  const [categoryFilter, setCategoryFilter] = useState('')
  const [tagFilter, setTagFilter] = useState('')
  const [styleFilter, setStyleFilter] = useState('')
  const [venueFilter, setVenueFilter] = useState('')
  const [packFilter, setPackFilter] = useState('')
  // All Models (public) or My Models (yours: everything, Design Studio pieces, or uploads), kept in the link
  const { view: libraryView, kind: mineKind } = readAssetView(searchParams)
  const showView = (v: AssetView, k: MineKind = 'all') => router.replace(assetViewHref(v, k))
  const mine = libraryView === 'mine'
  const [packs, setPacks] = useState<CatalogPack[]>([])
  const filtering = !!(search || categoryFilter || tagFilter || styleFilter || venueFilter || packFilter)

  /** First page for the current filters, or (more) the next page appended to what's shown. */
  const fetchAssets = useCallback(async (more = false) => {
    if (more) setLoadingMore(true)
    else setLoading(true)
    try {
      const params: Record<string, string> = { limit: String(PAGE_SIZE), offset: String(more ? assets.length : 0) }
      if (search) params.q = search
      if (categoryFilter) params.category = categoryFilter
      if (tagFilter) params.tag = tagFilter
      if (styleFilter) params.style = styleFilter
      if (venueFilter) params.venue = venueFilter
      if (packFilter) params.pack = packFilter
      Object.assign(params, assetListScope(libraryView, mineKind))
      const data = await api.getAssets(params)
      setAssets((prev) => (more ? [...prev, ...data.assets] : data.assets))
      setTotal(data.total)
      if (!filtering && !mine) setLibraryTotal(data.total)
    } catch {
      // ignore
    } finally {
      setLoading(false)
      setLoadingMore(false)
    }
  }, [search, categoryFilter, tagFilter, styleFilter, venueFilter, packFilter, libraryView, mineKind, mine, filtering, token, assets.length])

  const fetchCategories = useCallback(async () => {
    try {
      const data = await api.getAssetCategories()
      setCategories(data.categories)
    } catch {
      // ignore
    }
  }, [token])

  useEffect(() => {
    if (!token) return
    fetchAssets()
  }, [token, search, categoryFilter, tagFilter, styleFilter, venueFilter, packFilter, libraryView, mineKind])

  useEffect(() => {
    if (!token) return
    fetchCategories()
    api.getCatalogPacks().then((d) => setPacks(d.packs.filter((p) => p.enabled)), () => {})
  }, [token])

  // Debounced search
  const [searchInput, setSearchInput] = useState('')
  useEffect(() => {
    const t = setTimeout(() => setSearch(searchInput), 300)
    return () => clearTimeout(t)
  }, [searchInput])

  const handleUploaded = (asset: any) => {
    fetchCategories()
    // A private upload (the default) never shows in All Models: go to My Models, where it is
    if (!mine && !asset.isPublic) { showView('mine'); return }
    setAssets((prev) => [asset, ...prev])
    setTotal((prev) => prev + 1)
    setLibraryTotal((prev) => (prev === null ? prev : prev + 1))
  }

  const handleDeleted = (id: string) => {
    setAssets((prev) => prev.filter((a) => a.id !== id))
    setTotal((prev) => prev - 1)
    setLibraryTotal((prev) => (prev === null ? prev : prev - 1))
    router.push('/assets')
  }

  // ── Detail view ───────────────────────────────────────────────────────────
  if (selectedId) {
    return (
      <AssetDetail
        assetId={selectedId}
        onDeleted={handleDeleted}
      />
    )
  }

  const clearFilters = () => {
    setSearchInput('')
    setSearch('')
    setCategoryFilter('')
    setTagFilter('')
    setStyleFilter('')
    setVenueFilter('')
    setPackFilter('')
  }

  const deleteAsset = async (id: string) => {
    setListError(null)
    try {
      await api.deleteAsset(id)
      setAssets((prev) => prev.filter((a) => a.id !== id))
      setTotal((prev) => prev - 1)
      setLibraryTotal((prev) => (prev === null ? prev : prev - 1))
    } catch (err: any) {
      setListError('Delete failed: ' + (err.message || 'Unknown error'))
    }
  }

  // ── List view ─────────────────────────────────────────────────────────────
  return (
    <div className="mx-auto max-w-7xl">
      <PageHeader
        crumbs={['Tools', ASSET_LIBRARY.name]}
        title={ASSET_LIBRARY.name}
        count={libraryTotal === null ? undefined : countLabel(libraryTotal)}
        subtitle={<>{ASSET_LIBRARY.purpose}. Images and video go in <Link href="/media" className="text-blue-300 underline">Images &amp; Video</Link>.</>}
        actions={
          <div className="flex flex-col items-end gap-2">
          <div className="flex flex-wrap justify-end gap-2">
            <button type="button" onClick={() => setShowRoomAsset(true)}
              className="rounded-md border border-gray-700 px-3 py-2 text-sm text-gray-200 hover:border-gray-600 hover:bg-white/[0.04]">
              Make a model from a room scan
            </button>
            <PrimaryButton onClick={() => setShowUpload(!showUpload)}><PlusIcon size={16} /> Upload Model</PrimaryButton>
          </div>
            <p className="max-w-md text-right text-xs text-gray-500">GLB models (≤ 50 MB). New uploads are private to you.</p>
          </div>
        }
      />
      {showRoomAsset && (
        <RoomAssetDialog onClose={() => setShowRoomAsset(false)} onCreated={(asset) => { handleUploaded(asset); setShowRoomAsset(false) }} />
      )}

      {listError && <p className="mb-4 text-sm text-red-400" role="alert">{listError}</p>}
      {showUpload && <UploadForm onUploaded={handleUploaded} onClose={() => setShowUpload(false)} />}

      <div className="mb-4 inline-flex rounded-md border border-gray-800 p-0.5 text-sm" role="tablist" aria-label="Which models">
        {([['All Models', 'all'], ['My Models', 'mine']] as const).map(([label, value]) => (
          <button key={value} type="button" role="tab" aria-selected={libraryView === value} onClick={() => showView(value)}
            className={`rounded px-3 py-1.5 ${libraryView === value ? 'bg-white/[0.06] text-white' : 'text-gray-400 hover:text-white'}`}>
            {label}
          </button>
        ))}
      </div>

      {/* Filters */}
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <SearchField value={searchInput} onChange={setSearchInput} placeholder="Search models..." label="Search models" />
        <div className="ml-auto flex items-center gap-3">
          {!loading && <span className="text-sm text-gray-400">{plural(total, 'model')}</span>}
          <ViewToggle value={view} onChange={chooseView} options={[['grid', GridIcon, 'Grid view'], ['list', ListIcon, 'List view']]} />
        </div>
      </div>
      <div className="mb-6 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-6">
        {mine && (
          <SelectField value={mineKind} onChange={(k) => showView('mine', k as MineKind)} label="Show">
            <option value="all">Everything of mine</option>
            <option value="studio">Made in Design Studio</option>
            <option value="uploads">My uploads</option>
          </SelectField>
        )}
        <SelectField value={categoryFilter} onChange={setCategoryFilter} label="Category">
          <option value="">All Categories</option>
          {categories.map((cat) => <option key={cat} value={cat}>{cat}</option>)}
        </SelectField>
        <SelectField value={styleFilter} onChange={setStyleFilter} label="Style">
          <option value="">All Styles</option>
          {CATALOG_STYLES.map((s) => <option key={s} value={s}>{s}</option>)}
        </SelectField>
        <SelectField value={venueFilter} onChange={setVenueFilter} label="Venue">
          <option value="">Any Venue</option>
          {CATALOG_VENUES.map((v) => <option key={v} value={v}>{v[0].toUpperCase() + v.slice(1)}</option>)}
        </SelectField>
        {packs.length > 0 && (
          <SelectField value={packFilter} onChange={setPackFilter} label="Pack">
            <option value="">All Packs</option>
            {packs.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </SelectField>
        )}
        <div className="flex gap-2">
          <input
            type="text"
            value={tagFilter}
            onChange={(e) => setTagFilter(e.target.value)}
            placeholder="Filter by tag..."
            aria-label="Filter by tag"
            className="w-full min-w-0 rounded-md border border-gray-800 bg-gray-900 px-3 py-2.5 text-sm outline-none placeholder:text-gray-500 focus:border-blue-400"
          />
          {filtering && (
            <button onClick={clearFilters} className="shrink-0 rounded-md border border-gray-800 px-3 text-sm text-gray-400 hover:bg-white/[0.05] hover:text-white">
              Clear
            </button>
          )}
        </div>
      </div>

      {loading ? (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4" aria-hidden="true">
          {[0, 1, 2, 3].map((i) => <div key={i} className="h-72 animate-pulse rounded-lg border border-gray-800 bg-gray-900" />)}
        </div>
      ) : assets.length === 0 ? (
        filtering ? (
          <p className="py-12 text-center text-gray-500">No models match your filters.</p>
        ) : mine ? (
          <EmptyState icon={<LayersIcon size={40} />}
            title={mineKind === 'studio' ? 'No Design Studio pieces yet' : mineKind === 'uploads' ? 'No uploads yet' : "You haven't added any models yet"}
            body={mineKind === 'studio'
              ? 'Pieces you finalize in the Design Studio show up here, ready to place in your scenes.'
              : 'Models you upload, make from a room scan or finalize in the Design Studio show up here, public or private.'}
            action={mineKind === 'studio' ? undefined : <PrimaryButton onClick={() => setShowUpload(true)}><PlusIcon size={16} /> Upload Model</PrimaryButton>} />
        ) : (
          <EmptyState icon={<LayersIcon size={40} />} title="No 3D models yet"
            body="Upload a .glb model to add it to your library and place it in your scenes."
            action={<PrimaryButton onClick={() => setShowUpload(true)}><PlusIcon size={16} /> Upload Model</PrimaryButton>} />
        )
      ) : view === 'grid' ? (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {assets.map((asset) => <AssetCard key={asset.id} asset={asset} showPublic={mine} onDelete={() => deleteAsset(asset.id)} />)}
        </div>
      ) : (
        <div className="rounded-lg border border-gray-800 bg-gray-900">
          {assets.map((asset, i) => <AssetRow key={asset.id} asset={asset} first={i === 0} showPublic={mine} onDelete={() => deleteAsset(asset.id)} />)}
        </div>
      )}
      {!loading && assets.length < total && (
        <div className="mt-6 flex justify-center">
          <button
            onClick={() => fetchAssets(true)}
            disabled={loadingMore}
            className="rounded-md border border-gray-800 bg-gray-900 px-4 py-2 text-sm text-gray-300 hover:border-gray-700 hover:text-white disabled:opacity-50"
          >
            {loadingMore ? 'Loading…' : `Load more (${assets.length.toLocaleString('en-US')} of ${total.toLocaleString('en-US')})`}
          </button>
        </div>
      )}
    </div>
  )
}

function formatStats(asset: any): string {
  return [formatBytes(asset.fileSizeBytes), asset.triangleCount != null ? `${formatTriangles(asset.triangleCount)} tris` : null].filter(Boolean).join('  |  ')
}

/** The model's render, or a cube where it has none yet. */
function AssetThumb({ asset, className, compact = false }: { asset: any; className: string; compact?: boolean }) {
  if (asset.thumbnailUrl) return <img src={asset.thumbnailUrl} alt="" className={`${className} object-cover`} />
  return (
    <div className={`${className} flex items-center justify-center bg-gray-800/60 text-gray-500`}>
      <CubeIcon size={compact ? 22 : 56} strokeWidth={compact ? 1.5 : 1} />
    </div>
  )
}

function assetMenu(asset: any, onDelete: () => void, open: () => void) {
  return [
    { label: 'Open model', onSelect: open },
    ...(asset.cdnUrl ? [{ label: 'Copy URL', onSelect: () => { navigator.clipboard.writeText(asset.cdnUrl).catch(() => {}) } }] : []),
    // Catalog models are Virvi's, not yours: view and add only
    ...(!asset.packId ? [{ label: 'Delete model', onSelect: onDelete, danger: true, confirm: 'Click again to delete' }] : []),
  ]
}

function AssetCard({ asset, showPublic, onDelete }: { asset: any; showPublic: boolean; onDelete: () => void }) {
  const router = useRouter()
  const license = asset.pack ? licenseLabel(asset.pack.license) : asset.license ? licenseLabel(asset.license) : null
  return (
    <article className="flex flex-col overflow-hidden rounded-lg border border-gray-800 bg-gray-900 transition-colors hover:border-gray-700">
      <Link href={assetHref(asset.id)} tabIndex={-1} aria-hidden="true" className="bg-gradient-to-b from-gray-800/40 to-gray-950/40">
        <AssetThumb asset={asset} className="h-44 w-full" />
      </Link>
      <div className="flex flex-1 flex-col px-4 pt-3 pb-4">
        <div className="flex items-start justify-between gap-2">
          <Link href={assetHref(asset.id)} className="min-w-0 truncate pt-1.5 font-semibold hover:text-blue-300" title={asset.name}>{asset.name}</Link>
          <div className="-mr-2"><RowMenu label={`Actions for ${asset.name}`} items={assetMenu(asset, onDelete, () => router.push(assetHref(asset.id)))} /></div>
        </div>
        {(asset.category || showPublic || !asset.isPublic) && (
          <div className="mt-1 flex flex-wrap gap-1.5">
            {asset.category && <Badge tone="info">{asset.category}</Badge>}
            <VisibilityBadge asset={asset} showPublic={showPublic} />
          </div>
        )}
        <p className="mt-2 whitespace-pre font-mono text-xs text-gray-400">{formatStats(asset)}</p>
        <div className="mt-2 flex items-end justify-between gap-3 text-xs text-gray-500">
          <div className="min-w-0">
            {asset.author && <p className="truncate">by {asset.author}</p>}
            {asset.pack && <p className="truncate" title={creditLine(asset)}>pack {asset.pack.name}</p>}
          </div>
          {license && <span className="shrink-0 first-letter:uppercase">{license}</span>}
        </div>
      </div>
    </article>
  )
}

function AssetRow({ asset, first, showPublic, onDelete }: { asset: any; first: boolean; showPublic: boolean; onDelete: () => void }) {
  const router = useRouter()
  return (
    <div className={`flex items-center gap-4 px-4 py-3 ${first ? '' : 'border-t border-gray-800'}`}>
      <Link href={assetHref(asset.id)} tabIndex={-1} aria-hidden="true" className="shrink-0 overflow-hidden rounded">
        <AssetThumb asset={asset} className="h-12 w-16" compact />
      </Link>
      <div className="min-w-0 flex-1">
        <p className="flex items-center gap-2">
          <Link href={assetHref(asset.id)} className="truncate font-medium hover:text-blue-300">{asset.name}</Link>
          {asset.category && <Badge tone="info">{asset.category}</Badge>}
          <VisibilityBadge asset={asset} showPublic={showPublic} />
        </p>
        <p className="truncate text-sm text-gray-500">{asset.pack ? creditLine(asset) : asset.author ? `by ${asset.author}` : asset.description || ''}</p>
      </div>
      <span className="hidden whitespace-pre font-mono text-xs text-gray-400 md:inline">{formatStats(asset)}</span>
      <RowMenu label={`Actions for ${asset.name}`} items={assetMenu(asset, onDelete, () => router.push(assetHref(asset.id)))} />
    </div>
  )
}
