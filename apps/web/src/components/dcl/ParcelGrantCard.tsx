'use client'
// Genesis City parcels: the optional on-chain operator grant that lets Virvi deploy for the owner, and its removal.
// The owner sends the transactions from their own wallet; Virvi only reads the result back from Decentraland.
import { useEffect, useState } from 'react'
import { useApi } from '@/lib/api'
import { getBrowserWallet } from '@/lib/auth'
import { importFailure } from '@/lib/import'
import { grantView, OPERATOR_REPLACES_NOTE, sendTransactions, type GrantTransaction, type ParcelGrant } from '@/lib/parcel-grant'
import { wizardErrorMessage } from '@/lib/wizard/run'

const button = 'rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50'
const secondary = 'rounded-md bg-gray-800 px-3 py-1.5 text-sm text-gray-200 hover:bg-gray-700 disabled:opacity-50'
const infoBox = 'rounded-md border border-blue-900/60 bg-blue-950/40 px-3 py-2 text-blue-200'
const errorBox = 'rounded-md border border-red-900/60 bg-red-950/40 px-3 py-2 text-red-300'

type Step = null | 'granting' | 'revoking'

export function ParcelGrantCard({ destinationId, onChanged }: { destinationId: string; onChanged?: () => void }) {
  const api = useApi()
  const [grant, setGrant] = useState<ParcelGrant | null>(null)
  const [busy, setBusy] = useState(false)
  /** Transactions sent, waiting for Ethereum to confirm them: "Check again" reads the rights fresh. */
  const [waiting, setWaiting] = useState<Step>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = () =>
    api.getParcelGrant(destinationId).then(setGrant).catch((err) => setError(importFailure(err).message))
  useEffect(() => { load() }, [destinationId])

  if (!grant) return error ? <p className={errorBox} role="alert">{error}</p> : null
  const view = grantView(grant)
  if (!view.show) return null

  const run = async (fn: () => Promise<void>) => {
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      await fn()
    } catch (err) {
      // A wallet's own refusal has a code; the server's errors carry a body
      setError((err as { body?: unknown } | null)?.body ? importFailure(err).message : wizardErrorMessage(err))
    }
    setBusy(false)
  }

  const send = async (txs: GrantTransaction[], step: NonNullable<Step>) => {
    const wallet = getBrowserWallet()
    if (!wallet) throw new Error('No browser wallet found. Install MetaMask or another Ethereum wallet, then try again.')
    // Count each one as it goes: a later refusal still leaves the ones already sent to be checked
    let sent = 0
    try {
      await sendTransactions(wallet, txs, () => { sent++ })
    } finally {
      if (sent) setWaiting(step)
    }
    setNotice('Sent. Once Ethereum confirms the transaction, press Check again.')
  }

  const makeOperator = () => run(async () => {
    if (!grant.transactions?.length) {
      setNotice('There is nothing to send: Virvi may already hold the right. Press Check again.')
      setWaiting('granting')
      return
    }
    await send(grant.transactions, 'granting')
  })

  const removeOperator = () => run(async () => {
    const r = await api.getParcelRevoke(destinationId)
    setMessage(r.message ?? null)
    if (r.transactions.length) return send(r.transactions, 'revoking')
    // Nothing for the wallet to send: either only the Builder can remove it, or it is already gone
    if (r.message) { setWaiting('revoking'); return }
    await checkRevoke()
  })

  const checkGrant = () => run(async () => {
    const r = await api.checkParcelGrant(destinationId)
    if (r.granted) {
      setWaiting(null)
      setNotice('Virvi is an operator on these parcels. It deploys for you from now on.')
      await load()
      onChanged?.()
    } else {
      setNotice('Not confirmed yet. Give Ethereum a minute, then check again.')
    }
  })

  const checkRevoke = async () => {
    const r = await api.checkParcelRevoke(destinationId)
    if (r.revoked) {
      setWaiting(null)
      setMessage(null)
      setNotice('Virvi is no longer an operator. You sign each deploy from now on.')
      await load()
      onChanged?.()
    } else {
      setNotice('Virvi still holds a right on these parcels. If you just sent the transaction, give Ethereum a minute and check again.')
    }
  }

  return (
    <div className="space-y-3 rounded-md border border-gray-800 bg-gray-950 p-4 text-sm">
      <p className="font-medium text-white">Let Virvi deploy for you</p>
      {view.reason ? (
        <p className="text-gray-400">{view.reason}</p>
      ) : (
        <>
          <p className="text-gray-400">
            Make Virvi an update operator on these parcels and later deploys, like models you add in-world, go live without your signature.
            You can still sign every deploy yourself instead.
          </p>
          {grant.operator && (
            <p className="text-xs text-gray-500">Virvi&apos;s Genesis City address: <span className="break-all font-mono text-gray-300">{grant.operator}</span></p>
          )}
          {!grant.granted && <p className="text-yellow-200">{OPERATOR_REPLACES_NOTE}</p>}
          <p className="text-xs text-gray-500">{grant.costNote}</p>
          <div className="flex flex-wrap items-center gap-2">
            {grant.granted ? (
              <button type="button" onClick={removeOperator} disabled={busy} className={secondary}>
                {busy ? 'Working…' : 'Remove Virvi as operator'}
              </button>
            ) : (
              <button type="button" onClick={makeOperator} disabled={busy} className={button}>
                {busy ? 'Check your wallet…' : 'Make Virvi an operator'}
              </button>
            )}
            {waiting && (
              <button type="button" onClick={waiting === 'granting' ? checkGrant : () => run(checkRevoke)} disabled={busy} className={secondary}>
                Check again
              </button>
            )}
          </div>
        </>
      )}
      {message && <p className="text-yellow-200">{message}</p>}
      {notice && <p className={infoBox} role="status">{notice}</p>}
      {error && <p className={errorBox} role="alert">{error}</p>}
    </div>
  )
}
