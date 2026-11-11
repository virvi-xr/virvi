'use client'
import { useApi, fileToBase64, mediaContentType, uploadErrorMessage, isGlbAsset, MEDIA_UPLOAD_RULES } from '@/lib/api'
import { MEDIA_LIBRARY, MODEL_NOT_MEDIA, splitModelFiles } from '@/lib/libraries'
import Link from 'next/link'
import { useAuth } from '@/lib/auth'
import { useEffect, useState, useRef } from 'react'
import { CheckIcon, CopyIcon, CubeIcon, GridIcon, ListIcon, MediaIcon, PlusIcon, TrashIcon } from '@/components/icons'
import { EmptyState, PageHeader, PrimaryButton, RowMenu, SearchField, SelectField, useStoredView, ViewToggle } from '@/components/ui'
import { countLabel, formatBytes, formatDuration, plural } from '@/lib/format'

type Kind = 'image' | 'model' | 'video' | 'other'
const VIEW_KEY = 'virvi.media.view'

function mediaKind(asset: { contentType: string; filename?: string }): Kind {
  if (asset.contentType.startsWith('image/')) return 'image'
  if (isGlbAsset(asset)) return 'model'
  if (asset.contentType.startsWith('video/')) return 'video'
  return 'other'
}

/** "GLB", "PNG": the file's extension, or its content subtype when it has none. */
function typeBadge(asset: { contentType: string; filename?: string }): string {
  const ext = asset.filename?.includes('.') ? asset.filename.split('.').pop() : asset.contentType.split('/')[1]
  return (ext ?? 'file').toUpperCase()
}

