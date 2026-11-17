'use client'
// The public page of one wallet's BEATs (LIV-185): /w/<address>. No sign-in and nothing account-related.
import { useEffect, useMemo, useState } from 'react'
import { beatAddressUrl, type BeatChain } from '@virvixr/shared'
import { useApi } from '@/lib/api'
import { filterCollected, shortWallet, walletFromPath, type WalletBeats } from '@/lib/beats'
import { BeatMedal } from '@/components/beats/BeatMedal'
import { beatDisplay } from '@/lib/beat-fonts'

const FIELD = 'rounded-full border border-[var(--bw-grid)] bg-[rgb(18_12_43/0.7)] px-3 py-1.5 text-sm text-[var(--bw-chrome)] [color-scheme:dark]'
const link = 'text-[var(--bw-cyan)] underline-offset-4 hover:underline'

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

  const earned = data ? data.beats.filter((b) => b.earned).length : 0
  return (
    <div className={`beat-world ${beatDisplay.variable} min-h-screen overflow-x-hidden`}>
      <header className="mx-auto flex max-w-5xl items-center justify-between px-4 py-5 sm:px-6">
        <a href="/w/" className="text-sm text-[var(--bw-dim)] hover:text-[var(--bw-chrome)]">Check another wallet</a>
        <a href="/beats" className="text-sm text-[var(--bw-dim)] hover:text-[var(--bw-chrome)]">What are BEATs?</a>
      </header>
      <main className="mx-auto max-w-5xl px-4 pb-28 sm:px-6">
        {state.kind === 'loading' && <p className="mt-16 text-center text-[var(--bw-dim)]" role="status">Loading…</p>}
        {state.kind === 'invalid' && (
          <Notice title="That isn’t a wallet address.">
            <a href="/w/" className={link}>Check a wallet</a>
          </Notice>
        )}
        {state.kind === 'error' && (
          <Notice title="Couldn’t load this wallet’s BEATs." alert>
            <button type="button" onClick={() => setAttempt((n) => n + 1)} className="rounded-full bg-[var(--bw-cyan)] px-5 py-2 text-sm font-semibold text-[var(--bw-night)] hover:brightness-110">Try again</button>
          </Notice>
        )}
        {data && (
          <>
            <section className="pb-10 pt-10 text-center sm:pt-16">
              <p className="text-sm text-[var(--bw-dim)]">BEATs held by</p>
              <h1 className="bw-display bw-glitch mt-3 break-all text-[clamp(1.9rem,6.5vw,4.2rem)] font-black leading-none tracking-tight" title={data.wallet}>
                {shortWallet(data.wallet)}
              </h1>
              <p className="mt-6 text-lg text-[var(--bw-chrome)]">
                {data.beats.length === 0 ? 'No BEATs yet.' : `${data.beats.length} ${data.beats.length === 1 ? 'BEAT' : 'BEATs'}, ${earned} earned by being there.`}
              </p>
              <p className="mt-4 flex flex-wrap items-center justify-center gap-x-5 gap-y-2 text-sm">
                <button type="button" onClick={copy} className={link}>{copied ? 'Copied' : 'Copy address'}</button>
                <a href={beatAddressUrl(chain, data.wallet)} target="_blank" rel="noopener noreferrer" className={link}>View on Polygonscan</a>
              </p>
            </section>
            {data.beats.length === 0 ? (
              <Notice title="This wallet doesn’t hold any BEATs yet.">
                <a href="/beats" className={link}>How to earn one</a>
              </Notice>
            ) : (
              <section className="bw-floor">
                <div className="mb-8 flex flex-wrap items-end justify-center gap-x-4 gap-y-3">
                  <label className="flex flex-col gap-1 text-xs text-[var(--bw-dim)]">From
                    <input type="date" className={FIELD} value={from ?? ''} onChange={(e) => setFrom(e.target.value || null)} />
                  </label>
                  <label className="flex flex-col gap-1 text-xs text-[var(--bw-dim)]">To
                    <input type="date" className={FIELD} value={to ?? ''} onChange={(e) => setTo(e.target.value || null)} />
                  </label>
                  <label className="flex items-center gap-2 pb-2 text-sm text-[var(--bw-chrome)]">
                    <input type="checkbox" className="accent-[var(--bw-cyan)]" checked={earnedOnly} onChange={(e) => setEarnedOnly(e.target.checked)} /> Earned only
                  </label>
                </div>
                {shown.length === 0 ? (
                  <p className="text-center text-sm text-[var(--bw-dim)]">No BEATs match these filters.</p>
                ) : (
                  <ul className="flex flex-wrap items-start justify-center gap-x-4 gap-y-8 [&>li]:w-44">
                    {shown.map((b) => <BeatMedal key={`${b.wallet}-${b.contract}-${b.tokenId}`} beat={b} showWallet={false} look="neon" />)}
                  </ul>
                )}
              </section>
            )}
          </>
        )}
      </main>
    </div>
  )
}

function Notice({ title, alert, children }: { title: string; alert?: boolean; children: React.ReactNode }) {
  return (
    <div className="mx-auto mt-16 max-w-md text-center" role={alert ? 'alert' : undefined}>
      <p className="bw-display text-xl font-bold">{title}</p>
      <div className="mt-5">{children}</div>
    </div>
  )
}
