'use client'
import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useAuth } from '@/lib/auth'
import { useApi } from '@/lib/api'
import { signinPath } from '@/lib/landing-route'
import { appHandoffErrorMessage, appSignInRedirect } from '@/lib/app-sign-in'

type Phase = 'confirm' | 'working' | 'sent' | 'error'

/** The Virvi app opens this page in the browser: sign in here (any way), then the page hands a one-time code back to the app. */
export default function AppSignInPage() {
  const { user, loading, scenePass, signOut } = useAuth()
  const api = useApi()
  const router = useRouter()
  const [phase, setPhase] = useState<Phase>('confirm')
  const [error, setError] = useState('')
  const account = !!user && !user.trial && !scenePass

  // Signed out: sign in first and come back here
  useEffect(() => {
    if (!loading && !user) router.push(signinPath('/app-sign-in'))
  }, [loading, user, router])

  const handOff = async () => {
    setPhase('working')
    try {
      const { code } = await api.createAppHandoff()
      setPhase('sent')
      window.location.href = appSignInRedirect(code)
    } catch (err) {
      setError(appHandoffErrorMessage(err))
      setPhase('error')
    }
  }

  if (loading || !user) return <div className="flex h-screen items-center justify-center"><p className="text-gray-400">Loading...</p></div>

  return (
    <main className="mx-auto flex min-h-screen max-w-md items-center px-4">
      <div className="w-full rounded-xl border border-gray-800 bg-gray-900 p-6">
        <h1 className="mb-3 text-lg font-semibold text-gray-100">Sign in to the Virvi app</h1>
        {!account && (
          <>
            <p className="mb-4 text-sm text-red-300">{appHandoffErrorMessage({ status: 401 })}</p>
            <button type="button" onClick={signOut} className="text-sm text-blue-400 underline underline-offset-2 hover:text-blue-300">Sign out</button>
          </>
        )}
        {account && phase === 'confirm' && (
          <>
            <p className="mb-4 text-sm text-gray-200">Signed in as {user.displayName || user.email || 'your account'}.</p>
            <button type="button" onClick={handOff}
              className="mb-3 w-full rounded-lg bg-orange-500 px-4 py-2 text-sm font-medium text-white hover:bg-orange-600 transition-colors">
              Continue to the Virvi app
            </button>
            <p className="text-sm text-gray-400">
              Not you? <button type="button" onClick={signOut} className="text-blue-400 underline underline-offset-2 hover:text-blue-300">Sign out</button>
            </p>
          </>
        )}
        {account && (phase === 'working' || phase === 'sent') && (
          <>
            <p className="mb-3 text-sm text-gray-200">Signing you in to the Virvi app…</p>
            {phase === 'sent' && <p className="text-xs text-gray-500">If the Virvi app didn&apos;t open, go back to it and try again.</p>}
          </>
        )}
        {account && phase === 'error' && (
          <>
            <div className="mb-3 rounded-lg border border-red-700 bg-red-900/50 px-4 py-2 text-sm text-red-300">{error}</div>
            <button type="button" onClick={() => setPhase('confirm')} className="text-sm text-blue-400 underline underline-offset-2 hover:text-blue-300">Try again</button>
          </>
        )}
      </div>
    </main>
  )
}