export default function MediaPage() {
  const { token } = useAuth()
  const api = useApi()
  const [assets, setAssets] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [kind, setKind] = useState<Kind | 'all'>('all')
  const [view, chooseView] = useStoredView(VIEW_KEY, ['grid', 'list'], 'grid')
  const fileInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!token) return
    api.getMedia()
      .then(data => { setAssets(data.assets); setLoading(false) })
      .catch(() => setLoading(false))
  }, [token])

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files
    if (!files || files.length === 0) return
    // 3D models go in 3D Models: skip them, upload the rest
    const { media, models } = splitModelFiles(Array.from(files))
    setError(models.length ? `${models.map(f => f.name).join(', ')}: ${MODEL_NOT_MEDIA}` : null)
    if (media.length === 0) {
      if (fileInputRef.current) fileInputRef.current.value = ''
      return
    }
    setUploading(true)
    try {
      for (const file of media) {
        const base64 = await fileToBase64(file)
        const { asset } = await api.uploadMedia(file.name, mediaContentType(file), base64)
        setAssets(prev => [asset, ...prev])
      }
    } catch (err: any) {
      setError('Upload failed: ' + uploadErrorMessage(err))
    } finally {
      setUploading(false)
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }

  const handleDelete = async (assetId: string) => {
    setError(null)
    try {
      await api.deleteMedia(assetId)
      setAssets(prev => prev.filter(a => a.id !== assetId))
    } catch (err: any) {
      setError('Delete failed: ' + (err.message || 'Unknown error'))
    }
  }

  const upload = () => fileInputRef.current?.click()
  const q = query.trim().toLowerCase()
  const shown = assets.filter(a => (kind === 'all' || mediaKind(a) === kind) && (!q || a.filename.toLowerCase().includes(q)))

  return (
    <div className="mx-auto max-w-7xl">
      <input
        ref={fileInputRef}
        type="file"
        multiple
        accept="image/png,image/jpeg,image/webp,image/gif,video/mp4,video/webm"
        className="hidden"
        onChange={handleUpload}
      />
      <PageHeader
        crumbs={['Tools', MEDIA_LIBRARY.name]}
        title={MEDIA_LIBRARY.name}
        count={loading ? undefined : countLabel(assets.length)}
        subtitle={<>{MEDIA_LIBRARY.purpose}. 3D models go in <Link href="/assets" className="text-blue-300 underline">3D Models</Link>.</>}
        actions={
          <div className="flex flex-col items-end gap-2">
            <PrimaryButton onClick={upload} disabled={uploading}><PlusIcon size={16} /> {uploading ? 'Uploading...' : 'Upload File'}</PrimaryButton>
            <p className="max-w-md text-right text-xs text-gray-500">{MEDIA_UPLOAD_RULES}</p>
            <p className="max-w-md text-right text-xs text-gray-500">{MEDIA_LIBRARY.uploadHelp}</p>
          </div>
        }
      />

      {error && <p className="mb-4 text-sm text-red-400" role="alert">{error}{error.includes(MODEL_NOT_MEDIA) && <> <Link href="/assets" className="underline">Open 3D Models</Link></>}</p>}

      {!loading && assets.length > 0 && (
        <div className="mb-6 flex flex-wrap items-center gap-3">
          <SearchField value={query} onChange={setQuery} placeholder="Search files..." label="Search files" />
          <SelectField value={kind} onChange={v => setKind(v as Kind | 'all')} label="File type" className="w-full sm:w-56">
            <option value="all">All types</option>
            <option value="image">Images</option>
            <option value="model">3D models</option>
            <option value="video">Video</option>
            <option value="other">Other</option>
          </SelectField>
          <div className="ml-auto flex items-center gap-3">
            <span className="text-sm text-gray-400">{plural(shown.length, 'file')}</span>
            <ViewToggle value={view} onChange={chooseView} options={[['grid', GridIcon, 'Grid view'], ['list', ListIcon, 'List view']]} />
          </div>
        </div>
      )}

      {loading ? (
        <div className="grid grid-cols-1 gap-6 md:grid-cols-2 xl:grid-cols-3" aria-hidden="true">
          {[0, 1, 2].map(i => <div key={i} className="h-80 animate-pulse rounded-lg border border-gray-800 bg-gray-900" />)}
        </div>
      ) : assets.length === 0 ? (
        <EmptyState icon={<MediaIcon size={40} />} title="No images or video yet"
          body="Images and video you upload here can be placed in any of your scenes. 3D models go in 3D Models."
          action={<PrimaryButton onClick={upload} disabled={uploading}><PlusIcon size={16} /> Upload File</PrimaryButton>} />
      ) : shown.length === 0 ? (
        <p className="py-12 text-center text-gray-500">No files match.</p>
      ) : view === 'grid' ? (
        <div className="grid grid-cols-1 gap-6 md:grid-cols-2 xl:grid-cols-3">
          {shown.map(asset => <MediaCard key={asset.id} asset={asset} onDelete={() => handleDelete(asset.id)} />)}
        </div>
      ) : (
        <div className="rounded-lg border border-gray-800 bg-gray-900">
          {shown.map((asset, i) => <MediaRow key={asset.id} asset={asset} first={i === 0} onDelete={() => handleDelete(asset.id)} />)}
        </div>
      )}
    </div>
  )
}

/** The image itself, or a labelled placeholder for files without one. */
function MediaPreview({ asset, className, compact = false }: { asset: any; className: string; compact?: boolean }) {
  const kind = mediaKind(asset)
  if (kind === 'image' && asset.publicUrl) return <img src={asset.publicUrl} alt="" className={`${className} object-cover`} />
  return (
    <div className={`${className} flex flex-col items-center justify-center bg-gray-800/60 text-gray-500`}>
      {kind === 'model' ? <CubeIcon size={compact ? 22 : 72} strokeWidth={compact ? 1.5 : 1} /> : <MediaIcon size={compact ? 22 : 56} strokeWidth={compact ? 1.5 : 1} />}
      {!compact && (
        <>
          <span className="mt-3 text-3xl font-medium tracking-wide text-gray-400">{typeBadge(asset)}</span>
          <span className="mt-1 text-xs uppercase tracking-wider">{kind === 'model' ? '3D model' : kind}</span>
        </>
      )}
    </div>
  )
}

function useCopyUrl(url?: string) {
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    if (!url) return
    try {
      await navigator.clipboard.writeText(url)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // clipboard blocked
    }
  }
  return [copied, copy] as const
}

