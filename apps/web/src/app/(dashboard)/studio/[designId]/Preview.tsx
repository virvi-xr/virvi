'use client'
import { useEffect, useState } from 'react'
import { useApi } from '@/lib/api'
import { Badge, type Tone } from '@/components/ui'
import {
  ORBIT_FRAMES, categoryLabel, inspectNote, orbitKey, pieceTabStatus, refusalMessage, relativeTime, stageState, stepsFor, viewButtonRendering, viewKey,
  type RenderView, type Step, type StudioDetail, type StudioPiece,
} from '@/lib/studio'
import SpinStage from './SpinStage'
import Steps from './Steps'
import InspectStage from './InspectStage'
import EmotesStep, { type EmoteTarget } from './EmotesStep'

const SHAPES = [['male', 'Male'], ['female', 'Female']] as const
const OUTFITS = [['default', 'Default'], ['outfit-2', 'Outfit 2'], ['outfit-3', 'Outfit 3']] as const

function tabBadge(piece: StudioPiece, detail: StudioDetail): { label: string; tone: Tone } | null {
  const status = pieceTabStatus(piece, detail)
  if (status === 'building') return { label: 'Building', tone: 'info' }
  if (piece.revision?.checker?.pass === false) return { label: 'Checker found problems', tone: 'warning' }
  if (status === 'ready') return { label: 'Ready', tone: 'success' }
  return null
}

type Props = {
  designId: string
  detail: StudioDetail
  category: string | null
  onSelect: (category: string) => void
  onChanged: () => Promise<void>
  step: Step
  onStep: (step: Step) => void
  emoteTarget: EmoteTarget | null
  /** What the Finalize step shows: the emote checklist. */
  finalizeStep: React.ReactNode
  children?: React.ReactNode
}

/**
 * The right column: the steps, then the step's stage. On avatar is the piece tabs, the spin and the body and outfit
 * buttons; Inspect turns one piece alone any way; Emotes plays every piece worn. The finalize strip and paid revisions
 * sit under it.
 */
