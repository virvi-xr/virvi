'use client'
// The public page of one wallet's BEATs (LIV-185): /w/<address>. No sign-in and nothing account-related.
import { useEffect, useMemo, useState } from 'react'
import { beatAddressUrl, type BeatChain } from '@virvixr/shared'
import { useApi } from '@/lib/api'
import { filterCollected, shortWallet, walletFromPath, type WalletBeats } from '@/lib/beats'
import { BeatMedal } from '@/components/beats/BeatMedal'

const FIELD = 'rounded-md border border-gray-700 bg-gray-900 px-2 py-1.5 text-sm text-gray-200'
const link = 'text-blue-400 hover:underline'

type State = { kind: 'loading' } | { kind: 'invalid' } | { kind: 'error' } | { kind: 'ready'; data: WalletBeats }

export default function WalletBeatsClient() {
  const api = useApi()
  const [state, setState] = useState<State>({ kind: 'loading' })
  const [chain, setChain] = useState<BeatChain>('polygon')
  const [from, setFrom] = useState<string | null>(null)
  const [to, setTo] = useState<string | null>(null)
  const [earnedOnly, setEarnedOnly] = useState(false)
  const [copied, setCopied] = useState(false)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    const address = walletFromPath(window.location.pathname)
    if (!address) { setState({ kind: 'invalid' }); return }
    document.title = `BEATs held by ${shortWallet(address)}`
    setState({ kind: 'loading' })
    let live = true
    api.getWalletBeats(address)
      .then(async (data) => {
        if (!live) return
        if (data.beats[0]) setChain(data.beats[0].chain)
        else await api.getBeatAvailability().then((a) => live && setChain(a.chain)).catch(() => {})
        if (live) setState({ kind: 'ready', data })
      })
      .catch((err) => { if (live) setState({ kind: (err as { status?: number })?.status === 404 ? 'invalid' : 'error' }) })
    return () => { live = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attempt])

  const data = state.kind === 'ready' ? state.data : null
  const shown = useMemo(
    () => (data ? filterCollected(data.beats, { wallet: 'all', from, to, kind: 'all', earnedOnly }) : []),
    [data, from, to, earnedOnly],
  )

  const copy = () => {
    if (!data) return
    navigator.clipboard?.writeText(data.wallet).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500) }).catch(() => {})
  }

  return (
    <div className="min-h-screen bg-gray-950 px-4 py-12 sm:px-6">
      <div className="mx-auto max-w-2xl text-gray-300">
        <a href="/" className="text-sm text-gray-400 hover:text-white">← Back to Virvi</a>
        {state.kind === 'loading' && <p className="mt-8 text-gray-500" role="status">Loading…</p>}
        {state.kind === 'invalid' && (
          <div className="mt-8"><p>That isn’t a wallet address.</p><a href="/beats" className={link}>What are BEATs?</a></div>
        )}
        {state.kind === 'error' && (
          <div className="mt-8" role="alert">
            <p className="text-amber-300">Couldn’t load this wallet’s BEATs. Try again.</p>
            <button type="button" onClick={() => setAttempt((n) => n + 1)} className="mt-3 rounded-md bg-gray-800 px-3 py-1.5 text-sm text-gray-300 hover:bg-gray-700">Try again</button>
          </div>
        )}
        {data && (
          <>
            <h1 className="mt-6 text-3xl font-semibold tracking-tight text-white">BEATs held by <span className="font-mono" title={data.wallet}>{shortWallet(data.wallet)}</span></h1>
            <p className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
              <button type="button" onClick={copy} className={link}>{copied ? 'Copied' : 'Copy address'}</button>
              <a href={beatAddressUrl(chain, data.wallet)} target="_blank" rel="noopener noreferrer" className={link}>View on Polygonscan</a>
            </p>
            {data.beats.length === 0 ? (
              <div className="mt-8"><p>This wallet doesn’t hold any BEATs yet.</p><a href="/beats" className={link}>What are BEATs?</a></div>
            ) : (
              <>
                <p className="mt-4 text-gray-400">{data.beats.length} {data.beats.length === 1 ? 'BEAT' : 'BEATs'} · {data.beats.filter((b) => b.earned).length} earned</p>
                <div className="mb-4 mt-6 flex flex-wrap items-end gap-x-4 gap-y-3">
                  <label className="flex flex-col gap-1 text-xs text-gray-400">From
                    <input type="date" className={FIELD} value={from ?? ''} onChange={(e) => setFrom(e.target.value || null)} />
                  </label>
                  <label className="flex flex-col gap-1 text-xs text-gray-400">To
                    <input type="date" className={FIELD} value={to ?? ''} onChange={(e) => setTo(e.target.value || null)} />
                  </label>
                  <label className="flex items-center gap-2 pb-2 text-sm text-gray-300">
                    <input type="checkbox" checked={earnedOnly} onChange={(e) => setEarnedOnly(e.target.checked)} /> Earned only
                  </label>
                </div>
                {shown.length === 0 ? (
                  <p className="text-sm text-gray-400">No BEATs match these filters.</p>
                ) : (
                  <ul className="grid grid-cols-[repeat(auto-fill,minmax(11rem,1fr))] items-start gap-3">
                    {shown.map((b) => <BeatMedal key={`${b.wallet}-${b.contract}-${b.tokenId}`} beat={b} showWallet={false} />)}
                  </ul>
                )}
              </>
            )}
          </>
        )}
      </div>
    </div>
  )
}
