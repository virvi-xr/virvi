'use client'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { ClientErrorEvent } from '@virvixr/shared'
import { reporter, RELEASE } from '@/lib/errors/reporter'
import { checkScreenshotFile, ReportDraft, type ReportResult } from '@/lib/errors/capture'

/**
 * The Report form (LIV-66 §4), used by crash screens, the report toast and the help menu's Report a bug: one required
 * question, an optional screenshot the user picks (never taken on its own), and a read-only "What we'll send" that is
 * what Submit posts. Nothing leaves the page until Submit, and only then with the session.
 */
export function ReportForm({ lastError, onCancel, onSent }: { lastError: ClientErrorEvent | null; onCancel?: () => void; onSent?: (r: ReportResult) => void }) {
  const draft = useMemo(() => {
    const { route, breadcrumbs } = reporter.context()
    return new ReportDraft({ lastError, route, breadcrumbs, release: RELEASE, send: (body) => reporter.report(body) })
  }, [lastError])
  const [, rerender] = useState(0)
  const refresh = () => rerender((n) => n + 1)
  const [shotUrl, setShotUrl] = useState<string | null>(null)
  const [shotError, setShotError] = useState<string | null>(null)
  const [state, setState] = useState<'idle' | 'sending' | 'sent' | 'failed'>('idle')
  const [failure, setFailure] = useState<string | null>(null)
  const [result, setResult] = useState<ReportResult | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  useEffect(() => () => { if (shotUrl) URL.revokeObjectURL(shotUrl) }, [shotUrl])

  const pick = (file: File | undefined) => {
    setShotError(null)
    if (!file) return
    const early = checkScreenshotFile({ type: file.type, size: file.size })
    if (early) {
      setShotError(early)
      if (fileRef.current) fileRef.current.value = ''
      return
    }
    const reader = new FileReader()
    reader.onload = () => {
      const base64 = String(reader.result).replace(/^data:[^,]*,/, '')
      const why = draft.attach({ type: file.type, size: file.size }, base64)
      if (why) {
        setShotError(why)
        if (fileRef.current) fileRef.current.value = ''
        return
      }
      setShotUrl(URL.createObjectURL(file))
      refresh()
    }
    reader.onerror = () => setShotError("That image couldn't be read. Try another.")
    reader.readAsDataURL(file)
  }
  const removeShot = () => {
    draft.removeScreenshot()
    setShotUrl(null)
    if (fileRef.current) fileRef.current.value = ''
    refresh()
  }

  const submit = async (ev: React.FormEvent) => {
    ev.preventDefault()
    if (!draft.ready) return
    setState('sending')
    setFailure(null)
    try {
      const r = await draft.submit()
      setResult(r)
      setState('sent')
      onSent?.(r)
    } catch (err) {
      const code = (err as { code?: string }).code ?? ''
      setFailure(code.startsWith('screenshot_') ? "We couldn't use that screenshot. Remove it or pick another, then send again." : "That didn't send. Try again in a moment.")
      setState('failed')
    }
  }

  if (state === 'sent') {
    return (
      <div role="status" className="space-y-1 text-sm">
        <p className="font-medium text-emerald-300">Thanks — we've got it.</p>
        <p className="text-gray-400">
          {result?.screenshot === 'not_kept' ? "We couldn't keep your screenshot today, but your report is in." : 'The team reads every report.'}
        </p>
      </div>
    )
  }

  return (
    <form onSubmit={submit} className="space-y-3">
      <label className="block text-sm text-gray-300">
        What were you trying to do?
        <textarea
          required
          autoFocus
          maxLength={1000}
          value={draft.description}
          onChange={(e) => { draft.setDescription(e.target.value); refresh() }}
          rows={3}
          className="mt-1 block w-full rounded-md border border-gray-700 bg-gray-950 p-2 text-sm text-white focus:border-accent focus:outline-none"
        />
      </label>
      {draft.hasError && (
        <label className="flex items-center gap-2 text-xs text-gray-400">
          <input type="checkbox" checked={draft.includeError} onChange={(e) => { draft.includeError = e.target.checked; refresh() }} />
          Include the last error on this page
        </label>
      )}
      <div className="text-sm text-gray-300">
        <p>Screenshot <span className="text-gray-500">(optional; PNG, JPEG or WebP, up to 2 MB)</span></p>
        {shotUrl ? (
          <div className="mt-1 flex items-start gap-3">
            <img src={shotUrl} alt="Your screenshot" className="max-h-32 rounded border border-gray-800" />
            <button type="button" onClick={removeShot} className="text-xs text-gray-400 underline hover:text-white">Remove</button>
          </div>
        ) : (
          <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp" onChange={(e) => pick(e.target.files?.[0])}
            className="mt-1 block text-xs text-gray-400 file:mr-3 file:rounded-md file:border file:border-gray-700 file:bg-gray-900 file:px-3 file:py-1 file:text-gray-200" />
        )}
        {shotError && <p className="mt-1 text-xs text-red-400">{shotError}</p>}
      </div>
      <div>
        <p className="text-xs font-medium uppercase tracking-wider text-gray-500">What we'll send</p>
        <pre aria-label="What we'll send" className="mt-1 max-h-56 overflow-auto whitespace-pre-wrap break-all rounded-md border border-gray-800 bg-gray-950 p-2 font-mono text-[11px] text-gray-400">{draft.preview()}</pre>
        <p className="mt-1 text-xs text-gray-500">Nothing is sent until you press Submit. If you're signed in, it's sent with your account so we can follow up.</p>
      </div>
      {state === 'failed' && failure && <p className="text-sm text-red-400">{failure}</p>}
      <div className="flex gap-2">
        <button type="submit" disabled={!draft.ready || state === 'sending'} className="clip-corner bg-accent px-4 py-2 text-sm font-semibold text-accent-ink hover:bg-accent-hover disabled:opacity-50">
          {state === 'sending' ? 'Sending…' : 'Submit'}
        </button>
        {onCancel && <button type="button" onClick={onCancel} className="rounded-md px-3 py-2 text-sm text-gray-400 hover:text-white">Cancel</button>}
      </div>
    </form>
  )
}
