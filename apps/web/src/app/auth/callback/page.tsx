'use client'
import { useSearchParams } from 'next/navigation'
import { safeNextPath } from '@/lib/next-path'
import { API_URL } from '@/lib/config'
import { takeTrialHandover } from '@/lib/trial'
import { tokenUserId } from '@/lib/session'
import { adoptDraft } from '@/lib/wizard/draft'
import { useEffect, useState, Suspense } from 'react'

function CallbackHandler() {
  const searchParams = useSearchParams()
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const token = searchParams.get('token')
    const refresh = searchParams.get('refresh')

    // Whatever happens, a trial hand-over waiting in this tab is only for this callback
    let handover: ReturnType<typeof takeTrialHandover> = null
    try { handover = takeTrialHandover(sessionStorage, searchParams.get('state'), Date.now()) } catch {}

    if (!token || !refresh) {
      setError('Missing authentication parameters. Please try signing in again.')
      return
    }

    try {
      const payload = JSON.parse(atob(token.split('.')[1]))
      // Never copy `trial` from the payload: a session saved here is an account, so it is never handed over as a trial
      const user = {
        id: payload.sub ?? payload.id,
        displayName: payload.displayName ?? payload.name ?? '',
        email: payload.email ?? null,
        role: payload.role ?? 'user',
      }

      localStorage.setItem(
        'virvi_auth',
        JSON.stringify({ token, refresh, user }),
      )

      let dest = '/scenes'
      try {
        dest = safeNextPath(sessionStorage.getItem('vlm_next')) ?? '/scenes'
        sessionStorage.removeItem('vlm_next')
      } catch {}
      // Started from a trial in this tab: move the trial's designs into the account before going on
      const moved = handover
        ? fetch(`${API_URL}/api/auth/trial/adopt`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
            body: JSON.stringify(handover),
          })
            .then((res) => {
              // The trial moved in: its wizard draft goes with it
              const trialId = tokenUserId(handover.trialToken)
              if (res.ok && trialId && user.id) adoptDraft(trialId, user.id)
              return res
            })
            .catch(() => null)
        : Promise.resolve(null)
      moved.finally(() => { window.location.href = dest })
    } catch {
      setError('Invalid authentication token. Please try signing in again.')
    }
  }, [searchParams])

  if (error) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="w-full max-w-md rounded-xl bg-gray-900 p-8 text-center">
          <p className="mb-4 text-red-400">{error}</p>
          <a href="/signin/" className="text-blue-400 hover:underline">
            Back to login
          </a>
        </div>
      </div>
    )
  }

  return (
    <div className="flex min-h-screen items-center justify-center">
      <p className="text-gray-400">Signing you in...</p>
    </div>
  )
}

export default function AuthCallbackPage() {
  return (
    <Suspense
      fallback={
        <div className="flex min-h-screen items-center justify-center">
          <p className="text-gray-400">Signing you in...</p>
        </div>
      }
    >
      <CallbackHandler />
    </Suspense>
  )
}
