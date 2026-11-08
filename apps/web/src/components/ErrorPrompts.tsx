'use client'
import { useEffect, useState } from 'react'
import type { ClientErrorEvent } from '@virvixr/shared'
import { useAuth } from '@/lib/auth'
import { useApi } from '@/lib/api'
import { reporter, type PromptEvent } from '@/lib/errors/reporter'
import { ReportForm } from './ReportForm'

const ASK_MS = 20_000
const KNOWN_MS = 10_000

/**
 * The toasts after an error broke something the user was doing (LIV-66 §4), and the Report form they and the help
 * menu open. A toast is small, dismissible and never blocks the page; the server and the shared rule decide when one
 * shows (at most one ask a day, never for background errors or expected 4xx, "we know about this" once per error).
 */
export function ErrorPrompts() {
  const { user, scenePass } = useAuth()
  const api = useApi()
  const [toast, setToast] = useState<PromptEvent | null>(null)
  const [form, setForm] = useState<{ lastError: ClientErrorEvent | null } | null>(null)
  const [optedOut, setOptedOut] = useState(false)

  useEffect(() => reporter.onPrompt((p) => { setOptedOut(false); setToast(p) }), [])
  useEffect(() => reporter.onOpenReport((lastError) => { setToast(null); setForm({ lastError }) }), [])
  useEffect(() => {
    if (!toast) return
    const t = setTimeout(() => setToast(null), toast.kind === 'ask' ? ASK_MS : KNOWN_MS)
    return () => clearTimeout(t)
  }, [toast])

  const dontAsk = async () => {
    // An account's choice is kept on the server (and in Settings); a guest's or trial's in this browser
    if (user && !user.trial && !scenePass) await api.setErrorPromptSettings(false).catch(() => reporter.optOutHere())
    else reporter.optOutHere()
    setOptedOut(true)
    setTimeout(() => setToast(null), 3000)
  }

  return (
    <>
      {toast && (
        <div role="status" aria-live="polite" className="fixed bottom-4 right-4 z-50 w-[calc(100%-2rem)] max-w-sm rounded-lg border border-gray-700 bg-gray-900 p-4 text-sm shadow-xl">
          <button type="button" onClick={() => setToast(null)} aria-label="Dismiss" className="absolute right-2 top-2 rounded p-1 text-gray-500 hover:text-white">✕</button>
          {toast.kind === 'known' ? (
            <p className="pr-6 text-gray-200">We know about this and are working on it.</p>
          ) : optedOut ? (
            <p className="pr-6 text-gray-300">Okay, we won't ask about errors again. You can change this in Settings.</p>
          ) : (
            <>
              <p className="pr-6 text-gray-200">That didn't work. Can you tell us what you were trying to do? It helps us fix it.</p>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <button type="button" onClick={() => reporter.openReport(toast.event)} className="clip-corner bg-accent px-3 py-1.5 text-xs font-semibold text-accent-ink hover:bg-accent-hover">Report</button>
                <button type="button" onClick={() => setToast(null)} className="rounded-md px-2 py-1.5 text-xs text-gray-400 hover:text-white">Not now</button>
                <button type="button" onClick={dontAsk} className="ml-auto text-xs text-gray-500 underline hover:text-gray-300">Don't ask me about errors</button>
              </div>
            </>
          )}
        </div>
      )}
      {form && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 p-4 sm:items-center" onClick={(e) => { if (e.target === e.currentTarget) setForm(null) }}>
          <div role="dialog" aria-modal="true" aria-labelledby="report-title" className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-lg border border-gray-800 bg-gray-900 p-5">
            <div className="mb-3 flex items-start justify-between gap-3">
              <h2 id="report-title" className="text-base font-semibold text-white">Report a bug</h2>
              <button type="button" onClick={() => setForm(null)} aria-label="Close" className="rounded p-1 text-gray-500 hover:text-white">✕</button>
            </div>
            <ReportForm lastError={form.lastError} onCancel={() => setForm(null)} />
          </div>
        </div>
      )}
    </>
  )
}
