'use client'
import { useEffect, useMemo, useState } from 'react'
import type { ClientErrorEvent } from '@virvixr/shared'
import { reporter, RELEASE } from '@/lib/errors/reporter'
import { buildReport, reportPreview } from '@/lib/errors/capture'

/**
 * What a page that crashed shows (every error.tsx): Try again, and Report, which opens a short form with one required
 * question and a read-only "What we'll send" that is exactly what Submit posts (LIV-66 §4). The crash itself is
 * recorded at once; nothing about the user is sent unless they press Submit.
 */
export function CrashScreen({ error, reset, fullPage = false }: { error: Error & { digest?: string }; reset: () => void; fullPage?: boolean }) {
  const [event, setEvent] = useState<ClientErrorEvent | null>(null)
  const [open, setOpen] = useState(false)
  const [description, setDescription] = useState('')
  const [state, setState] = useState<'idle' | 'sending' | 'sent' | 'failed'>('idle')

  useEffect(() => {
    setEvent(reporter.crash(error))
  }, [error])

  const payload = useMemo(() => (event ? buildReport(description, event, RELEASE) : null), [description, event])

  const submit = async (ev: React.FormEvent) => {
    ev.preventDefault()
    if (!payload || !payload.description) return
    setState('sending')
    try {
      await reporter.report(payload)
      setState('sent')
    } catch {
      setState('failed')
    }
  }

  return (
    <div className={`${fullPage ? 'min-h-screen' : 'min-h-[60vh]'} flex items-center justify-center px-4 py-12`}>
      <div className="w-full max-w-lg rounded-lg border border-gray-800 bg-gray-900 p-6">
        <h1 className="text-lg font-semibold text-white">Something went wrong</h1>
        <p className="mt-2 text-sm text-gray-400">This page hit an error. We've recorded it. You can try again, or tell us what you were doing.</p>
        <div className="mt-5 flex flex-wrap gap-2">
          <button type="button" onClick={reset} className="clip-corner bg-accent px-4 py-2 text-sm font-semibold text-accent-ink hover:bg-accent-hover">Try again</button>
          {!open && state !== 'sent' && (
            <button type="button" onClick={() => setOpen(true)} disabled={!event} className="rounded-md border border-gray-700 px-4 py-2 text-sm text-gray-200 hover:border-gray-500 disabled:opacity-50">Report</button>
          )}
        </div>
        {state === 'sent' && <p className="mt-4 text-sm text-emerald-400" role="status">Thanks. Your report was sent.</p>}
        {open && state !== 'sent' && payload && (
          <form onSubmit={submit} className="mt-5 space-y-3">
            <label className="block text-sm text-gray-300">
              What were you trying to do?
              <textarea
                required
                maxLength={1000}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={3}
                className="mt-1 block w-full rounded-md border border-gray-700 bg-gray-950 p-2 text-sm text-white focus:border-accent focus:outline-none"
              />
            </label>
            <div>
              <p className="text-xs font-medium uppercase tracking-wider text-gray-500">What we'll send</p>
              <pre aria-label="What we'll send" className="mt-1 max-h-56 overflow-auto whitespace-pre-wrap break-all rounded-md border border-gray-800 bg-gray-950 p-2 font-mono text-[11px] text-gray-400">{reportPreview(payload)}</pre>
              <p className="mt-1 text-xs text-gray-500">If you're signed in, it's sent with your account so we can follow up.</p>
            </div>
            {state === 'failed' && <p className="text-sm text-red-400">That didn't send. Try again in a moment.</p>}
            <div className="flex gap-2">
              <button type="submit" disabled={!payload.description || state === 'sending'} className="clip-corner bg-accent px-4 py-2 text-sm font-semibold text-accent-ink hover:bg-accent-hover disabled:opacity-50">
                {state === 'sending' ? 'Sending…' : 'Submit'}
              </button>
              <button type="button" onClick={() => setOpen(false)} className="rounded-md px-3 py-2 text-sm text-gray-400 hover:text-white">Cancel</button>
            </div>
          </form>
        )}
      </div>
    </div>
  )
}
