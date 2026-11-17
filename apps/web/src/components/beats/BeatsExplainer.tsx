'use client'
// The public BEAT page: /beats for signed-out visitors (every token's external_url and the explorer listings link
// here) and /w for anyone. A hero with the wallet lookup, then what a BEAT is, how to earn one and how hosts make one.
// Keep it in step with how BEATs work (apps/server/src/beats) and with the transparency page. Styles: .beat-world in
// styles/globals.css.
import { useState } from 'react'
import { signinPath } from '@/lib/landing-route'
import { walletLookupHref } from '@/lib/beats'
import { beatDisplay } from '@/lib/beat-fonts'

const link = 'text-[var(--bw-cyan)] underline-offset-4 hover:underline'

export function BeatsExplainer() {
  return (
    <div className={`beat-world ${beatDisplay.variable} min-h-screen overflow-x-hidden`}>
      <header className="mx-auto flex max-w-5xl items-center justify-between px-4 py-5 sm:px-6">
        <a href="/" className="text-sm text-[var(--bw-dim)] hover:text-[var(--bw-chrome)]">Virvi</a>
        <a href="/transparency/" className="text-sm text-[var(--bw-dim)] hover:text-[var(--bw-chrome)]">Check the contract</a>
      </header>

      <section className="mx-auto flex max-w-5xl flex-col items-center px-4 pb-20 pt-6 text-center sm:px-6">
        <div className="bw-medal" aria-hidden="true">
          <span className="bw-ring bw-ring-1" />
          <span className="bw-ring bw-ring-2" />
          <span className="bw-ring bw-ring-3" />
          <span className="bw-core">
            <span className="bw-display text-[clamp(1.4rem,5vw,2.2rem)] font-black tracking-[0.08em] text-[var(--bw-chrome)]">BEAT</span>
          </span>
        </div>
        <h1 className="bw-display mt-10 max-w-3xl text-[clamp(2.2rem,7vw,4.6rem)] font-black leading-[0.95] tracking-tight">
          Proof you were there.
        </h1>
        <p className="mt-6 max-w-xl text-lg leading-relaxed text-[var(--bw-dim)]">
          BEATs are Basic Event Attendance Tokens. Show up to an event in a virtual world like Decentraland, claim its
          BEAT, and it stays in your wallet as a record of the event, the place and the time.
        </p>
        <WalletLookup />
      </section>

      <article className="mx-auto max-w-2xl px-4 pb-24 sm:px-6 [&_h2]:mb-4 [&_h2]:mt-16 [&_h2]:text-2xl [&_h2]:font-bold [&_li]:mt-2 [&_p]:leading-relaxed [&_p]:text-[var(--bw-dim)] [&_li]:text-[var(--bw-dim)]">
        <h2 className="bw-display">Earning a BEAT</h2>
        <ol className="list-decimal space-y-1 pl-5 marker:text-[var(--bw-cyan)]">
          <li>Go to the event in Decentraland, signed in with your wallet. A BEAT card appears in the scene while the BEAT is open.</li>
          <li>Choose <strong className="text-[var(--bw-chrome)]">Track my attendance</strong> and stay for the time the card shows.</li>
          <li>Choose <strong className="text-[var(--bw-chrome)]">Claim your BEAT</strong>. It arrives in the same wallet a few minutes later.</li>
        </ol>
        <p className="mt-4">
          Claiming is free: you never sign or pay anything, and Virvi pays the network fee. Each wallet can claim a BEAT once,
          and some BEATs have a limited number. Guests without a wallet can’t claim one.
        </p>

        <h2 className="bw-display">Where it lives</h2>
        <p>
          BEATs are ERC-1155 tokens on Polygon, the network Decentraland’s wearables use. Paste your wallet above to see yours,
          or find them in your wallet app.
        </p>
        <p className="mt-3">
          Most BEATs can’t be sold or sent to anyone else: they stay in the wallet that earned them, so they keep proving who was
          there. A host can choose to make theirs tradeable when creating it, and that can’t be changed afterwards.
        </p>
        <p className="mt-3">
          Lost access to your wallet, or had it stolen? Sign in to Virvi and ask for your BEATs to be moved to a new wallet
          from your settings. Virvi checks each request before moving anything.
        </p>

        <h2 className="bw-display">Making a BEAT for your event</h2>
        <p>
          Hosts create a BEAT on Virvi: a name, an image, the event’s time, the scenes it’s in, and how long visitors need to
          stay. The price for each event is shown before you pay, and visitors never pay anything.
        </p>
        <p className="mt-6">
          <a href={signinPath('/beats/new')} className="inline-flex items-center rounded-full bg-[var(--bw-pink)] px-5 py-2.5 text-sm font-semibold text-[var(--bw-night)] hover:brightness-110">
            Sign in to create a BEAT
          </a>
        </p>

        <h2 className="bw-display">Check the contract</h2>
        <p>
          Every BEAT comes from one public contract on each network. Its code is published, and it’s controlled by a multisig
          wallet that needs two of three keys. The <a href="/transparency/" className={link}>transparency page</a> lists the
          contract, with links to its code and to Polygonscan.
        </p>
        <p className="mt-3">
          Questions? Email <a href="mailto:support@virvi.io" className={link}>support@virvi.io</a>. The{' '}
          <a href="/privacy/" className={link}>privacy page</a> explains what Virvi keeps when you track your attendance.
        </p>
      </article>
    </div>
  )
}

/** Paste a wallet address, open its BEATs page. */
function WalletLookup() {
  const [value, setValue] = useState('')
  const [error, setError] = useState(false)
  const go = (e: React.FormEvent) => {
    e.preventDefault()
    const href = walletLookupHref(value)
    if (!href) { setError(true); return }
    window.location.href = href
  }
  return (
    <form onSubmit={go} className="mt-10 w-full max-w-xl" noValidate>
      <label htmlFor="bw-wallet" className="block text-left text-sm text-[var(--bw-dim)]">Check a wallet’s BEATs</label>
      <div className="mt-2 flex flex-col gap-2 sm:flex-row">
        <input id="bw-wallet" value={value} onChange={(e) => { setValue(e.target.value); setError(false) }}
          placeholder="0x…" autoComplete="off" spellCheck={false} inputMode="text" aria-invalid={error} aria-describedby={error ? 'bw-wallet-error' : undefined}
          className="min-w-0 flex-1 rounded-full border border-[var(--bw-grid)] bg-[rgb(18_12_43/0.7)] px-5 py-3 font-mono text-sm text-[var(--bw-chrome)] placeholder:text-[var(--bw-dim)] focus:border-[var(--bw-cyan)]" />
        <button type="submit" className="rounded-full bg-[var(--bw-cyan)] px-6 py-3 text-sm font-semibold text-[var(--bw-night)] hover:brightness-110">
          Show BEATs
        </button>
      </div>
      {error && (
        <p id="bw-wallet-error" role="alert" className="mt-2 text-left text-sm text-[var(--bw-pink)]">
          Enter a wallet address: 0x followed by 40 letters and numbers.
        </p>
      )}
    </form>
  )
}
