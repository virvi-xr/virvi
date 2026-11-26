'use client'
import { useEffect, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import Link from 'next/link'
import { formatPairingCode } from '@virvixr/shared'
import { useAuth } from '@/lib/auth'
import { useApi } from '@/lib/api'
import { signinPath } from '@/lib/landing-route'
import { approvalPrompt, pairingCodeFromPath, pairingErrorMessage } from '@/lib/pairing'

type Info = { pairingId: string; worldName: string; sceneId: string; sceneName: string; playerName: string | null }
type Phase = 'loading' | 'ready' | 'approving' | 'done' | 'error'

/** Opened from the link or QR in a Hyperfy world: shows who is asking and lets a signed-in user approve. */
export default function PairClient() {
  const { user, loading: authLoading, scenePass, token } = useAuth()
  const api = useApi()
  const router = useRouter()
  const params = useParams()
  const [code, setCode] = useState<string | null | undefined>(undefined)
  const [info, setInfo] = useState<Info | null>(null)
  const [phase, setPhase] = useState<Phase>('loading')
  const [error, setError] = useState('')

  useEffect(() => {
    setCode(pairingCodeFromPath(window.location.pathname, params.code as string | undefined))
  }, [params.code])

  // Signed-in only: others go to sign-in and come back here.
  useEffect(() => {
    if (!authLoading && (!user || scenePass)) router.push(signinPath(window.location.pathname + window.location.search))
  }, [authLoading, user, scenePass, router])

  useEffect(() => {
    if (code === undefined || authLoading || !user || scenePass) return
    if (code === null) {
      setError("That code doesn't exist.")
      setPhase('error')
      return
    }
    let cancelled = false
    api.getHyperfyPairingInfo(code)
      .then(i => { if (!cancelled) { setInfo(i); setPhase('ready') } })
      .catch(err => { if (!cancelled) { setError(pairingErrorMessage(err)); setPhase('error') } })
    return () => { cancelled = true }
    // useApi() returns new functions every render; refetch only when the code or session changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code, authLoading, user, scenePass, token])

  const approve = async () => {
    if (!code) return
    setPhase('approving')
    try {
      await api.approveHyperfyPairing(code)
      setPhase('done')
    } catch (err) {
      setError(pairingErrorMessage(err))
      setPhase('error')
    }
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-md items-center px-4">
      <div className="w-full rounded-xl border border-gray-800 bg-gray-900 p-6">
        <h1 className="text-lg font-semibold text-gray-100 mb-1">Link a Hyperfy world</h1>
        {code && <p className="mb-4 font-mono text-sm text-gray-400">{formatPairingCode(code)}</p>}
        {phase === 'loading' && <p className="text-sm text-gray-500">Loading...</p>}
        {phase === 'error' && (
          <div className="rounded-lg bg-red-900/50 border border-red-700 px-4 py-2 text-sm text-red-300">{error}</div>
        )}
        {(phase === 'ready' || phase === 'approving') && info && (
          <>
            <p className="mb-4 text-sm text-gray-200">{approvalPrompt(info)}</p>
            <button
              type="button"
              onClick={approve}
              disabled={phase === 'approving'}
              className="rounded-lg bg-orange-700 px-4 py-2 text-sm font-medium text-white hover:bg-orange-800 disabled:opacity-50 transition-colors"
            >
              {phase === 'approving' ? 'Approving...' : 'Approve'}
            </button>
          </>
        )}
        {phase === 'done' && (
          <>
            <p className="mb-3 text-sm text-green-300">Approved. You can go back to the world.</p>
            <p className="text-xs text-gray-500">
              Manage linked sessions in <Link className="underline" href="/settings/">Settings</Link>.
            </p>
          </>
        )}
      </div>
    </main>
  )
}
