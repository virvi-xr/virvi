'use client'
// Deleting a scene (LIV-83): the in-app dialog (what's running, upcoming events, type the name), and the removals list
// it shares with Recently deleted (Sign with your wallet, Retry).
import { useEffect, useState } from 'react'
import { useApi } from '@/lib/api'
import { getBrowserWallet } from '@/lib/auth'
import { wizardErrorMessage } from '@/lib/wizard/run'
import { ConfirmAction } from '@/components/ui'
import {
  checkboxNote, chosenIds, seenEntities, deleteIntro, eventLine, expectedSigner, initialChecks, nameMatches, removalStatusText, signRemoval, unfinished,
  upcomingWarning, type DeletePlan, type DeleteResult, type Removal,
} from '@/lib/scene-delete'

const fieldClass = 'w-full rounded-md border border-gray-800 bg-gray-950 px-3 py-2 text-sm outline-none focus:border-red-400'
const smallButton = 'rounded-md bg-gray-800 px-3 py-1.5 text-xs hover:bg-gray-700 disabled:opacity-50'

/** Each removal with its state; failed ones get Retry, ones waiting for the owner's wallet get Sign. */
export function RemovalList({ sceneId, removals, onChange }: { sceneId: string; removals: Removal[]; onChange: (r: Removal) => void }) {
  const api = useApi()
  const [busy, setBusy] = useState<string | null>(null)
  const [errors, setErrors] = useState<Record<string, string>>({})

  const run = async (r: Removal, fn: () => Promise<Removal>) => {
    setBusy(r.id)
    setErrors((e) => ({ ...e, [r.id]: '' }))
    try {
      onChange(await fn())
    } catch (err) {
      setErrors((e) => ({ ...e, [r.id]: wizardErrorMessage(err) }))
    }
    setBusy(null)
  }

  const sign = (r: Removal) => run(r, async () => {
    const wallet = getBrowserWallet()
    if (!wallet) throw new Error('No browser wallet found. Install MetaMask or another Ethereum wallet, then try again.')
    const first = await api.getRemovalSign(sceneId, r.id)
    const { startSignSession } = await import('@/lib/dcl-sign')
    const session = await startSignSession(wallet, { expectedAddress: expectedSigner(first) ?? undefined })
    return signRemoval(sceneId, r.id, session, api)
  })
  const retry = (r: Removal, confirm = false) => run(r, async () => (await api.retryRemoval(sceneId, r.id, confirm)).removal)

  if (!removals.length) return null
  return (
    <ul className="space-y-2">
      {removals.map((r) => (
        <li key={r.id} className="rounded-md border border-gray-800 bg-gray-950/50 px-3 py-2 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            <span className="flex-1">{r.label}</span>
            {r.status === 'awaiting_signature' && (
              <button type="button" disabled={busy === r.id} onClick={() => sign(r)} className={smallButton}>{busy === r.id ? 'Waiting for your wallet…' : 'Sign with your wallet'}</button>
            )}
            {r.status === 'failed' && (
              <button type="button" disabled={busy === r.id} onClick={() => retry(r)} className={smallButton}>{busy === r.id ? 'Trying…' : 'Retry'}</button>
            )}
            {r.status === 'needs_review' && (
              <>
                <button type="button" disabled={busy === r.id} onClick={() => retry(r)} className={smallButton}>{busy === r.id ? 'Checking…' : 'Check again'}</button>
                <ConfirmAction prompt="Remove what's live there now, even though Virvi didn't build it?" confirmLabel="Remove anyway" disabled={busy === r.id}
                  onConfirm={() => retry(r, true)} className="rounded-md px-3 py-1.5 text-xs text-red-300 hover:bg-red-500/10 disabled:opacity-50">
                  Remove anyway
                </ConfirmAction>
              </>
            )}
          </div>
          <p className={`mt-1 text-xs ${r.status === 'failed' || r.status === 'needs_review' ? 'text-red-300' : r.status === 'done' ? 'text-gray-500' : 'text-amber-200/80'}`}>{removalStatusText(r)}</p>
          {errors[r.id] && <p className="mt-1 text-xs text-red-300" role="alert">{errors[r.id]}</p>}
        </li>
      ))}
    </ul>
  )
}

/**
 * The delete dialog: what's deleted and that it's restorable for 30 days, a checkbox for each hosted world and
 * deployment, upcoming events, and the scene's name to type. Removals that need a signature or failed stay on screen
 * with Sign and Retry; `onDeleted` runs when the person is done.
 */
