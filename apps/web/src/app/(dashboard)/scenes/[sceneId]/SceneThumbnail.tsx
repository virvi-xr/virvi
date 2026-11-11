'use client'
// The scene's thumbnail (LIV-88): pick an image, crop it to Decentraland's 16:9, upload; replace or remove it.

import { useEffect, useRef, useState } from 'react'
import { fileToBase64, type useApi } from '@/lib/api'
import {
  CENTRED, SCENE_THUMBNAIL_MAX_BYTES, SCENE_THUMBNAIL_MIN, TOO_LARGE_MESSAGE, TOO_SMALL_MESSAGE,
  cropRect, deployNote, maxZoom, outputSize, outputType, paintCrop, pickedFileError, removeConfirm, sourceTooSmall, thumbnailError, type CropPosition,
} from '@/lib/scene-thumbnail'

const PREVIEW = { width: 480, height: 270 }

interface Picked {
  img: HTMLImageElement
  type: string
  objectUrl: string
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('unreadable'))
    img.src = url
  })
}

function toBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality))
}

/** A canvas of the crop at its saved size, painted for `type`. */
function cropCanvas(p: Picked, pos: CropPosition, type: 'image/jpeg' | 'image/png'): HTMLCanvasElement {
  const r = cropRect(p.img.naturalWidth, p.img.naturalHeight, pos)
  const size = outputSize(r)
  const canvas = document.createElement('canvas')
  canvas.width = size.width
  canvas.height = size.height
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('no_canvas')
  paintCrop(ctx, p.img, r, size, type)
  return canvas
}

/** The crop as PNG or JPEG; a PNG over 2 MB is painted again as JPEG (over a solid background). */
async function renderCrop(p: Picked, pos: CropPosition): Promise<Blob> {
  const type = outputType(p.type)
  let blob = await toBlob(cropCanvas(p, pos, type), type, type === 'image/jpeg' ? 0.9 : undefined)
  if (blob && blob.size > SCENE_THUMBNAIL_MAX_BYTES && type === 'image/png') blob = await toBlob(cropCanvas(p, pos, 'image/jpeg'), 'image/jpeg', 0.9)
  if (!blob) throw new Error('no_canvas')
  if (blob.size > SCENE_THUMBNAIL_MAX_BYTES) throw Object.assign(new Error('too_large'), { status: 413 })
  return blob
}