/** Delete that asks once more before it runs. */
function useArmed(action: () => void) {
  const [armed, setArmed] = useState(false)
  useEffect(() => {
    if (!armed) return
    const t = setTimeout(() => setArmed(false), 3000)
    return () => clearTimeout(t)
  }, [armed])
  return [armed, () => (armed ? action() : setArmed(true))] as const
}

/** "1.4 MB · video/mp4 · 12:34": a video shows its length once it's known. */
function assetDetails(asset: any): string {
  const length = formatDuration(asset.metadata?.duration)
  return [formatBytes(asset.sizeBytes), asset.contentType, length].filter(Boolean).join(' · ')
}

function MediaCard({ asset, onDelete }: { asset: any; onDelete: () => void }) {
  const [copied, copy] = useCopyUrl(asset.publicUrl)
  const [armed, del] = useArmed(onDelete)
  return (
    <article className="corner-notch relative flex flex-col overflow-hidden rounded-lg border border-gray-800 bg-gray-900 transition-colors hover:border-gray-700">
      <div className="relative">
        <MediaPreview asset={asset} className="h-56 w-full" />
        <span className="absolute left-4 top-4 rounded border border-gray-600 bg-gray-950/70 px-2 py-0.5 font-mono text-xs text-gray-200">{typeBadge(asset)}</span>
      </div>
      <div className="flex-1 px-4 pt-4 pb-3">
        <p className="truncate font-semibold" title={asset.filename}>{asset.filename}</p>
        <p className="mt-1 text-sm text-gray-400">{assetDetails(asset)}</p>
      </div>
      <footer className="flex items-center gap-2 border-t border-gray-800 p-4">
        <button onClick={copy} disabled={!asset.publicUrl}
          className="flex flex-1 items-center justify-center gap-2 rounded-md bg-gray-800/70 px-3 py-2 text-sm text-gray-200 hover:bg-gray-800 disabled:opacity-50">
          {copied ? <CheckIcon size={16} className="text-blue-300" /> : <CopyIcon size={16} />} {copied ? 'Copied' : 'Copy URL'}
        </button>
        <span className="h-8 w-px bg-gray-800" aria-hidden="true" />
        <button onClick={del} className="flex items-center gap-2 rounded-md px-3 py-2 text-sm text-red-400 hover:bg-red-500/10">
          <TrashIcon size={16} /> {armed ? 'Confirm' : 'Delete'}
        </button>
      </footer>
    </article>
  )
}

function MediaRow({ asset, first, onDelete }: { asset: any; first: boolean; onDelete: () => void }) {
  const [copied, copy] = useCopyUrl(asset.publicUrl)
  return (
    <div className={`flex items-center gap-4 px-4 py-3 ${first ? '' : 'border-t border-gray-800'}`}>
      <div className="shrink-0 overflow-hidden rounded"><MediaPreview asset={asset} className="h-12 w-20" compact /></div>
      <div className="min-w-0 flex-1">
        <p className="truncate font-medium" title={asset.filename}>{asset.filename}</p>
        <p className="truncate text-sm text-gray-500">{assetDetails(asset)}</p>
      </div>
      <span className="hidden rounded border border-gray-700 px-2 py-0.5 font-mono text-xs text-gray-300 sm:inline">{typeBadge(asset)}</span>
      <button onClick={copy} disabled={!asset.publicUrl} aria-label={copied ? 'Copied' : 'Copy URL'}
        className="shrink-0 rounded p-2 text-gray-400 hover:bg-white/[0.05] hover:text-blue-300 disabled:opacity-50">
        {copied ? <CheckIcon size={18} className="text-blue-300" /> : <CopyIcon size={18} />}
      </button>
      <RowMenu label={`Actions for ${asset.filename}`} items={[
        { label: 'Copy URL', onSelect: copy },
        { label: 'Delete file', onSelect: onDelete, danger: true, confirm: 'Click again to delete' },
      ]} />
    </div>
  )
}