export function DeleteSceneDialog({ sceneId, onClose, onDeleted }: { sceneId: string; onClose: () => void; onDeleted: (result: DeleteResult) => void }) {
  const api = useApi()
  const [plan, setPlan] = useState<DeletePlan | 'error' | 'forbidden' | null>(null)
  const [checks, setChecks] = useState<Record<string, boolean>>({})
  const [typed, setTyped] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<DeleteResult | null>(null)

  useEffect(() => {
    api.getDeletePlan(sceneId).then((p) => { setPlan(p); setChecks(initialChecks(p.running)) },
      (err) => setPlan((err as { status?: number }).status === 403 ? 'forbidden' : 'error'))
  }, [sceneId])

  useEffect(() => {
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape' && !busy && !result) onClose() }
    document.addEventListener('keydown', esc)
    return () => document.removeEventListener('keydown', esc)
  }, [onClose, busy, result])

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!plan || typeof plan === 'string' || !nameMatches(typed, plan.scene.name)) return
    setBusy(true)
    setError(null)
    try {
      const r = await api.deleteScene(sceneId, chosenIds(checks), seenEntities(plan.running, checks))
      if (unfinished(r.removals).length) setResult(r)
      else onDeleted(r)
    } catch (err) {
      setError(wizardErrorMessage(err))
    }
    setBusy(false)
  }

  const ready = plan && typeof plan !== 'string' ? plan : null
  const warning = ready ? upcomingWarning(ready.upcomingEvents) : null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" onMouseDown={(e) => { if (e.target === e.currentTarget && !busy && !result) onClose() }}>
      <div role="dialog" aria-modal="true" aria-labelledby="delete-scene-title" className="max-h-[90vh] w-full max-w-xl overflow-y-auto rounded-lg border border-gray-800 bg-gray-900 p-5">
        <div className="flex items-start justify-between gap-3">
          <h2 id="delete-scene-title" className="text-lg font-semibold">{result ? `Deleted ${result.scene.name}` : ready ? `Delete ${ready.scene.name}?` : 'Delete scene'}</h2>
          {!result && <button type="button" onClick={onClose} disabled={busy} aria-label="Close" className="px-2 text-lg text-gray-400 hover:text-white">&times;</button>}
        </div>

        {result ? (
          <div className="mt-3 space-y-4">
            <p className="text-sm text-gray-400">The scene is deleted. Some of what you asked to remove still needs you:</p>
            <RemovalList sceneId={sceneId} removals={result.removals.filter((r) => r.status !== 'done')}
              onChange={(r) => setResult((cur) => cur && { ...cur, removals: cur.removals.map((x) => (x.id === r.id ? r : x)) })} />
            <p className="text-xs text-gray-500">You can also do this later from Recently deleted on the Scenes page.</p>
            <div className="flex justify-end">
              <button type="button" onClick={() => onDeleted(result)} className="rounded-md bg-gray-800 px-4 py-2 text-sm hover:bg-gray-700">Done</button>
            </div>
          </div>
        ) : plan === null ? (
          <div className="mt-6 h-32 animate-pulse rounded-lg bg-gray-800/50" aria-hidden="true" />
        ) : plan === 'forbidden' ? (
          <p className="mt-3 text-sm text-gray-400">Only the scene&apos;s host, or an admin of the organization it belongs to, can delete it.</p>
        ) : plan === 'error' ? (
          <p className="mt-3 text-sm text-red-300" role="alert">Couldn&apos;t load what this scene is running. Try again in a moment.</p>
        ) : (
          <form onSubmit={submit} className="mt-3 space-y-4">
            <p className="text-sm text-gray-400">{deleteIntro(plan.purgeAt)}</p>

            {plan.running.length > 0 && (
              <fieldset className="space-y-2">
                <legend className="mb-1 text-sm font-medium">Running now</legend>
                {plan.running.map((item) => (
                  <label key={item.id} className="flex gap-3 rounded-md border border-gray-800 bg-gray-950/50 px-3 py-2 text-sm">
                    <input type="checkbox" className="mt-0.5" checked={!!checks[item.id]} onChange={(e) => setChecks((c) => ({ ...c, [item.id]: e.target.checked }))} />
                    <span>
                      <span className="block">{item.label}</span>
                      <span className="mt-0.5 block text-xs text-gray-400">{checkboxNote(item, !!checks[item.id])}</span>
                    </span>
                  </label>
                ))}
              </fieldset>
            )}

            {warning && (
              <div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-100" role="note">
                <p>{warning}</p>
                <ul className="mt-1 list-disc pl-5 text-xs">
                  {plan.upcomingEvents.map((e) => <li key={`${e.kind}-${e.id}`}>{eventLine(e)}</li>)}
                </ul>
              </div>
            )}

            <label className="block text-sm">
              <span className="mb-1 block text-gray-300">Type <strong className="font-semibold text-white">{plan.scene.name}</strong> to delete it</span>
              <input type="text" value={typed} onChange={(e) => setTyped(e.target.value)} autoFocus autoComplete="off" spellCheck={false} className={fieldClass} />
            </label>

            {error && <p className="text-sm text-red-300" role="alert">{error}</p>}

            <div className="flex justify-end gap-2">
              <button type="button" onClick={onClose} disabled={busy} className="rounded-md bg-gray-800 px-4 py-2 text-sm hover:bg-gray-700">Cancel</button>
              <button type="submit" disabled={busy || !nameMatches(typed, plan.scene.name)}
                className="rounded-md bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-500 disabled:opacity-50">
                {busy ? 'Deleting…' : 'Delete scene'}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  )
}
