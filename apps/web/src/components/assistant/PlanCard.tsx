'use client'
import { useEffect, useState } from 'react'
import type { AssistantActionView, AssistantPlanView } from '@virvixr/shared'
import { ActionRow, refusalMessage } from './ActionRow'
import { planButtonLabel } from './copy'

/** `refused`: the approve call was turned away before any step ran (the plan card shows why). */
export type PlanPhase = 'pending' | 'approved' | 'cancelled' | 'refused'

/** The plan the assistant proposes: numbered steps, then "Do these n changes" / Cancel; after approval, the steps' statuses and "Undo all". */
export function PlanCard({ plan, steps, phase, expired: refusedExpired, busy, error, onApprove, onCancel, onUndoStep, onUndoAll }: {
  plan: AssistantPlanView
  /** The steps with their latest status (from `action` events), in plan order */
  steps: AssistantActionView[]
  phase: PlanPhase
  /** For `refused`: the server said the plan expired */
  expired?: boolean
  busy: boolean
  error: string | null
  onApprove: () => void
  onCancel: () => void
  onUndoStep: (id: string) => Promise<void>
  onUndoAll: () => Promise<void>
}) {
  const [now, setNow] = useState(() => Date.now())
  const [undoing, setUndoing] = useState(false)
  const [undoError, setUndoError] = useState<string | null>(null)
  const expiresAt = new Date(plan.expiresAt).getTime()
  useEffect(() => {
    if (phase !== 'pending') return
    const wait = expiresAt - Date.now()
    if (wait <= 0) { setNow(Date.now()); return }
    // setTimeout caps at 2^31-1 ms; a plan lives minutes, so one timer is enough
    const t = setTimeout(() => setNow(Date.now()), Math.min(wait + 50, 2_000_000_000))
    return () => clearTimeout(t)
  }, [phase, expiresAt])

  const expired = (phase === 'pending' && now >= expiresAt) || (phase === 'refused' && !!refusedExpired)
  const canUndoAll = phase === 'approved' && !busy && steps.some((s) => s.status === 'done')

  const undoAll = async () => {
    setUndoing(true)
    setUndoError(null)
    try {
      await onUndoAll()
    } catch (err) {
      setUndoError(refusalMessage(err))
    } finally {
      setUndoing(false)
    }
  }

  return (
    <section aria-label="Plan" className="rounded-lg border border-gray-700 bg-gray-950 p-3">
      <ol className="space-y-1.5">
        {steps.map((s, i) => <ActionRow key={s.id} action={s} number={i + 1} onUndo={phase === 'approved' ? onUndoStep : undefined} />)}
      </ol>
      {expired ? (
        <p className="mt-3 text-sm text-yellow-300" role="status">This plan expired. Ask again to get a fresh one.</p>
      ) : phase === 'cancelled' ? (
        <p className="mt-3 text-sm text-gray-400" role="status">Plan cancelled.</p>
      ) : phase === 'refused' ? (
        <div className="mt-3">
          <button type="button" onClick={onCancel} disabled={busy}
            className="rounded border border-gray-700 px-3 py-1.5 text-sm text-gray-300 hover:text-white disabled:opacity-50">Cancel</button>
        </div>
      ) : phase === 'pending' ? (
        <div className="mt-3 flex flex-wrap gap-2">
          <button type="button" onClick={onApprove} disabled={busy}
            className="clip-corner bg-accent px-3 py-1.5 text-sm font-semibold text-accent-ink hover:bg-accent-hover disabled:opacity-50">{planButtonLabel(steps.length)}</button>
          <button type="button" onClick={onCancel} disabled={busy}
            className="rounded border border-gray-700 px-3 py-1.5 text-sm text-gray-300 hover:text-white disabled:opacity-50">Cancel</button>
        </div>
      ) : canUndoAll ? (
        <div className="mt-3">
          <button type="button" onClick={undoAll} disabled={undoing}
            className="rounded border border-gray-700 px-3 py-1.5 text-sm text-gray-300 hover:text-white disabled:opacity-50">{undoing ? 'Undoing…' : 'Undo all'}</button>
        </div>
      ) : null}
      {error && <p className="mt-2 text-sm text-red-300" role="alert">{error}</p>}
      {undoError && <p className="mt-2 text-sm text-red-300" role="alert">{undoError}</p>}
    </section>
  )
}
