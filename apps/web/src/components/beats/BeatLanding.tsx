'use client'
// virvi.io/beat: the BEAT landing page. Every token's external_url points here, and /beats (signed out) and /w/ send
// people here. Its job: say what a BEAT is in one breath, and take a wallet address to that wallet's BEATs (/w/<wallet>).
// Styles: .beat-world in styles/globals.css.
import { useState } from 'react'
import { signinPath } from '@/lib/landing-route'
import { walletLookupHref } from '@/lib/beats'
import { beatDisplay } from '@/lib/beat-fonts'

const quiet = 'text-sm text-[var(--bw-dim)] hover:text-[var(--bw-chrome)]'

export function BeatLanding() {
  return (
    <div className={`beat-world ${beatDisplay.variable} min-h-screen overflow-x-hidden`}>
      <header className="mx-auto flex max-w-6xl items-center justify-between px-4 py-5 sm:px-6">
        <a href="/" className="shrink-0"><img src="/virvi-logo-light.svg" alt="Virvi" className="h-7 w-auto" /></a>
        <a href={signinPath('/beats')} className={quiet}>Sign in</a>
      </header>
      <main>

      <section className="relative mx-auto flex min-h-[calc(100svh-4.5rem)] max-w-6xl flex-col items-center justify-center px-4 pb-16 text-center sm:px-6">
        <div className="bw-medal bw-medal-lg" aria-hidden="true">
          <span className="bw-ring bw-ring-1" />
          <span className="bw-ring bw-ring-2" />
          <span className="bw-ring bw-ring-3" />
          <span className="bw-core">
            <span className="bw-display text-[clamp(1.6rem,6vw,2.8rem)] font-black tracking-[0.08em] text-[var(--bw-chrome)]">BEAT</span>
          </span>
        </div>
        <h1 className="bw-display mt-8 text-[clamp(2.6rem,9vw,6.5rem)] font-black leading-[0.9] tracking-tight">
          Proof you<br />were there.
        </h1>
        <p className="mt-6 max-w-lg text-lg leading-relaxed text-[var(--bw-dim)]">
          BEATs are tokens you earn by showing up. Any event can have one, and each records where you were and when.
        </p>
        <WalletLookup />
      </section>

      <section className="mx-auto max-w-5xl px-4 pb-20 sm:px-6">
        <ol className="grid gap-10 sm:grid-cols-3 sm:gap-8">
          <Step n="1" title="Show up">Be there, wherever the event happens: a virtual world, an AR space or a room full of people. Bring your wallet.</Step>
          <Step n="2" title="Claim it">Check in the way the host asks, and the BEAT is yours. It’s free: Virvi pays the network fee.</Step>
          <Step n="3" title="Keep it">It lands in your wallet on Polygon, with the event’s art, name, place and time. BEATs can’t be sold unless the host chooses otherwise.</Step>
        </ol>
        <p className="mt-10"><a href="/beat/how-it-works/" className="text-[var(--bw-cyan)] underline-offset-4 hover:underline">How BEATs stay on chain, private and recoverable</a></p>
      </section>

      <section className="mx-auto max-w-5xl px-4 pb-24 sm:px-6">
        <div className="flex flex-col items-start gap-5 border-t border-[var(--bw-grid)] pt-10 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="bw-display text-2xl font-bold">Hosting an event?</h2>
            <p className="mt-3 max-w-lg text-lg text-[var(--bw-chrome)]">Give every guest something to keep.</p>
            <p className="mt-2 max-w-lg text-[var(--bw-dim)]">
              Choose a piece of art for your event, and everyone who shows up takes it home. It stays in their wallet
              long after the lights go down: the night they met their people, the show they almost missed, the room
              they’ll still talk about years from now. It’s free for your guests, always.
            </p>
          </div>
          <a href={signinPath('/beats/new')} className="shrink-0 rounded-full bg-[var(--bw-pink)] px-6 py-3 text-sm font-semibold text-[var(--bw-night)] hover:brightness-110">
            Create a BEAT
          </a>
        </div>
      </section>

      </main>
      <footer className="mx-auto flex max-w-5xl flex-wrap gap-x-6 gap-y-2 px-4 pb-10 sm:px-6">
        <span className="mr-auto text-sm text-[var(--bw-dim)]">© {new Date().getFullYear()} Livication LLC</span>
        <a href="/beat/how-it-works/" className={quiet}>How BEATs work</a>
        <a href="/about/" className={quiet}>About Virvi</a>
        <a href="https://discord.gg/cMAK5YCtSk" className={quiet}>Discord</a>
        <a href="/transparency/" className={quiet}>Check the contract</a>
        <a href="/privacy/" className={quiet}>Privacy</a>
        <a href="mailto:support@virvi.io" className={quiet}>support@virvi.io</a>
      </footer>
    </div>
  )
}

function Step({ n, title, children }: { n: string; title: string; children: React.ReactNode }) {
  return (
    <li className="list-none">
      <span className="bw-display text-5xl font-black text-transparent [-webkit-text-stroke:1px_var(--bw-cyan)]" aria-hidden="true">{n}</span>
      <h2 className="bw-display mt-3 text-xl font-bold">{title}</h2>
      <p className="mt-2 leading-relaxed text-[var(--bw-dim)]">{children}</p>
    </li>
  )
}

/** Paste a wallet address, open its BEATs. */
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
    <form onSubmit={go} className="mt-10 w-full max-w-2xl" noValidate>
      <label htmlFor="bw-wallet" className="sr-only">Your wallet address</label>
      <div className="flex flex-col gap-2 rounded-[2rem] border border-[var(--bw-grid)] bg-[rgb(18_12_43/0.75)] p-2 shadow-[0_0_40px_rgb(8_221_235/0.15)] focus-within:border-[var(--bw-cyan)] sm:flex-row">
        <input id="bw-wallet" value={value} onChange={(e) => { setValue(e.target.value); setError(false) }}
          placeholder="Paste your wallet address (0x…)" autoComplete="off" spellCheck={false}
          aria-invalid={error} aria-describedby={error ? 'bw-wallet-error' : undefined}
          className="min-w-0 flex-1 bg-transparent px-4 py-3 font-mono text-base text-[var(--bw-chrome)] outline-none placeholder:font-sans placeholder:text-[var(--bw-dim)]" />
        <button type="submit" className="rounded-full bg-[var(--bw-cyan)] px-7 py-3 text-base font-semibold text-[var(--bw-night)] hover:brightness-110">
          See my BEATs
        </button>
      </div>
      {error && (
        <p id="bw-wallet-error" role="alert" className="mt-3 text-sm text-[var(--bw-pink)]">
          That isn’t a wallet address. It starts with 0x and has 40 more letters and numbers.
        </p>
      )}
    </form>
  )
}
