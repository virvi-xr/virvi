'use client'
import { useEffect, useState } from 'react'
import { useApi } from '@/lib/api'
import { Badge, type Tone } from '@/components/ui'
import {
  checkedEmotes, emoteState, refusalMessage, setViewKey, OWN_EMOTE,
  type EmoteState, type RenderView, type StudioDetail,
} from '@/lib/studio'
import SpinStage from './SpinStage'

const SHAPES = [['male', 'Male'], ['female', 'Female']] as const
const OUTFITS = [['default', 'Default'], ['outfit-2', 'Outfit 2'], ['outfit-3', 'Outfit 3']] as const
export const STATE_BADGE: Record<EmoteState, { label: string; tone: Tone } | null> = {
  unchecked: null,
  fine: { label: 'Looks fine', tone: 'success' },
  clipping: { label: 'Clipping reported', tone: 'warning' },
  fixing: { label: 'Being fixed…', tone: 'info' },
}
export const emoteName = (emote: string) => emote === OWN_EMOTE ? 'Your emote' : emote[0].toUpperCase() + emote.slice(1)

export type EmoteTarget = { emote: string; bodyShape: 'male' | 'female' }

type Props = { designId: string; detail: StudioDetail; target: EmoteTarget | null; onChanged: () => Promise<void> }