export default function Preview({ designId, detail, category, onSelect, onChanged, step, onStep, emoteTarget, finalizeStep, children }: Props) {
  const api = useApi()
  const kind = detail.design.kind
  const [view, setView] = useState<RenderView>({ bodyShape: 'male', outfit: 'default', emote: null })
  const [pending, setPending] = useState<Set<string>>(new Set())
  const [error, setError] = useState<string | null>(null)
  const [lastPicked, setLastPicked] = useState<keyof RenderView | null>(null)

  const piece = detail.pieces.find((p) => p.category === category) ?? detail.pieces[0]
  const [inspectShape, setInspectShape] = useState<'male' | 'female'>('male')
  const [inspectAsked, setInspectAsked] = useState<string | null>(null)
  const inspect = piece?.renders[orbitKey(inspectShape)]

  // Inspect asks for the rest of the sphere when it isn't there, once per piece revision and body shape
  useEffect(() => {
    if (step !== 'inspect' || !piece?.revision || kind === 'emote') return
    const asked = `${piece.category}/${piece.revision.number}/${inspectShape}`
    if (inspectAsked === asked || inspect?.status === 'queued' || (inspect?.status === 'ready' && (inspect.frames >= ORBIT_FRAMES || inspect.pending))) return
    setInspectAsked(asked)
    api.requestStudioRender(designId, { category: piece.category, bodyShape: inspectShape, mode: 'orbit' }).then(onChanged)
      .catch((err) => setError(refusalMessage(err as never, new Date()).text))
  }, [step, piece?.category, piece?.revision?.number, inspectShape, inspect?.status, inspectAsked]) // eslint-disable-line react-hooks/exhaustive-deps

  const pickStep = (s: Step) => {
    if (s === 'design') {
      const box = document.getElementById('studio-prompt')
      box?.scrollIntoView({ behavior: 'smooth', block: 'center' })
      box?.focus({ preventScroll: true })
    }
    onStep(s)
  }
  const key = viewKey(kind, view)
  const stage = stageState(piece, key, pending)

  // `pending` covers the request in flight; after it the design's own `queued` status says the view is rendering,
  // and the room's job event re-reads the design when it is done
  const pick = async (next: RenderView) => {
    setView(next)
    setError(null)
    if (!piece) return
    const k = viewKey(kind, next)
    if (piece.renders[k]?.status === 'ready' || piece.renders[k]?.status === 'queued' || pending.has(k)) return
    setPending((prev) => new Set(prev).add(k))
    try {
      await api.requestStudioRender(designId, { category: piece.category, ...next })
      await onChanged()
    } catch (err) {
      setError(refusalMessage(err as never, new Date()).text)
    } finally {
      setPending((prev) => new Set([...prev].filter((x) => x !== k)))
    }
  }

  const rendering = (v: RenderView) => !!piece && (pending.has(viewKey(kind, v)) || piece.renders[viewKey(kind, v)]?.status === 'queued')
  const button = <K extends keyof RenderView>(label: string, dim: K, value: RenderView[K]) => (
    <button key={label} type="button" aria-pressed={view[dim] === value} disabled={!piece}
      onClick={() => { setLastPicked(dim); pick({ ...view, [dim]: value }) }}
      className={`rounded px-2.5 py-1 text-sm disabled:opacity-40 ${view[dim] === value ? 'bg-white/[0.08] text-white' : 'text-gray-400 hover:text-white'}`}>
      {label}{viewButtonRendering(dim, value, view, lastPicked, rendering) ? ' · Rendering…' : ''}
    </button>
  )

  const pieceTabs = detail.pieces.length > 0 && (step === 'design' || step === 'avatar' || step === 'inspect')
  return (
    <section aria-label="Preview" className="flex min-w-0 flex-col gap-4">
      <div className="rounded-lg border border-gray-800 bg-gray-900">
        <Steps steps={stepsFor(kind)} current={step} onPick={pickStep} />
        {pieceTabs && (
          <div role="tablist" aria-label="Pieces" className="flex flex-wrap gap-1 border-b border-gray-800 p-2">
            {detail.pieces.map((p) => {
              const b = tabBadge(p, detail)
              const selected = p.category === piece?.category
              return (
                <button key={p.id} role="tab" aria-selected={selected} type="button" onClick={() => onSelect(p.category)}
                  className={`flex items-center gap-2 rounded px-3 py-1.5 text-sm ${selected ? 'bg-white/[0.06] text-white' : 'text-gray-400 hover:text-white'}`}>
                  <span className="capitalize">{kind === 'emote' ? p.name : categoryLabel(p.category)}</span>
                  {b && <Badge tone={b.tone}>{b.label}</Badge>}
                </button>
              )
            })}
          </div>
        )}

        {step === 'emotes' ? (
          <EmotesStep designId={designId} detail={detail} target={emoteTarget} onChanged={onChanged} />
        ) : step === 'finalize' ? (
          finalizeStep
        ) : step === 'inspect' ? (
          <>
            <div className="relative mx-auto aspect-square w-full max-w-[560px] bg-gray-950">
              {!piece ? (
                <p className="absolute inset-0 flex items-center justify-center px-8 text-center text-sm text-gray-400">The agent hasn’t built anything yet. Describe what you want on the left.</p>
              ) : inspect?.status === 'ready' && inspect.urls.length > 0 ? (
                <InspectStage key={`${piece.category}/${inspectShape}`} urls={inspect.urls} label={`${piece.name} on its own, ${inspectShape}`}
                  note={inspectNote(inspect)} onRetry={() => setInspectAsked(null)} />
              ) : inspect?.status === 'failed' ? (
                <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 px-8 text-center text-sm text-gray-400">
                  <p>This view didn’t render.</p>
                  <button type="button" onClick={() => setInspectAsked(null)} className="text-blue-300 underline">Try again</button>
                </div>
              ) : (
                <p className="absolute inset-0 flex items-center justify-center text-sm text-gray-400" aria-live="polite">Rendering this piece from every angle…</p>
              )}
            </div>
            <div className="space-y-2 border-t border-gray-800 p-3">
              <p className="text-xs text-gray-500">Drag sideways to turn it, up or down to look from above or underneath.</p>
              <div className="flex flex-wrap gap-1" role="group" aria-label="Body shape">
                {SHAPES.map(([s, label]) => (
                  <button key={s} type="button" aria-pressed={inspectShape === s} onClick={() => setInspectShape(s)}
                    className={`rounded px-2.5 py-1 text-sm ${inspectShape === s ? 'bg-white/[0.08] text-white' : 'text-gray-400 hover:text-white'}`}>{label}</button>
                ))}
              </div>
              {error && <p className="text-sm text-amber-300" role="alert">{error}</p>}
            </div>
          </>
        ) : (<>
        <div className="relative mx-auto aspect-square w-full max-w-[560px] bg-gray-950">
          {stage.kind === 'frames' ? (
            <SpinStage view={`${piece!.category}/${key}`} urls={stage.urls} loop={kind === 'emote' || !!view.emote}
              label={`${piece!.name}, ${view.bodyShape}${view.emote ? `, ${view.emote}` : ''}`} />
          ) : stage.kind === 'rendering' ? (
            <p className="absolute inset-0 flex items-center justify-center text-sm text-gray-400" aria-live="polite">Rendering this view…</p>
          ) : (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 px-8 text-center text-sm text-gray-400">
              <p>{stage.text}</p>
              {piece && <button type="button" onClick={() => pick({ ...view })} className="text-blue-300 underline">Render this view</button>}
            </div>
          )}
        </div>

        <div className="space-y-2 border-t border-gray-800 p-3">
          {piece?.revision && (
            <p className="text-xs text-gray-500">
              Revision {piece.revision.number}
              {stage.kind === 'frames' && ` · rendered ${relativeTime(stage.renderedAt, new Date())}`}
            </p>
          )}
          <div className="flex flex-wrap items-center gap-1" role="group" aria-label="Avatar">
            {SHAPES.map(([bodyShape, label]) => button(label, 'bodyShape', bodyShape))}
            <span className="mx-1 h-4 w-px bg-gray-800" aria-hidden="true" />
            {OUTFITS.map(([outfit, label]) => button(label, 'outfit', outfit))}
          </div>
          {error && <p className="text-sm text-amber-300" role="alert">{error}</p>}
        </div>
        </>)}
      </div>
      {children}
    </section>
  )
}
