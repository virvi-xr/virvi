'use client'
import { useEffect, useState } from 'react'
import { TERMS_VERSION } from '@virvixr/shared'
import { useApi } from '@/lib/api'
import { termsGate, type TermsStatus } from '@/lib/terms'
import { useDialog } from '@/lib/use-dialog'

/**
 * Covers the dashboard until the account agrees to the Terms of Service in force: on first visit for accounts that
 * signed up without the sign-up form's box (Google, Discord, wallet), and again whenever TERMS_VERSION changes.
 */
export function TermsGate({ onSignOut }: { onSignOut: () => void }) {
  const api = useApi()
  const [status, setStatus] = useState<TermsStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => { api.getTermsStatus().then(setStatus, () => {}) }, [api])
  const gate = termsGate(status)
  // No Escape: the Terms must be answered (agree, or sign out)
  const dialog = useDialog(!!gate, undefined, false)
  if (!gate) return null

  const agree = async () => {
    setBusy(true)
    setError('')
    try {
      setStatus(await api.acceptTerms(TERMS_VERSION))
    } catch (err: any) {
      // stale_terms: this tab is older than the Terms in force; a reload shows the new ones
      setError(err?.body?.error === 'stale_terms'
        ? 'The Terms changed while this page was open. Reload the page to see them.'
        : 'Something went wrong. Try again.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/80 p-4">
      <div ref={dialog} role="dialog" aria-modal="true" aria-labelledby="terms-gate-title" className="w-full max-w-md rounded-xl bg-gray-900 p-6">
        <h2 id="terms-gate-title" className="text-lg font-semibold text-white">{gate.title}</h2>
        <p className="mt-2 text-sm text-gray-400">{gate.body}</p>
        <a href="/terms/" target="_blank" rel="noopener" className="mt-3 inline-block text-sm text-blue-400 hover:underline">
          Read the Terms of Service
        </a>
        {error && <p className="mt-3 text-sm text-red-400" role="alert">{error}</p>}
        <div className="mt-5 flex items-center justify-end gap-3">
          <button type="button" onClick={onSignOut} className="text-sm text-gray-400 hover:text-white">Sign out</button>
          <button type="button" onClick={agree} disabled={busy}
            className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50">
            {busy ? '...' : 'I agree'}
          </button>
        </div>
      </div>
    </div>
  )
}
