'use client'
import { useEffect, useRef, useState } from 'react'
import { useApi } from '@/lib/api'
import { CubeIcon, PaperclipIcon, XSmallIcon } from '@/components/icons'
import { accountRequired } from '@/lib/trial'
import { formatBytesShort, refusalMessage, uploadHint, uploadProblem, UPLOAD_ACCEPT, type StudioUpload } from '@/lib/studio'

type Props = { designId: string; kind: string; uploads: StudioUpload[]; disabled: boolean; dropped: File[] | null; onChanged: () => Promise<void> }

/**
 * The files the agent can use (a logo for a shirt, a reference photo, a base mesh): attach, see, remove. Every prompt
 * gets all of them; the message says what to do with each.
 */
export default function Uploads({ designId, kind, uploads, disabled, dropped, onChanged }: Props) {
  const api = useApi()
  const input = useRef<HTMLInputElement>(null)
  const [sending, setSending] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)

  const add = async (files: File[]) => {
    setError(null)
    for (const file of files) {
      const problem = uploadProblem(file)
      if (problem) { setError(`${file.name}: ${problem}`); continue }
      setSending((s) => [...s, file.name])
      try {
        await api.uploadStudioFile(designId, file)
      } catch (err) {
        const why = refusalMessage(err as never, new Date()).text
        // A trial that closed the sign-up sheet: say so once and stop, instead of asking again for every file
        if (accountRequired(err)) { setError(why); break }
        setError(`${file.name}: ${why}`)
      } finally {
        setSending((s) => s.filter((n) => n !== file.name))
      }
    }
    await onChanged()
  }

  // Files dropped on the conversation
  useEffect(() => {
    if (dropped?.length && !disabled) add(dropped)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dropped])

  const remove = async (u: StudioUpload) => {
    setError(null)
    try {
      await api.deleteStudioUpload(designId, u.id)
      await onChanged()
    } catch (err) {
      setError(refusalMessage(err as never, new Date()).text)
    }
  }

  return (
    <div className="mb-2">
      {(uploads.length > 0 || sending.length > 0) && (
        <ul className="mb-2 flex flex-wrap gap-2" aria-label="Files for the agent">
          {uploads.map((u) => (
            <li key={u.id} className="flex items-center gap-2 rounded-md border border-gray-800 bg-gray-950 py-1 pl-1 pr-2 text-xs">
              <Thumb designId={designId} upload={u} />
              <span className="max-w-40 truncate font-mono" title={u.name}>{u.name}</span>
              <span className="text-gray-500">{formatBytesShort(u.size)}</span>
              <button type="button" onClick={() => remove(u)} disabled={disabled} aria-label={`Remove ${u.name}`}
                className="text-gray-500 hover:text-white disabled:opacity-40"><XSmallIcon size={14} /></button>
            </li>
          ))}
          {sending.map((n) => (
            <li key={`sending-${n}`} className="flex items-center gap-2 rounded-md border border-dashed border-gray-700 px-2 py-1 text-xs text-gray-400">
              Uploading {n}…
            </li>
          ))}
        </ul>
      )}
      <div className="flex flex-wrap items-center gap-2 text-xs text-gray-500">
        <button type="button" onClick={() => input.current?.click()} disabled={disabled}
          className="flex items-center gap-1.5 rounded-md border border-gray-800 px-2 py-1 text-gray-300 hover:bg-white/[0.04] disabled:opacity-40">
          <PaperclipIcon size={14} /> Attach files
        </button>
        <span>{uploadHint(kind)}</span>
        <input ref={input} type="file" multiple accept={UPLOAD_ACCEPT} className="hidden"
          onChange={(e) => { const files = [...(e.target.files ?? [])]; e.target.value = ''; if (files.length) add(files) }} />
      </div>
      {error && <p className="mt-1 text-xs text-amber-300" role="alert">{error}</p>}
    </div>
  )
}

/** An image's thumbnail, read through the authenticated route; a 3D file shows a cube. */
function Thumb({ designId, upload }: { designId: string; upload: StudioUpload }) {
  const api = useApi()
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    if (upload.kind !== 'image') return
    let objectUrl: string | null = null
    let cancelled = false
    api.getStudioUploadBlob(designId, upload.id)
      .then((b) => { if (!cancelled) { objectUrl = URL.createObjectURL(b); setUrl(objectUrl) } })
      .catch(() => {})
    return () => { cancelled = true; if (objectUrl) URL.revokeObjectURL(objectUrl) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [designId, upload.id, upload.kind])
  if (upload.kind !== 'image') return <span className="flex h-7 w-7 items-center justify-center rounded bg-gray-800 text-gray-400"><CubeIcon size={16} /></span>
  // eslint-disable-next-line @next/next/no-img-element
  return url ? <img src={url} alt="" className="h-7 w-7 rounded object-cover" /> : <span className="h-7 w-7 rounded bg-gray-800" />
}
