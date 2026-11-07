'use client'
import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useAuth } from '@/lib/auth'
import { BrandMark } from '@/components/BrandMark'
import { PrimaryButton } from '@/components/ui'
import { Turnstile, type TurnstileHandle } from '@/components/Turnstile'
import { beginTrial } from '@/lib/trial'

const WIZARD = '/scenes/new/'

/** The public way into the scene builder: "Start building" starts a trial (no account, no sign-in redirect). */
export default function TryScenePage() {
  const { user, loading, startTrial } = useAuth()
  const router = useRouter()
  const [botToken, setBotToken] = useState<string | null>(null)
  const turnstile = useRef<TurnstileHandle>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // A trial or an account already has the builder
  useEffect(() => {
    if (!loading && user && !busy) router.replace(WIZARD)
  }, [loading, user, busy, router])

  const start = async (e: React.FormEvent) => {
    e.preventDefault()
    if (busy || loading) return
    setBusy(true)
    setError(null)
    const began = await beginTrial({
      signedIn: !!user,
      botToken,
      entry: 'scene',
      startTrial,
      // The bot-check token was spent on the refused start: get a fresh one for the retry
      resetBotCheck: () => { setBotToken(null); turnstile.current?.reset() },
    })
    if (began.ok) router.replace(WIZARD)
    else {
      setError(began.error)
      setBusy(false)
    }
  }

  const needsCheck = !loading && !user
  return (
    <div className="min-h-screen bg-gray-950">
      <header className="border-b border-gray-800">
        <div className="mx-auto flex max-w-3xl items-center justify-between px-4 py-4 sm:px-6">
          <BrandMark href="/" />
          <a href="/signin/" className="text-sm text-gray-400 hover:text-white">Sign in</a>
        </div>
      </header>
      <main className="mx-auto max-w-3xl px-4 py-10 sm:px-6 md:py-16">
        <h1 className="text-3xl font-semibold tracking-tight">Build a scene</h1>
        <p className="mt-3 max-w-xl text-gray-400">
          Pick a plot, drop in models, images, videos and sounds, and lay them out in 3D. Start from a room scan if you have a Quest.
          No account needed: create one when you deploy to Decentraland, Hyperfy or Virvi AR.
        </p>
        <form onSubmit={start} className="mt-8 space-y-4 rounded-lg border border-gray-800 bg-gray-900 p-4 sm:p-6">
          {needsCheck && <Turnstile onToken={setBotToken} handle={turnstile} />}
          {error && <p className="text-sm text-amber-300" role="alert">{error}</p>}
          <div className="flex items-center justify-between gap-3">
            <p className="text-xs text-gray-500">Your work is kept for 14 days. Create an account any time to save it.</p>
            <PrimaryButton type="submit" disabled={busy || loading || (needsCheck && botToken === null)}>
              {busy ? 'Starting…' : 'Start building'}
            </PrimaryButton>
          </div>
        </form>
      </main>
    </div>
  )
}
