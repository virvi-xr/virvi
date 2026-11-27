'use client'
import { useCallback, useEffect, useState } from 'react'
import { useAuth } from '@/lib/auth'
import { useApi } from '@/lib/api'
import { myEntryStatus, raffleErrorMessage, WITHDRAW_PROMPT, type MyRaffleEntry } from '@/lib/raffles'
import { ConfirmAction, Skeleton } from '@/components/ui'

/**
 * Account settings card (LIV-55): the raffles this account entered in-world, whether it won and the prize, and
 * Withdraw while a raffle still runs. Winners hear how to collect from the host; Virvi doesn't deliver prizes.
 */
export function RaffleEntries() {
  const { token } = useAuth()
  const api = useApi()
  const [entries, setEntries] = useState<MyRaffleEntry[] | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      setEntries((await api.myRaffleEntries()).entries)
    } catch (err) {
      setError(raffleErrorMessage(err))
      setEntries([])
    }
    // useApi() returns new functions every render; reload only when the session changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token])

  useEffect(() => { load() }, [load])

  const withdraw = async (raffleId: string) => {
    setError(null)
    setBusy(raffleId)
    try {
      await api.withdrawRaffleEntry(raffleId)
      await load()
    } catch (err) {
      setError(raffleErrorMessage(err))
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="rounded-lg border border-gray-800 bg-gray-900 p-6">
      <h3 className="text-sm font-medium text-gray-300 mb-1">Raffle entries</h3>
      <p className="text-xs text-gray-500 mb-3">
        Raffles you entered in a scene. If you win, the host contacts you about the prize. Withdrawing deletes your entry.
      </p>
      {error && (
        <div role="alert" className="mb-3 rounded-md bg-red-900/50 border border-red-700 px-4 py-2 text-sm text-red-300">{error}</div>
      )}
      {entries === null ? (
        <Skeleton rows={2} className="h-12" />
      ) : entries.length === 0 ? (
        <p className="text-sm text-gray-500">You haven&apos;t entered any raffles.</p>
      ) : (
        <ul className="space-y-2">
          {entries.map((e) => (
            <li key={e.raffleId} className="flex flex-wrap items-center justify-between gap-3 rounded-md bg-gray-800 px-4 py-2 text-sm">
              <div className="min-w-0">
                <div className="truncate text-gray-200">{e.raffleName}</div>
                <div className="truncate text-xs text-gray-400">
                  {e.sceneName} · {new Date(e.enteredAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                </div>
                <div className={`text-xs ${e.won ? 'font-medium text-green-300' : 'text-gray-400'}`}>
                  {myEntryStatus(e)}{e.won && e.prize ? `: ${e.prize}` : ''}
                </div>
              </div>
              {e.canWithdraw && (
                <ConfirmAction
                  prompt={WITHDRAW_PROMPT(e.raffleName)}
                  confirmLabel="Withdraw"
                  disabled={busy === e.raffleId}
                  onConfirm={() => withdraw(e.raffleId)}
                  className="shrink-0 rounded-md border border-red-700 px-3 py-1 text-xs text-red-300 hover:bg-red-900/50 disabled:opacity-50"
                >
                  {busy === e.raffleId ? 'Withdrawing...' : 'Withdraw'}
                </ConfirmAction>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
