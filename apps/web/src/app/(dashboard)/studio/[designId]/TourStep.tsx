'use client'
import { useEffect, useState } from 'react'
import { useApi } from '@/lib/api'
import { refusalMessage, type StudioDetail } from '@/lib/studio'
import SpinStage from './SpinStage'

/** `viewOnly` (a viewer, LIV-159): the walk-through when it is rendered, never one asked for. */
type Props = { designId: string; detail: StudioDetail; onChanged: () => Promise<void>; viewOnly?: boolean }

/** Walk-through: the building at eye height, in through the door, round every room and up every stair, its furniture placed. */
export default function TourStep({ designId, detail, onChanged, viewOnly = false }: Props) {
  const api = useApi()
  const shown = detail.set.views.tour
  const [asking, setAsking] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  // The design says whether the walk-through is rendered; its frame urls come from asking for it
  const [frames, setFrames] = useState<{ id: string; urls: string[] } | null>(null)
  const framesId = `${detail.set.revisions}/${shown?.renderedAt}`
  useEffect(() => {
    if (shown?.status !== 'ready' || frames?.id === framesId) return
    ;(viewOnly ? api.getStudioSetFrames(designId) : api.requestStudioSetRender(designId))
      .then((r) => { if ('urls' in r) setFrames({ id: framesId, urls: r.urls }) })
      .catch((err) => setError(refusalMessage(err as never, new Date()).text))
  }, [framesId, shown?.status]) // eslint-disable-line react-hooks/exhaustive-deps
  const urls = frames?.id === framesId ? frames.urls : []

  // It renders after every prompt; asking covers a design opened before that, and a failed one waits for Try again
  useEffect(() => {
    if (viewOnly || shown || asking === detail.set.revisions) return
    setAsking(detail.set.revisions)
    api.requestStudioSetRender(designId).then(onChanged)
      .catch((err) => setError(refusalMessage(err as never, new Date()).text))
  }, [detail.set.revisions, shown]) // eslint-disable-line react-hooks/exhaustive-deps

  const retry = async () => {
    setError(null)
    try { await api.requestStudioSetRender(designId); await onChanged() } catch (err) { setError(refusalMessage(err as never, new Date()).text) }
  }

  return (
    <>
      <div className="relative mx-auto aspect-square w-full max-w-[560px] bg-gray-950">
        {shown?.status === 'ready' && urls.length > 0 ? (
          <SpinStage view="tour" urls={urls} loop fps={shown.fps ?? undefined} label="Walking through the building" />
        ) : shown?.status === 'ready' ? (
          <p className="absolute inset-0 flex items-center justify-center text-sm text-gray-400" aria-live="polite">Loading…</p>
        ) : shown?.status === 'failed' ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 px-8 text-center text-sm text-gray-400">
            <p>The walk-through didn’t render.</p>
            {!viewOnly && <button type="button" onClick={retry} className="text-blue-300 underline">Try again</button>}
          </div>
        ) : viewOnly && shown?.status !== 'queued' ? (
          <p className="absolute inset-0 flex items-center justify-center px-8 text-center text-sm text-gray-400">The walk-through hasn’t been rendered yet.</p>
        ) : (
          <p className="absolute inset-0 flex items-center justify-center px-8 text-center text-sm text-gray-400" aria-live="polite">
            Walking through the building with its furniture in place. It takes about a minute.
          </p>
        )}
      </div>
      <div className="space-y-2 border-t border-gray-800 p-3">
        <p className="text-xs text-gray-500">The way a visitor walks in: through the door, round the rooms and up the stairs. Drag to scrub.</p>
        {error && <p className="text-sm text-amber-300" role="alert">{error}</p>}
      </div>
    </>
  )
}
