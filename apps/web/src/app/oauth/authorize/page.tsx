'use client'
import { useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useAuth } from '@/lib/auth'
import { useApi } from '@/lib/api'
import { API_URL } from '@/lib/config'
import { signinPath } from '@/lib/landing-route'
import { deniedRedirect, parseAuthorize, redirectHost } from '@/lib/oauth'

type Client = { clientId: string; name: string; redirectUris: string[] }

/**
 * An AI app asks to use the person's Virvi account (LIV-170, OAuth with PKCE). Signed out: sign in first and come
 * back. They choose read-only or full access, and optionally scenes; Allow sends a one-time code to the app's own
 * registered address, Deny sends it access_denied.
 */
export default function OAuthAuthorizePage() {
  const { user, loading, scenePass } = useAuth()
  const api = useApi()
  const router = useRouter()
  const [search, setSearch] = useState<string | null>(null)
  const [client, setClient] = useState<Client | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [access, setAccess] = useState<'read' | 'full'>('read')
  const [limit, setLimit] = useState(false)
  const [scenes, setScenes] = useState<Array<{ id: string; name: string }> | null>(null)
  const [chosen, setChosen] = useState<string[]>([])
  const [busy, setBusy] = useState(false)

  // The static export has one page; the request is in the address bar
  useEffect(() => { setSearch(window.location.search) }, [])
  const req = useMemo(() => (search === null ? null : parseAuthorize(search)), [search])

  useEffect(() => {
    if (!loading && !user && search !== null) router.push(signinPath(`/oauth/authorize/${search}`))
  }, [loading, user, search, router])

  useEffect(() => {
    if (!req?.ok) return
    if (req.value.scope) setAccess(req.value.scope)
    fetch(`${API_URL}/api/oauth/clients/${encodeURIComponent(req.value.clientId)}`)
      .then(async (r) => { if (!r.ok) throw new Error('unknown'); return (await r.json()) as Client })
      .then((c) => {
        if (!c.redirectUris.includes(req.value.redirectUri)) setError("This app's sign-in link sends you somewhere it didn't register, so Virvi won't connect it.")
        else setClient(c)
      })
      .catch(() => setError("Virvi doesn't know this app. Start connecting again from the app."))
  }, [req])

  const loadScenes = () => {
    if (scenes) return
    api.getScenes().then((d) => setScenes((d.scenes ?? []).map((s: any) => ({ id: s.id, name: s.name }))), () => setScenes([]))
  }

  const allow = async () => {
    if (!req?.ok || !client) return
    if (limit && chosen.length === 0) return setError('Choose at least one scene, or let the app use all of them.')
    setBusy(true)
    setError(null)
    try {
      const { redirect } = await api.approveOAuth({
        clientId: client.clientId, redirectUri: req.value.redirectUri, codeChallenge: req.value.codeChallenge, codeChallengeMethod: 'S256',
        state: req.value.state, access, ...(limit ? { sceneIds: chosen } : {}),
      })
      window.location.href = redirect
    } catch (err: any) {
      setError(err?.message ?? "Couldn't connect the app. Try again.")
      setBusy(false)
    }
  }

  if (loading || !user || search === null) return <div className="flex h-screen items-center justify-center"><p className="text-gray-400">Loading...</p></div>
  const account = !user.trial && !scenePass

  return (
    <main className="mx-auto flex min-h-screen max-w-lg items-center px-4 py-10">
      <div className="w-full rounded-xl border border-gray-800 bg-gray-900 p-6">
        <h1 className="mb-1 text-lg font-semibold text-gray-100">{client ? `Connect ${client.name} to Virvi` : 'Connect an app to Virvi'}</h1>
        {req && !req.ok && <p role="alert" className="mt-3 text-sm text-red-300">{req.error}</p>}
        {!account && <p role="alert" className="mt-3 text-sm text-red-300">Sign in with a full Virvi account to connect an app.</p>}
        {error && <p role="alert" className="mt-3 text-sm text-red-300">{error}</p>}
        {req?.ok && client && account && (
          <>
            <p className="mb-4 text-sm text-gray-300">
              {client.name} wants to use your Virvi account ({user.displayName || user.email}) through Virvi&apos;s MCP server, and will send you back to <span className="font-mono text-gray-100">{redirectHost(req.value.redirectUri)}</span>. Only connect apps you trust.
            </p>
            <fieldset className="mb-4 space-y-2">
              <legend className="mb-1 text-sm font-medium text-gray-200">What it can do</legend>
              <label className="flex items-start gap-2 text-sm text-gray-300">
                <input type="radio" name="access" checked={access === 'read'} onChange={() => setAccess('read')} className="mt-1" />
                <span><span className="text-gray-100">Read only:</span> see your scenes, events, media and analytics, and change nothing.</span>
              </label>
              <label className="flex items-start gap-2 text-sm text-gray-300">
                <input type="radio" name="access" checked={access === 'full'} onChange={() => setAccess('full')} className="mt-1" />
                <span><span className="text-gray-100">Full access:</span> also change scenes, presets, items, schedules and events, as you can. Paying, publishing, raffles and inviting people stay with you in the dashboard.</span>
              </label>
            </fieldset>
            <label className="mb-2 flex items-center gap-2 text-sm text-gray-300">
              <input type="checkbox" checked={limit} onChange={(e) => { setLimit(e.target.checked); if (e.target.checked) loadScenes() }} />
              Only some scenes (it then can&apos;t see anything else)
            </label>
            {limit && (
              scenes === null ? <p className="mb-3 text-xs text-gray-400">Loading your scenes…</p>
              : scenes.length === 0 ? <p className="mb-3 text-xs text-gray-400">You have no scenes yet.</p>
              : (
                <fieldset className="mb-3 flex flex-wrap gap-x-4 gap-y-1">
                  <legend className="sr-only">Scenes the app can use</legend>
                  {scenes.map((s) => (
                    <label key={s.id} className="flex items-center gap-1.5 text-sm text-gray-300">
                      <input type="checkbox" checked={chosen.includes(s.id)} onChange={(e) => setChosen(e.target.checked ? [...chosen, s.id] : chosen.filter((x) => x !== s.id))} />
                      {s.name}
                    </label>
                  ))}
                </fieldset>
              )
            )}
            <p className="mb-4 text-xs text-gray-400">The connection lasts 90 days. It shows in Settings → API Keys, with what the app did, and deleting it there cuts the app off.</p>
            <div className="flex gap-3">
              <button type="button" disabled={busy} onClick={allow} className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50">Allow</button>
              <button type="button" disabled={busy} onClick={() => { window.location.href = deniedRedirect(req.value) }} className="rounded-md bg-gray-800 px-4 py-2 text-sm hover:bg-gray-700">Deny</button>
            </div>
          </>
        )}
      </div>
    </main>
  )
}
