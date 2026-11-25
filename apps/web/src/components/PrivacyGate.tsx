'use client'
import { useState } from 'react'
import type { PrivacyDecision } from '@virvixr/shared'
import { useApi } from '@/lib/api'
import { privacyPromptOpen, setPrivacyStatus, usePrivacyStatus } from '@/lib/privacy'
import { useDialog } from '@/lib/use-dialog'

/**
 * The dashboard privacy notice (GDPR notice): once per PRIVACY_NOTICE_VERSION, for the accounts the Terms prompt asks,
 * and only after the Terms are agreed (the layout mounts it then), never on top of them. Accept or Decline; the
 * choice can be changed in Settings.
 */
export function PrivacyGate({ userId }: { userId: string }) {
  const api = useApi()
  const status = usePrivacyStatus(userId, () => api.getPrivacyStatus())
  const [busy, setBusy] = useState<PrivacyDecision | null>(null)
  const [error, setError] = useState('')
  const open = privacyPromptOpen(status)
  // No Escape: the notice is answered (it has no default)
  const dialog = useDialog(open, undefined, false)
  if (!open) return null

  const decide = async (decision: PrivacyDecision) => {
    setBusy(decision)
    setError('')
    try {
      setPrivacyStatus(userId, await api.decidePrivacy(decision, 'prompt'))
    } catch (err: any) {
      setError(err?.body?.error === 'stale_version'
        ? 'This notice changed while the page was open. Reload the page to see it.'
        : 'Something went wrong. Try again.')
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/80 p-4">
      <div ref={dialog} role="dialog" aria-modal="true" aria-labelledby="privacy-gate-title" className="w-full max-w-md rounded-xl bg-gray-900 p-6">
        <h2 id="privacy-gate-title" className="text-lg font-semibold text-white">Your privacy at Virvi</h2>
        <p className="mt-2 text-sm text-gray-400">
          Virvi stores your account details and what you build, to run the service (see the{' '}
          <a href="/privacy/" target="_blank" rel="noopener" className="text-blue-400 underline underline-offset-2 hover:text-blue-300">Privacy Policy</a>).
          With your OK, Virvi also records errors in your browser and the pages you visited just before them, to fix bugs faster.
        </p>
        {error && <p className="mt-3 text-sm text-red-400" role="alert">{error}</p>}
        <div className="mt-5 flex items-center justify-end gap-3">
          <button type="button" onClick={() => decide('decline')} disabled={!!busy}
            className="rounded-lg border border-gray-700 px-4 py-2 text-sm font-medium text-gray-200 hover:border-gray-500 disabled:opacity-50">
            {busy === 'decline' ? '...' : 'Decline'}
          </button>
          <button type="button" onClick={() => decide('accept')} disabled={!!busy}
            className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50">
            {busy === 'accept' ? '...' : 'Accept'}
          </button>
        </div>
      </div>
    </div>
  )
}
