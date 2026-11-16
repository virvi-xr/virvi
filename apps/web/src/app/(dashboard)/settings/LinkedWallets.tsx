'use client'
import { useCallback, useEffect, useState } from 'react'
import { getBrowserWallet, signWalletChallenge, useAuth } from '@/lib/auth'
import { useApi } from '@/lib/api'
import { Badge, Skeleton } from '@/components/ui'
import { WALLET_BLOCKED_LABEL } from '@/lib/reissue'

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`

/** Account settings card: wallets linked to this account, and a button to link the browser wallet. */
export function LinkedWallets() {
  const { token } = useAuth()
  const api = useApi()
  const [wallets, setWallets] = useState<{ address: string; linkedAt: string; blocked?: boolean }[]>([])
  const [loading, setLoading] = useState(true)
  const [linking, setLinking] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [hasWallet, setHasWallet] = useState(false)

  const load = useCallback(async () => {
    try {
      setWallets((await api.getWallets()).wallets)
    } catch (err: any) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
    // useApi() returns new functions every render; reload only when the session changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token])

  useEffect(() => {
    setHasWallet(getBrowserWallet() !== null)
    load()
  }, [load])

  const handleLink = async () => {
    setError(null)
    setLinking(true)
    try {
      await api.linkWallet(await signWalletChallenge())
      await load()
    } catch (err: any) {
      // 4001 = the user closed or rejected the wallet prompt
      setError(err?.code === 4001 ? 'Wallet linking cancelled' : err.message)
    } finally {
      setLinking(false)
    }
  }

  return (
    <div className="rounded-lg border border-gray-800 bg-gray-900 p-6">
      <h3 className="text-sm font-medium text-gray-300 mb-1">Linked Wallets</h3>
      <p className="text-xs text-gray-500 mb-3">
        Link the wallet you use in Decentraland so your in-world HUD, scenes and analytics claims use this account.
      </p>
      {error && (
        <div className="mb-3 rounded-md bg-red-900/50 border border-red-700 px-4 py-2 text-sm text-red-300">{error}</div>
      )}
      {loading ? (
        <Skeleton rows={2} className="h-12" />
      ) : wallets.length === 0 ? (
        <p className="text-sm text-gray-500 mb-3">No wallets linked yet.</p>
      ) : (
        <ul className="mb-3 space-y-2">
          {wallets.map(w => (
            <li key={w.address} className="flex items-center justify-between rounded-md bg-gray-800 px-4 py-2 text-sm">
              <span className="font-mono text-gray-200" title={w.address}>{short(w.address)}</span>
              <span className="flex items-center gap-2 text-xs text-gray-500">
                {w.blocked && <Badge tone="danger">{WALLET_BLOCKED_LABEL}</Badge>}
                linked {new Date(w.linkedAt).toLocaleDateString()}
              </span>
            </li>
          ))}
        </ul>
      )}
      {hasWallet ? (
        <button
          type="button"
          onClick={handleLink}
          disabled={linking}
          className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50 transition-colors"
        >
          {linking ? 'Check your wallet...' : 'Link wallet'}
        </button>
      ) : (
        <p className="text-xs text-gray-500">Install MetaMask or another browser wallet to link one.</p>
      )}
    </div>
  )
}