/** Emotes: every piece worn together, one emote at a time, and the person says whether it looks fine or clips. */
export default function EmotesStep({ designId, detail, target, onChanged }: Props) {
  const api = useApi()
  const kind = detail.design.kind
  const emotes = checkedEmotes(kind)
  const [emote, setEmote] = useState(target?.emote ?? emotes[0])
  const [bodyShape, setBodyShape] = useState<'male' | 'female'>(target?.bodyShape ?? 'male')
  const [outfit, setOutfit] = useState<RenderView['outfit']>('default')
  const [asking, setAsking] = useState<string | null>(null)
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (target) { setEmote(target.emote); setBodyShape(target.bodyShape) }
  }, [target])

  const view: RenderView = { bodyShape, outfit, emote: kind === 'emote' ? null : emote }
  const key = setViewKey(kind, view)
  const shown = detail.set.views[key]
  // The design says which views are rendered; a rendered view's frame urls come from asking for it
  const [frames, setFrames] = useState<{ id: string; urls: string[] } | null>(null)
  const framesId = `${detail.set.revisions}/${key}/${shown?.renderedAt}`
  useEffect(() => {
    if (shown?.status !== 'ready' || frames?.id === framesId) return
    api.requestStudioSetRender(designId, view)
      .then((r) => { if (r.status === 'ready') setFrames({ id: framesId, urls: r.urls }) })
      .catch((err) => setError(refusalMessage(err as never, new Date()).text))
  }, [framesId, shown?.status]) // eslint-disable-line react-hooks/exhaustive-deps
  const urls = frames?.id === framesId ? frames.urls : []
  const hasPieces = detail.pieces.some((p) => p.revision)

  // An emote renders the first time someone opens it; a failed one waits for the person to ask again
  useEffect(() => {
    if (!hasPieces || shown || asking === `${detail.set.revisions}/${key}`) return
    setAsking(`${detail.set.revisions}/${key}`)
    api.requestStudioSetRender(designId, view).then(onChanged)
      .catch((err) => setError(refusalMessage(err as never, new Date()).text))
  }, [key, detail.set.revisions, hasPieces, shown]) // eslint-disable-line react-hooks/exhaustive-deps

  const retry = async () => {
    setError(null)
    try { await api.requestStudioSetRender(designId, view); await onChanged() } catch (err) { setError(refusalMessage(err as never, new Date()).text) }
  }
  const act = async (fn: () => Promise<unknown>) => {
    setSending(true)
    setError(null)
    try {
      await fn()
      await onChanged()
    } catch (err) {
      const e = err as { status?: number; body?: Record<string, unknown> }
      setError(refusalMessage({ ...e, body: { ...e.body, emote } } as never, new Date()).text)
    } finally {
      setSending(false)
    }
  }

  const state = emoteState(detail, emote, bodyShape)
  const busy = detail.activeJob?.type === 'prompt'
  const ready = shown?.status === 'ready' && urls.length > 0
  const fixes = detail.set.freeFixesLeft[emote] ?? 0
  const toggle = (on: boolean, label: string, onClick: () => void) => (
    <button key={label} type="button" aria-pressed={on} onClick={onClick}
      className={`rounded px-2.5 py-1 text-sm ${on ? 'bg-white/[0.08] text-white' : 'text-gray-400 hover:text-white'}`}>{label}</button>
  )

  return (
    <>
      {kind !== 'emote' && (
        <div className="flex flex-wrap gap-1 border-b border-gray-800 p-2" role="group" aria-label="Emote">
          {emotes.map((e) => {
            const b = STATE_BADGE[emoteState(detail, e, bodyShape)]
            return (
              <button key={e} type="button" aria-pressed={emote === e} onClick={() => { setEmote(e); setError(null) }}
                className={`flex items-center gap-1.5 rounded px-2.5 py-1 text-sm ${emote === e ? 'bg-white/[0.08] text-white' : 'text-gray-400 hover:text-white'}`}>
                {emoteName(e)}
                {b && <Badge tone={b.tone}>{b.label}</Badge>}
              </button>
            )
          })}
        </div>
      )}
      <div className="relative mx-auto aspect-square w-full max-w-[560px] bg-gray-950">
        {!hasPieces ? (
          <p className="absolute inset-0 flex items-center justify-center px-8 text-center text-sm text-gray-400">The agent hasn’t built anything yet. Describe what you want on the left.</p>
        ) : ready ? (
          <SpinStage view={key} urls={urls} loop fps={shown!.fps ?? undefined} label={`${emoteName(emote)}, ${bodyShape}, every piece worn`} />
        ) : shown?.status === 'ready' ? (
          <p className="absolute inset-0 flex items-center justify-center text-sm text-gray-400" aria-live="polite">Loading…</p>
        ) : shown?.status === 'failed' ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 px-8 text-center text-sm text-gray-400">
            <p>That emote didn’t render.</p>
            <button type="button" onClick={retry} className="text-blue-300 underline">Try again</button>
          </div>
        ) : (
          <p className="absolute inset-0 flex items-center justify-center px-8 text-center text-sm text-gray-400" aria-live="polite">Rendering this emote with every piece on. It takes about 40 seconds.</p>
        )}
      </div>
      <div className="space-y-3 border-t border-gray-800 p-3">
        <div className="flex flex-wrap items-center gap-1" role="group" aria-label="Avatar">
          {SHAPES.map(([s, label]) => toggle(bodyShape === s, label, () => { setBodyShape(s); setError(null) }))}
          <span className="mx-1 h-4 w-px bg-gray-800" aria-hidden="true" />
          {OUTFITS.map(([o, label]) => toggle(outfit === o, label, () => { setOutfit(o); setError(null) }))}
        </div>
        {state === 'fixing' ? (
          <p className="text-sm text-blue-200" aria-live="polite">Being fixed… The agent is looking at frames of this emote. It renders again when it’s done.</p>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" disabled={!ready || sending} onClick={() => act(() => api.checkStudioEmote(designId, { emote, bodyShape }))}
              className="rounded-md bg-gray-800 px-3 py-1.5 text-sm hover:bg-gray-700 disabled:opacity-40">Looks fine</button>
            <button type="button" disabled={!ready || sending || busy} onClick={() => act(() => api.reportStudioClipping(designId, { emote, bodyShape, outfit }))}
              className="rounded-md bg-gray-800 px-3 py-1.5 text-sm hover:bg-gray-700 disabled:opacity-40">I see clipping</button>
            <span className="text-xs text-gray-500">{fixes} free fix{fixes === 1 ? '' : 'es'} left for this emote</span>
          </div>
        )}
        {busy && state !== 'fixing' && ready && <p className="text-xs text-gray-500">You can report clipping once the agent has finished.</p>}
        {error && <p className="text-sm text-amber-300" role="alert">{error}</p>}
      </div>
    </>
  )
}