export function SceneThumbnail({ sceneId, url, source = null, openPicker = false, api, onChange }: {
  sceneId: string
  url: string | null
  /** LIV-89: 'import' when it is the imported scene's own (from its scene.json), which Virvi doesn't deploy. */
  source?: 'upload' | 'import' | null
  /** Opens the file picker as it appears (the import page's Replace). */
  openPicker?: boolean
  api: ReturnType<typeof useApi>
  onChange: (url: string | null, source: 'upload' | null) => void
}) {
  const [picked, setPicked] = useState<Picked | null>(null)
  const [pos, setPos] = useState<CropPosition>(CENTRED)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const fileRef = useRef<HTMLInputElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)

  // The click that showed this panel lets it open the picker
  useEffect(() => { if (openPicker) fileRef.current?.click() }, [openPicker])

  // Free the picked file's object URL when it's replaced or the panel closes
  useEffect(() => () => { if (picked) URL.revokeObjectURL(picked.objectUrl) }, [picked])

  // Redraw the preview as the crop moves
  useEffect(() => {
    const canvas = canvasRef.current
    if (!picked || !canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const r = cropRect(picked.img.naturalWidth, picked.img.naturalHeight, pos)
    ctx.clearRect(0, 0, PREVIEW.width, PREVIEW.height)
    ctx.drawImage(picked.img, r.sx, r.sy, r.sw, r.sh, 0, 0, PREVIEW.width, PREVIEW.height)
  }, [picked, pos])

  const choose = async (file: File | undefined) => {
    if (fileRef.current) fileRef.current.value = ''
    if (!file) return
    setError('')
    const why = pickedFileError(file)
    if (why) return setError(why)
    const objectUrl = URL.createObjectURL(file)
    try {
      const img = await loadImage(objectUrl)
      if (sourceTooSmall(img.naturalWidth, img.naturalHeight)) {
        URL.revokeObjectURL(objectUrl)
        return setError(TOO_SMALL_MESSAGE)
      }
      setPos(CENTRED)
      setPicked({ img, type: file.type, objectUrl })
    } catch {
      URL.revokeObjectURL(objectUrl)
      setError("That image couldn't be read. Try another PNG, JPEG or WebP file.")
    }
  }

  const save = async () => {
    if (!picked) return
    setBusy(true)
    setError('')
    try {
      const blob = await renderCrop(picked, pos)
      const { scene } = await api.setSceneThumbnail(sceneId, await fileToBase64(new File([blob], 'thumbnail', { type: blob.type })))
      onChange(scene.thumbnailUrl ?? null, 'upload')
      setPicked(null)
    } catch (err) {
      setError((err as Error)?.message === 'too_large' ? TOO_LARGE_MESSAGE : thumbnailError(err))
    } finally {
      setBusy(false)
    }
  }

  const remove = async () => {
    if (!window.confirm(removeConfirm(url ? source : null))) return
    setBusy(true)
    setError('')
    try {
      await api.removeSceneThumbnail(sceneId)
      onChange(null, null)
    } catch (err) {
      setError(thumbnailError(err))
    } finally {
      setBusy(false)
    }
  }

  const w = picked?.img.naturalWidth ?? 0
  const h = picked?.img.naturalHeight ?? 0
  const top = picked ? maxZoom(w, h) : 1
  const crop = picked ? cropRect(w, h, pos) : null
  const slackX = !!crop && w - crop.sw > 0.5
  const slackY = !!crop && h - crop.sh > 0.5
  const slider = 'w-full accent-blue-500'

  return (
    <section className="rounded-lg border border-gray-800 bg-gray-900 p-5 space-y-4" aria-labelledby="scene-thumbnail-title">
      <div>
        <h2 id="scene-thumbnail-title" className="text-base font-semibold">Thumbnail</h2>
        <p className="mt-1 text-sm text-gray-400">
          Shown on your Scenes list and, once deployed, wherever Decentraland shows your scene (the map and Places).
          A 16:9 PNG, JPEG or WebP of at least {SCENE_THUMBNAIL_MIN.width} × {SCENE_THUMBNAIL_MIN.height} px; you crop it to shape below.
          {deployNote(url ? source : null)}
        </p>
        {source === 'import' && url && (
          <p className="mt-1 text-sm text-gray-400">
            This one is your imported scene&apos;s own, from its scene.json, and deploys with the scene as it is.
          </p>
        )}
      </div>

      <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp" className="hidden"
        aria-label="Choose a thumbnail image" onChange={(e) => choose(e.target.files?.[0])} />

      {picked ? (
        <div className="space-y-3">
          <canvas ref={canvasRef} width={PREVIEW.width} height={PREVIEW.height}
            className="aspect-video w-full max-w-[480px] rounded border border-gray-700 bg-gray-950" aria-label="Cropped thumbnail preview" />
          <div className="grid max-w-[480px] gap-2 text-xs text-gray-400">
            <label className="grid gap-1">Zoom
              <input type="range" className={slider} min={1} max={top} step={0.01} value={pos.zoom} disabled={top <= 1}
                onChange={(e) => setPos((p) => ({ ...p, zoom: Number(e.target.value) }))} />
            </label>
            <label className="grid gap-1">Left to right
              <input type="range" className={slider} min={0} max={1} step={0.01} value={pos.x} disabled={!slackX}
                onChange={(e) => setPos((p) => ({ ...p, x: Number(e.target.value) }))} />
            </label>
            <label className="grid gap-1">Top to bottom
              <input type="range" className={slider} min={0} max={1} step={0.01} value={pos.y} disabled={!slackY}
                onChange={(e) => setPos((p) => ({ ...p, y: Number(e.target.value) }))} />
            </label>
          </div>
          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={save} disabled={busy}
              className="rounded bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-50">
              {busy ? 'Saving…' : 'Save thumbnail'}
            </button>
            <button type="button" onClick={() => setPos(CENTRED)} disabled={busy}
              className="rounded border border-gray-700 px-3 py-1.5 text-sm text-gray-300 hover:bg-gray-800">Centre</button>
            <button type="button" onClick={() => setPicked(null)} disabled={busy}
              className="rounded px-3 py-1.5 text-sm text-gray-400 hover:text-gray-200">Cancel</button>
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          {url ? (
            <img src={url} alt="Scene thumbnail" className="aspect-video w-full max-w-[480px] rounded border border-gray-700 object-cover" />
          ) : (
            <div className="flex aspect-video w-full max-w-[480px] items-center justify-center rounded border border-dashed border-gray-700 text-sm text-gray-500">
              No thumbnail yet
            </div>
          )}
          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={() => fileRef.current?.click()} disabled={busy}
              className="rounded bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-50">
              {url ? 'Replace' : 'Upload thumbnail'}
            </button>
            {url && (
              <button type="button" onClick={remove} disabled={busy}
                className="rounded border border-red-900 px-3 py-1.5 text-sm text-red-300 hover:bg-red-950 disabled:opacity-50">
                {busy ? 'Removing…' : 'Remove'}
              </button>
            )}
          </div>
        </div>
      )}

      {error && <p role="alert" className="text-sm text-red-400">{error}</p>}
    </section>
  )
}
