'use client'
import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useApi } from '@/lib/api'
import { bannerKey, showVerifyBanner, type EmailStatus } from '@/lib/email-verification'

/** Asks an account with an unconfirmed email to confirm it, until they do or close it (LIV-161). */
export function VerifyEmailBanner({ userId }: { userId: string }) {
  const api = useApi()
  const [status, setStatus] = useState<EmailStatus | null>(null)
  const [dismissed, setDismissed] = useState(true)
  useEffect(() => {
    try { setDismissed(localStorage.getItem(bannerKey(userId)) === '1') } catch { setDismissed(false) }
    api.getEmailStatus().then(setStatus, () => {})
  }, [api, userId])
  if (!showVerifyBanner(status, dismissed)) return null
  const close = () => {
    setDismissed(true)
    try { localStorage.setItem(bannerKey(userId), '1') } catch { /* private window: it just shows again next time */ }
  }
  return (
    <div className="mb-4 flex flex-wrap items-center gap-x-4 gap-y-1 rounded-md border border-amber-500/30 bg-amber-500/10 px-4 py-2 text-sm text-amber-100" role="status">
      <span>Confirm your email: open the link we sent to {status!.email}.</span>
      <span className="ml-auto flex items-center gap-3">
        <Link href="/settings/" className="underline underline-offset-2 hover:text-white">Send a new link</Link>
        <button type="button" onClick={close} aria-label="Close" className="text-amber-200/70 hover:text-white">✕</button>
      </span>
    </div>
  )
}
