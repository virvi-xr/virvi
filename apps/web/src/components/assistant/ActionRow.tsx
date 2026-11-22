'use client'
import { useState } from 'react'
import type { AssistantActionView, AssistantActionStatus } from '@virvixr/shared'
import { Badge } from '@/components/ui'

const STATUS: Record<AssistantActionStatus, { label: string; tone: 'neutral' | 'success' | 'warning' | 'danger' | 'info' }> = {
  planned: { label: 'Planned', tone: 'neutral' },
  awaiting_confirmation: { label: 'Waiting', tone: 'warning' },
  running: { label: 'Working', tone: 'info' },
  done: { label: 'Done', tone: 'success' },
  failed: { label: 'Failed', tone: 'danger' },
  undone: { label: 'Undone', tone: 'neutral' },
  cancelled: { label: 'Cancelled', tone: 'neutral' },
}

/** What a refused call says: the server's own message when it sent one. */
export function refusalMessage(err: unknown): string {
  const e = err as { body?: { message?: string }; message?: string }
  return e?.body?.message || e?.message || 'Something went wrong.'
}

/**
 * One change the assistant made (or tried): label, organisation, a card's detail (the design, cost and what is sent),
 * an optional `note` line (the date in Settings), status, and Undo while it can be undone.
 */
export function ActionRow({ action, number, note, onUndo }: { action: AssistantActionView; number?: number; note?: string | null; onUndo?: (id: string) => Promise<void> }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const s = STATUS[action.status] ?? STATUS.planned
  const undo = async () => {
    if (!onUndo) return
    setBusy(true)
    setError(null)
    try {
      await onUndo(action.id)
    } catch (err) {
      setError(refusalMessage(err))
    } finally {
      setBusy(false)
    }
  }
  return (
    <li className="rounded-md border border-gray-800 bg-gray-900/60 px-3 py-2">
      <div className="flex items-start gap-2">
        {number !== undefined && <span className="mt-0.5 w-5 shrink-0 text-xs text-gray-500">{number}.</span>}
        <div className="min-w-0 flex-1">
          <p className="break-words text-sm text-gray-100">{action.label}</p>
          {action.orgName && <p className="text-xs text-gray-500">{action.orgName}</p>}
          {action.detail && <p className="mt-0.5 whitespace-pre-line break-words text-xs text-gray-400">{action.detail}</p>}
          {note && <p className="mt-0.5 text-xs text-gray-400">{note}</p>}
          {action.status === 'failed' && action.error && <p className="mt-1 text-xs text-red-300">{action.error}</p>}
        </div>
        <Badge tone={s.tone}>{s.label}</Badge>
        {action.canUndo && onUndo && (
          <button type="button" onClick={undo} disabled={busy}
            className="shrink-0 rounded border border-gray-700 px-2 py-0.5 text-xs text-gray-300 hover:text-white disabled:opacity-50">
            {busy ? 'Undoing…' : 'Undo'}
          </button>
        )}
      </div>
      {error && <p className="mt-1.5 text-xs text-red-300" role="alert">{error}</p>}
    </li>
  )
}
