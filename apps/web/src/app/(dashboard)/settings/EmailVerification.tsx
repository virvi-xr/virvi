'use client'
import { useEffect, useState } from 'react'
import { useApi } from '@/lib/api'
import { resendWaitSec, waitLabel, type EmailStatus } from '@/lib/email-verification'

/** The account's email and whether it's confirmed, with "Send a new link" (LIV-161). */
export function EmailVerification() {
  const api = useApi()
  const [status, setStatus] = useState<EmailStatus | null>(null)
  const [sending, setSending] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const [now, setNow] = useState(Date.now())
  useEffect(() => { api.getEmailStatus().then(setStatus, () => {}) }, [api])
  const wait = resendWaitSec(status, now)
  // Tick while the button is waiting, so it comes back on its own
  useEffect(() => {
    if (!wait) return
    const t = setTimeout(() => setNow(Date.now()), 1000)
    return () => clearTimeout(t)
  }, [wait, now])
  if (!status?.email) return null

  const resend = async () => {
    setSending(true)
    setNote(null)
    try {
      setStatus(await api.resendEmailVerification())
      setNow(Date.now())
      setNote(`Sent. Check ${status.email} for the link.`)
    } catch (e) {
      const body = (e as { body?: { message?: string } }).body
      setNote(body?.message ?? "That didn't send. Try again in a moment.")
      api.getEmailStatus().then(setStatus, () => {})
    } finally {
      setSending(false)
    }
  }

  return (
    <div className="rounded-lg border border-gray-800 bg-gray-900 p-6">
      <h3 className="text-sm font-medium text-gray-300 mb-3">Email</h3>
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-white">{status.email}</span>
        {status.verified
          ? <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-xs text-emerald-300">Confirmed</span>
          : <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-xs text-amber-300">Not confirmed</span>}
      </div>
      {!status.verified && (
        <>
          <p className="mt-2 text-sm text-gray-500">
            Open the link we emailed you to confirm this address. Until you do, invites sent to it won&apos;t reach your account
            directly, and people can&apos;t add you to scenes by email.
          </p>
          <button type="button" onClick={resend} disabled={sending || wait > 0}
            className="mt-3 rounded-md border border-gray-700 px-4 py-2 text-sm text-gray-200 hover:bg-white/[0.05] disabled:opacity-50">
            {sending ? 'Sending…' : wait > 0 ? `Send a new link ${waitLabel(wait)}` : 'Send a new link'}
          </button>
        </>
      )}
      {note && <p className="mt-2 text-sm text-gray-400" role="status">{note}</p>}
    </div>
  )
}
