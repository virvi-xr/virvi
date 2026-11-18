'use client'
import { useSearchParams } from 'next/navigation'
import { Suspense, useEffect, useRef, useState } from 'react'
import { verifyErrorText } from '@/lib/email-verification'

/** Where the emailed link lands (LIV-161): confirms the address. Works signed in or not; the token is the proof. */
function VerifyEmail() {
  const token = useSearchParams().get('token')
  const [state, setState] = useState<{ kind: 'working' } | { kind: 'ok'; email: string } | { kind: 'error'; text: string }>({ kind: 'working' })
  const ran = useRef(false)
  useEffect(() => {
    if (ran.current) return
    ran.current = true
    if (!token) { setState({ kind: 'error', text: verifyErrorText(undefined) }); return }
    fetch('/api/auth/verify-email', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) })
      .then(async (res) => {
        const data = await res.json().catch(() => ({}))
        setState(res.ok ? { kind: 'ok', email: data.email } : { kind: 'error', text: verifyErrorText(data.error) })
      })
      .catch(() => setState({ kind: 'error', text: 'Network error. Reload the page to try again.' }))
  }, [token])

  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <div className="w-full max-w-md rounded-xl bg-gray-900 p-8 text-center">
        {state.kind === 'working' && <p className="text-gray-300">Confirming your email…</p>}
        {state.kind === 'ok' && (
          <>
            <h1 className="mb-3 text-xl font-semibold text-white">Email confirmed</h1>
            <p className="mb-6 text-gray-400">{state.email} is confirmed for your Virvi account.</p>
            <a href="/scenes/" className="inline-block rounded-lg bg-blue-600 px-6 py-2 text-white hover:bg-blue-700">Go to Virvi</a>
          </>
        )}
        {state.kind === 'error' && (
          <>
            <h1 className="mb-3 text-xl font-semibold text-white">That link didn&apos;t work</h1>
            <p className="mb-6 text-gray-400">{state.text}</p>
            <a href="/settings/" className="inline-block rounded-lg bg-blue-600 px-6 py-2 text-white hover:bg-blue-700">Open Settings</a>
          </>
        )}
      </div>
    </div>
  )
}

export default function VerifyEmailPage() {
  return <Suspense><VerifyEmail /></Suspense>
}
