'use client'
import { useEffect, useState } from 'react'
import { getBrowserWallet, useAuth } from '@/lib/auth'
import { API_URL } from '@/lib/config'
import { blockedCopy, dismissSignUp, resolveSignUp, subscribeSignUp, type SignUpRequest } from '@/lib/trial'

const input = 'w-full rounded-lg bg-gray-800 px-4 py-2 text-white outline-none focus:ring-2 focus:ring-blue-500'

function titleWithEmphasis(title: string, emphasis?: string) {
  const i = emphasis ? title.indexOf(emphasis) : -1
  if (!emphasis || i < 0) return title
  return <>{title.slice(0, i)}<em>{emphasis}</em>{title.slice(i + emphasis.length)}</>
}

/** One sheet for the whole app (mounted in the root layout). It opens only for a trial session, when an account-only action was refused. */
export function SignUpSheet() {
  const { user, login, register, loginWithWallet, oauthUrl } = useAuth()
  const [req, setReq] = useState<SignUpRequest | null>(null)
  const [tab, setTab] = useState<'create' | 'signin'>('create')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [providers, setProviders] = useState<{ google: boolean; discord: boolean }>({ google: false, discord: false })
  const [hasWallet, setHasWallet] = useState(false)

  useEffect(() => subscribeSignUp(setReq), [])
  useEffect(() => {
    if (!req) return
    setError('')
    setTab(req.tab ?? 'create')
    setHasWallet(getBrowserWallet() !== null)
    fetch(`${API_URL}/api/auth/providers`).then(r => r.json()).then(setProviders).catch(() => {})
  }, [req])
  useEffect(() => {
    if (!req) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') dismissSignUp() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [req])

  // The session stopped being a trial while a sign-up was pending: let the waiting call give up instead of hanging
  const isTrial = !!user?.trial
  useEffect(() => { if (req && !isTrial) dismissSignUp() }, [req, isTrial])

  if (!req || !isTrial) return null
  const copy = blockedCopy(req.action, req.ctx)

  const run = async (go: () => Promise<string>) => {
    setError('')
    setBusy(true)
    try {
      resolveSignUp(await go())
    } catch (err: any) {
      setError(err?.code === 4001 ? 'Wallet sign-in cancelled' : err?.message || 'Something went wrong')
    } finally {
      setBusy(false)
    }
  }

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    run(() => (tab === 'create' ? register(email, password, displayName, req.action) : login(email, password, req.action)))
  }

  // Google and Discord leave the page: come back to this page, which says "You're signed in" (the blocked action is not replayed)
  const oauth = async (provider: 'google' | 'discord') => {
    setError('')
    setBusy(true)
    try {
      const url = await oauthUrl(provider, req.action)
      try {
        sessionStorage.setItem('vlm_next', window.location.pathname + window.location.search)
        sessionStorage.setItem('virvi.signedInFrom', req.action)
      } catch {}
      window.location.href = url
    } catch (err: any) {
      setError(err?.message || 'Something went wrong')
      setBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 p-4 sm:items-center" onClick={dismissSignUp}>
      <div role="dialog" aria-modal="true" aria-label="Create a free account" className="w-full max-w-md rounded-xl bg-gray-900 p-6" onClick={e => e.stopPropagation()}>
        <div className="flex items-start justify-between gap-4">
          <h2 className="text-lg font-semibold">{titleWithEmphasis(copy.title, copy.emphasis)}</h2>
          <button type="button" onClick={dismissSignUp} aria-label="Close" className="text-gray-400 hover:text-white">✕</button>
        </div>
        <p className="mt-1 text-sm text-gray-400">{tab === 'signin' ? 'Your trial designs move into this account.' : copy.unlocks}</p>

        <div className="mt-4 flex gap-2 text-sm" role="tablist">
          {([['create', 'Create account'], ['signin', 'Sign in']] as const).map(([id, label]) => (
            <button key={id} type="button" role="tab" aria-selected={tab === id} onClick={() => { setTab(id); setError('') }}
              className={`rounded-lg px-3 py-1 ${tab === id ? 'bg-gray-700 text-white' : 'text-gray-400 hover:text-white'}`}>{label}</button>
          ))}
        </div>

        <form onSubmit={submit} className="mt-4 space-y-3">
          {tab === 'create' && <input aria-label="Display name" placeholder="Display name" className={input} value={displayName} onChange={e => setDisplayName(e.target.value)} required />}
          <input type="email" aria-label="Email" placeholder="Email" className={input} value={email} onChange={e => setEmail(e.target.value)} required />
          <input type="password" aria-label="Password" placeholder="Password" className={input} value={password} onChange={e => setPassword(e.target.value)} required />
          {error && <p className="text-sm text-red-400">{error}</p>}
          <button type="submit" disabled={busy} className="w-full rounded-lg bg-blue-600 py-2 font-medium hover:bg-blue-700 disabled:opacity-50">
            {busy ? '...' : tab === 'create' ? 'Create account' : 'Sign in'}
          </button>
        </form>

        {(hasWallet || (tab === 'create' && (providers.google || providers.discord))) && (
          <div className="mt-3 space-y-2">
            {hasWallet && (
              <button type="button" disabled={busy} onClick={() => run(() => loginWithWallet(req.action))}
                className="block w-full rounded-lg bg-orange-500 py-2 text-center font-medium text-white hover:bg-orange-600 disabled:opacity-50">
                {tab === 'create' ? 'Continue with wallet' : 'Sign in with wallet'}
              </button>
            )}
            {tab === 'create' && providers.google && (
              <button type="button" disabled={busy} onClick={() => oauth('google')}
                className="block w-full rounded-lg bg-white py-2 text-center font-medium text-gray-900 hover:bg-gray-100 disabled:opacity-50">Continue with Google</button>
            )}
            {tab === 'create' && providers.discord && (
              <button type="button" disabled={busy} onClick={() => oauth('discord')}
                className="block w-full rounded-lg bg-[#5865F2] py-2 text-center font-medium text-white hover:bg-[#4752C4] disabled:opacity-50">Continue with Discord</button>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
