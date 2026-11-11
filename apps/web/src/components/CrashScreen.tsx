'use client'
import { useEffect, useState } from 'react'
import type { ClientErrorEvent } from '@virvixr/shared'
import { reporter } from '@/lib/errors/reporter'
import { ReportForm } from './ReportForm'

/**
 * What a page that crashed shows (every error.tsx): Try again, and Report, which opens the Report form (one required
 * question, an optional screenshot, and a read-only "What we'll send" that is exactly what Submit posts; LIV-66 §4).
 * The crash itself is recorded at once; nothing about the user is sent unless they press Submit. No auto-prompt.
 */
export function CrashScreen({ error, reset, fullPage = false }: { error: Error & { digest?: string }; reset: () => void; fullPage?: boolean }) {
  const [event, setEvent] = useState<ClientErrorEvent | null>(null)
  const [open, setOpen] = useState(false)
  const [sent, setSent] = useState(false)

  useEffect(() => {
    setEvent(reporter.crash(error))
  }, [error])

  return (
    <div className={`${fullPage ? 'min-h-screen' : 'min-h-[60vh]'} flex items-center justify-center px-4 py-12`}>
      <div className="w-full max-w-lg rounded-lg border border-gray-800 bg-gray-900 p-6">
        <h1 className="text-lg font-semibold text-white">Something went wrong</h1>
        <p className="mt-2 text-sm text-gray-400">This page hit an error. We've recorded it. You can try again, or tell us what you were doing.</p>
        <div className="mt-5 flex flex-wrap gap-2">
          <button type="button" onClick={reset} className="clip-corner bg-accent px-4 py-2 text-sm font-semibold text-accent-ink hover:bg-accent-hover">Try again</button>
          {!open && !sent && (
            <button type="button" onClick={() => setOpen(true)} disabled={!event} className="rounded-md border border-gray-700 px-4 py-2 text-sm text-gray-200 hover:border-gray-500 disabled:opacity-50">Report</button>
          )}
        </div>
        {open && event && (
          <div className="mt-5">
            <ReportForm lastError={event} onCancel={sent ? undefined : () => setOpen(false)} onSent={() => setSent(true)} />
          </div>
        )}
      </div>
    </div>
  )
}
