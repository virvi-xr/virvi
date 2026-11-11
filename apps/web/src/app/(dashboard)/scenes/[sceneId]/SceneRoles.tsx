'use client'
import { useEffect, useState } from 'react'
import { useApi } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { ConfirmAction } from '@/components/ui'

type Role = 'cohost' | 'editor' | 'viewer'
const LABEL: Record<Role, string> = { cohost: 'Co-host', editor: 'Editor', viewer: 'Viewer' }
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`

const ERRORS: Record<string, string> = {
  Forbidden: 'Only the host and co-hosts can manage roles.',
  is_host: 'That wallet is the host.',
  not_a_signed_in_cohost: 'They need to sign in to Virvi with that wallet before they can become host.',
  host_has_no_wallet: 'Link your wallet in Settings before transferring host.',
}
const friendly = (err: any): string => ERRORS[err?.message] ?? err?.message ?? 'Something went wrong'

/** Host and co-hosts manage who can run this scene. Roles go to wallet addresses. */
export function SceneRoles({ sceneId }: { sceneId: string }) {
  const { token, user } = useAuth()
  const api = useApi()
  const [data, setData] = useState<Awaited<ReturnType<typeof api.getSceneRoles>> | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [wallet, setWallet] = useState('')
  const [role, setRole] = useState<Role>('editor')
  const [busy, setBusy] = useState(false)

  const load = async () => {
    try {
      setData(await api.getSceneRoles(sceneId))
      setError(null)
    } catch (err: any) {
      setError(friendly(err))
    }
  }
  // useApi() returns new functions every render; reload when the scene or session changes
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { load() }, [sceneId, token])

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true)
    try { await fn(); await load() } catch (err: any) { setError(friendly(err)) } finally { setBusy(false) }
  }
  const isHost = !!data && data.host.userId === user?.id

  return (
    <div className="rounded-lg border border-gray-800 bg-gray-900 p-6">
      <h3 className="text-sm font-medium text-gray-300 mb-1">Roles</h3>
      <p className="text-xs text-gray-500 mb-4">Co-hosts can do everything except change the host. Editors manage content. Viewers see analytics.</p>
      {error && <div className="mb-3 rounded-md bg-red-900/50 border border-red-700 px-4 py-2 text-sm text-red-300">{error}</div>}
      {data && (
        <>
          <ul className="mb-4 space-y-2">
            <li className="flex items-center justify-between rounded-md bg-gray-800 px-4 py-2 text-sm">
              <span className="text-gray-200">{data.host.displayName || (data.host.wallets[0] ? short(data.host.wallets[0]) : 'Host')}</span>
              <span className="text-xs text-orange-400">Host</span>
            </li>
            {data.roles.map((r) => (
              <li key={r.wallet} className="flex items-center justify-between rounded-md bg-gray-800 px-4 py-2 text-sm">
                <span className="font-mono text-gray-200" title={r.wallet}>{r.displayName || short(r.wallet)}</span>
                <span className="flex items-center gap-2">
                  <select aria-label={`Role for ${r.displayName || short(r.wallet)}`} value={r.role} disabled={busy} onChange={(e) => run(() => api.addSceneRole(sceneId, r.wallet, e.target.value as Role))}
                    className="rounded bg-gray-700 px-2 py-1 text-xs text-white">
                    {(Object.keys(LABEL) as Role[]).map((k) => <option key={k} value={k}>{LABEL[k]}</option>)}
                  </select>
                  {isHost && r.role === 'cohost' && r.userId && (
                    <ConfirmAction disabled={busy} danger={false} confirmLabel="Make host"
                      prompt={`Make ${r.displayName || short(r.wallet)} the host? You'll become a co-host.`}
                      onConfirm={() => run(() => api.transferHost(sceneId, r.wallet))}
                      className="text-xs text-orange-400 hover:underline">Make host</ConfirmAction>
                  )}
                  <button disabled={busy} onClick={() => run(() => api.removeSceneRole(sceneId, r.wallet))} className="text-xs text-red-400 hover:underline">Remove</button>
                </span>
              </li>
            ))}
          </ul>
          <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); run(async () => { await api.addSceneRole(sceneId, wallet.trim(), role); setWallet('') }) }}>
            <input aria-label="Wallet address (0x…)" value={wallet} onChange={(e) => setWallet(e.target.value)} placeholder="Wallet address (0x…)" pattern="^0x[0-9a-fA-F]{40}$" required
              className="flex-1 rounded-md bg-gray-950 px-4 py-2 text-sm text-white outline-none focus:border-blue-400 border border-gray-800" />
            <select aria-label="Role" value={role} onChange={(e) => setRole(e.target.value as Role)} className="rounded-md bg-gray-800 px-3 py-2 text-sm text-white">
              {(Object.keys(LABEL) as Role[]).map((k) => <option key={k} value={k}>{LABEL[k]}</option>)}
            </select>
            <button type="submit" disabled={busy} className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium hover:bg-blue-700 disabled:opacity-50">Add</button>
          </form>
        </>
      )}
    </div>
  )
}
