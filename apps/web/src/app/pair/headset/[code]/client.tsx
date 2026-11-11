'use client'
import { useEffect, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import Link from 'next/link'
import { formatPairingCode, type ArDeviceKind } from '@virvixr/shared'
import { useAuth } from '@/lib/auth'
import { useApi } from '@/lib/api'
import { signinPath } from '@/lib/landing-route'
import { headsetErrorMessage, headsetPairingCodeFromPath, headsetSignInPrompt } from '@/lib/pairing'
import { pairChoices } from '@/lib/trial-scene'

type Phase = 'loading' | 'ready' | 'approving' | 'done' | 'error'

const CHOICES: { kind: ArDeviceKind; title: string; detail: string }[] = [
  { kind: 'personal', title: 'This is my headset', detail: 'Stays signed in. Builder opens in one tap.' },
  { kind: 'shared', title: 'Shared headset', detail: "Signs out when it's taken off. Each session needs a new code." },
]

/** Opened from the link or QR a headset shows: a signed-in user approves it as personal or shared; a trial (LIV-91),
 *  whose session counts as signed in here, as personal only. */
export default function HeadsetPairClient() {
  const { user, loading: authLoading, scenePass, token } = useAuth()
  const api = useApi()
  const router = useRouter()
  const params = useParams()
  const [code, setCode] = useState<string | null | undefined>(undefined)
  const [deviceName, setDeviceName] = useState<string | null>(null)
  const [phase, setPhase] = useState<Phase>('loading')
  const [error, setError] = useState('')
  const trial = !!user?.trial
  const choices = CHOICES.filter(c => pairChoices(trial).includes(c.kind))

  useEffect(() => {
    setCode(headsetPairingCodeFromPath(window.location.pathname, params.code as string | undefined))
  }, [params.code])

  // Signed-in accounts and trials only: others go to sign-in and come back here.
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
    api.getHeadsetPairingInfo(code)
      .then(i => { if (!cancelled) { setDeviceName(i.deviceName); setPhase('ready') } })
      .catch(err => { if (!cancelled) { setError(headsetErrorMessage(err)); setPhase('error') } })
    return () => { cancelled = true }
    // useApi() returns new functions every render; refetch only when the code or session changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code, authLoading, user, scenePass, token])

  const approve = async (kind: ArDeviceKind) => {
    if (!code) return
    setPhase('approving')
    try {
      await api.approveHeadsetPairing(code, kind)
      setPhase('done')
    } catch (err) {
      setError(headsetErrorMessage(err))
      setPhase('error')
    }
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-md items-center px-4">
      <div className="w-full rounded-xl border border-gray-800 bg-gray-900 p-6">
        <h1 className="text-lg font-semibold text-gray-100 mb-1">Pair a headset</h1>
        {code && <p className="mb-4 font-mono text-sm text-gray-400">{formatPairingCode(code)}</p>}
        {phase === 'loading' && <p className="text-sm text-gray-500">Loading...</p>}
        {phase === 'error' && (
          <div className="rounded-lg bg-red-900/50 border border-red-700 px-4 py-2 text-sm text-red-300">{error}</div>
        )}
        {(phase === 'ready' || phase === 'approving') && (
          <>
            <p className="mb-4 text-sm text-gray-200">
              {headsetSignInPrompt(deviceName, trial)} What kind of headset is it?
            </p>
            <div className="space-y-3">
              {choices.map(c => (
                <button
                  key={c.kind}
                  type="button"
                  onClick={() => approve(c.kind)}
                  disabled={phase === 'approving'}
                  className="block w-full rounded-lg border border-gray-700 bg-gray-800 px-4 py-4 text-left hover:border-orange-500 disabled:opacity-50 transition-colors"
                >
                  <span className="block text-base font-medium text-gray-100">{c.title}</span>
                  <span className="block text-sm text-gray-400">{c.detail}</span>
                </button>
              ))}
            </div>
            {phase === 'approving' && <p className="mt-3 text-sm text-gray-500">Approving...</p>}
          </>
        )}
        {phase === 'done' && (
          <>
            <p className="mb-3 text-sm text-green-300">Approved. You can put the headset back on.</p>
            {/* Settings is account-only: a trial's headset moves into the account it becomes */}
            {!trial && (
              <p className="text-xs text-gray-500">
                Manage paired headsets in <Link className="underline" href="/settings/">Settings</Link>.
              </p>
            )}
          </>
        )}
      </div>
    </main>
  )
}
