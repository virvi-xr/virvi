// The BEAT band on the signed-out front page: what a BEAT is in one breath, in the BEAT pages' own look (.beat-world),
// with a way in for guests (/beat, wallet lookup) and for hosts (create one).
import { signinPath } from '@/lib/landing-route'
import { beatDisplay } from '@/lib/beat-fonts'

const POINTS = [
  { title: 'Free for every guest', text: 'Virvi pays the network fee, so claiming one never costs a thing.' },
  { title: 'Any kind of event', text: 'A virtual world, an AR space or a room full of people.' },
  { title: 'Yours to keep', text: 'It lands in the guest’s wallet with the event’s art, name, place and time.' },
]

export function BeatBand() {
  return (
    <section id="beats" className={`beat-world ${beatDisplay.variable} scroll-mt-6 overflow-hidden border-y border-[var(--bw-grid)]`}>
      <div className="mx-auto grid max-w-6xl items-center gap-12 px-4 py-16 sm:px-6 md:grid-cols-[auto_1fr]">
        <div className="bw-medal mx-auto w-[min(15rem,60vw)]" aria-hidden="true">
          <span className="bw-ring bw-ring-1" />
          <span className="bw-ring bw-ring-2" />
          <span className="bw-ring bw-ring-3" />
          <span className="bw-core">
            <span className="bw-display text-2xl font-black tracking-[0.08em] text-[var(--bw-chrome)]">BEAT</span>
          </span>
        </div>
        <div>
          <h2 className="bw-display text-3xl font-black leading-tight sm:text-5xl">Proof you were there.</h2>
          <p className="mt-4 max-w-xl text-lg leading-relaxed text-[var(--bw-dim)]">
            Give your event a BEAT and everyone who shows up takes home a token that records where they were and when.
          </p>
          <ul className="mt-8 grid gap-6 sm:grid-cols-3">
            {POINTS.map((p) => (
              <li key={p.title} className="border-t-2 border-[var(--bw-cyan)] pt-4">
                <h3 className="font-semibold text-[var(--bw-chrome)]">{p.title}</h3>
                <p className="mt-2 text-sm leading-relaxed text-[var(--bw-dim)]">{p.text}</p>
              </li>
            ))}
          </ul>
          <div className="mt-10 flex flex-wrap items-center gap-3">
            <a href={signinPath('/beats/new')} className="rounded-full bg-[var(--bw-pink)] px-6 py-3 text-sm font-semibold text-[var(--bw-night)] hover:brightness-110">
              Create a BEAT
            </a>
            <a href="/beat/" className="rounded-full border border-[var(--bw-cyan)] px-6 py-3 text-sm font-semibold text-[var(--bw-cyan)] hover:bg-[rgb(8_221_235/0.1)]">
              See your BEATs
            </a>
          </div>
        </div>
      </div>
    </section>
  )
}
