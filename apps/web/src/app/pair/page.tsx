'use client'
import { Suspense, useEffect, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { formatPairingCode, normalizePairingCode } from '@virvixr/shared'
import { useAuth } from '@/lib/auth'
import { useApi } from '@/lib/api'
import { signinPath } from '@/lib/landing-route'
import { headsetErrorMessage, headsetPairHref, headsetPairView, pairPageHref, visitorApprovalCopy } from '@/lib/pairing'

type Phase = 'loading' | 'ready' | 'approving' | 'done' | 'error'

/** virvi.io/pair?code=: where someone signs a Quest headset in to their account. A builder headset goes on to the
 *  personal/shared approval; a visitor headset gets its own plain confirmation, because approving signs it in as you. */
function Pair() {
  const { user, loading, scenePass, token } = useAuth()
  const api = useApi()
  const router = useRouter()
  const searchParams = useSearchParams()
  const raw = searchParams.get('code')
  const code = raw ? normalizePairingCode(raw) : null
  const [typed, setTyped] = useState('')
  const [deviceName, setDeviceName] = useState<string | null>(null)
  const [phase, setPhase] = useState<Phase>('loading')
  const [error, setError] = useState('')

  // Signed-in accounts and trials only: others sign in and come back here
  useEffect(() => {
    if (!loading && (!user || scenePass)) router.push(signinPath(window.location.pathname + window.location.search))
  }, [loading, user, scenePass, router])

  useEffect(() => {
    if (loading || !user || scenePass || !code) return
    let cancelled = false
    api.getHeadsetPairingInfo(code)
      .then(i => {
        if (cancelled) return
        // A builder headset keeps today's approval, with its personal/shared choice
        if (headsetPairView(i.purpose) === 'builder') {
          const href = headsetPairHref(code)
          if (href) router.replace(href)
          return
        }
        setDeviceName(i.deviceName)
        setPhase('ready')
      })
      .catch(err => { if (!cancelled) { setError(headsetErrorMessage(err)); setPhase('error') } })
    return () => { cancelled = true }
    // useApi() returns new functions every render; refetch only when the code or session changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code, loading, user, scenePass, token])

  const approve = async () => {
    if (!code) return
    setPhase('approving')
    try {
      // The server ignores the kind for a visitor headset
      await api.approveHeadsetPairing(code, 'personal')
      setPhase('done')
    } catch (err) {
      setError(headsetErrorMessage(err))
      setPhase('error')
    }
  }

  const submitTyped = (e: React.FormEvent) => {
    e.preventDefault()
    const c = normalizePairingCode(typed)
    if (c) router.push(pairPageHref(c))
  }

  if (loading || !user || scenePass) return <div className="flex h-screen items-center justify-center"><p className="text-gray-400">Loading...</p></div>

  const copy = visitorApprovalCopy(deviceName)
  return (
    <main className="mx-auto flex min-h-screen max-w-md items-center px-4">
      <div className="w-full rounded-xl border border-gray-800 bg-gray-900 p-6">
        {!code && (
          <form onSubmit={submitTyped}>
            <h1 className="mb-1 text-lg font-semibold text-gray-100">Sign a headset in</h1>
            <p className="mb-4 text-sm text-gray-400">Enter the code your headset shows.</p>
            <input aria-label="Headset code" value={typed} onChange={e => setTyped(e.target.value)} autoComplete="off" autoCapitalize="characters"
              className="mb-3 w-full rounded-lg bg-gray-800 px-4 py-2 font-mono text-white outline-none focus:ring-2 focus:ring-blue-500" />
            <button type="submit" disabled={!normalizePairingCode(typed)}
              className="rounded-lg bg-orange-500 px-4 py-2 text-sm font-medium text-white hover:bg-orange-600 disabled:opacity-50 transition-colors">Continue</button>
          </form>
        )}
        {code && (
          <>
            <h1 className="mb-1 text-lg font-semibold text-gray-100">{phase === 'ready' || phase === 'approving' || phase === 'done' ? copy.heading : 'Sign a headset in'}</h1>
            <p className="mb-4 font-mono text-sm text-gray-400">{formatPairingCode(code)}</p>
            {phase === 'loading' && <p className="text-sm text-gray-500">Loading...</p>}
            {phase === 'error' && <div className="rounded-lg border border-red-700 bg-red-900/50 px-4 py-2 text-sm text-red-300">{error}</div>}
            {(phase === 'ready' || phase === 'approving') && (
              user.trial ? (
                <p className="text-sm text-red-300">Sign in with an account to sign a headset in to Virvi.</p>
              ) : (
                <>
                  <p className="mb-2 text-sm text-gray-200">{copy.device}</p>
                  <p className="mb-4 rounded-lg border border-yellow-700 bg-yellow-900/40 px-4 py-2 text-sm text-yellow-200">{copy.warning}</p>
                  <button type="button" onClick={approve} disabled={phase === 'approving'}
                    className="rounded-lg bg-orange-500 px-4 py-2 text-sm font-medium text-white hover:bg-orange-600 disabled:opacity-50 transition-colors">
                    {phase === 'approving' ? 'Signing in...' : copy.confirm}
                  </button>
                </>
              )
            )}
            {phase === 'done' && (
              <p className="text-sm text-green-300">Done. You can put the headset back on.</p>
            )}
          </>
        )}
      </div>
    </main>
  )
}

export default function PairPage() {
  return (
    <Suspense fallback={<div className="flex h-screen items-center justify-center"><p className="text-gray-400">Loading...</p></div>}>
      <Pair />
    </Suspense>
  )
}
