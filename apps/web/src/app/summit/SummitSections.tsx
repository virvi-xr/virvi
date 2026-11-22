import { SUMMIT_AGENDA, SUMMIT_OFFERINGS } from '@/lib/summit'

const WAYS = [
  {
    title: 'Online',
    text: 'Watch the stream, or come into any Virvi world, where every session plays live. We’ll email you the links before the day.',
  },
  {
    title: 'In person',
    text: 'Join us in the studio in Melbourne, Florida. The room is limited, so this is an RSVP request: we’ll email you to confirm, and the full address goes only to confirmed guests.',
  },
  {
    title: 'Host a watch party',
    text: 'Gather people where you are. We’ll send you a host kit: the watch link, QR cards, a slide for the room and a check-in Drop for your guests.',
  },
]

const eyebrow = 'text-sm font-medium uppercase tracking-wider text-accent'
const h2 = 'text-3xl font-semibold tracking-tight text-white sm:text-4xl'

/** The Summit page's content, top to bottom, before the sign-up form. */
export function SummitSections() {
  return (
    <>
      <section className="mx-auto max-w-6xl px-4 pb-12 pt-10 sm:px-6 md:pt-16">
        <div className="relative corner-notch overflow-hidden rounded-xl border border-blue-700 bg-gradient-to-br from-blue-950 via-gray-900 to-gray-900 p-6 sm:p-10">
          <p className={eyebrow}>Wednesday 3 – Thursday 4 February 2027</p>
          <h1 className="mt-4 max-w-3xl text-4xl font-semibold leading-[1.05] tracking-tight text-white sm:text-6xl">Virvi Launch Summit</h1>
          <p className="mt-4 text-2xl font-medium text-blue-200 sm:text-3xl">Create once. Live everywhere.</p>
          <p className="mt-6 max-w-xl leading-relaxed text-gray-300">
            Two days of live launches from Livication Studios, Melbourne, Florida, and live in every Virvi world at the same time. Plus watch
            parties run by the community, wherever you are.
          </p>
          <a href="#sign-up" className="clip-corner mt-8 inline-block bg-accent px-6 py-3 font-semibold text-accent-ink hover:bg-accent-hover">Sign up</a>
        </div>
      </section>

      <section aria-labelledby="summit-offerings" className="mx-auto max-w-6xl px-4 py-12 sm:px-6">
        <p className={eyebrow}>What launches</p>
        <h2 id="summit-offerings" className={`mt-2 ${h2}`}>Seven things, shown live</h2>
        <ul className="mt-8 grid gap-x-12 border-t border-gray-800 md:grid-cols-2">
          {SUMMIT_OFFERINGS.map((o) => (
            <li key={o.id} className="border-b border-gray-800 py-5">
              <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                <h3 className="font-semibold text-white">{o.name}</h3>
                <span className="text-sm text-gray-400">{o.session} EST</span>
              </div>
              <p className="mt-1 max-w-md text-gray-400">{o.blurb}</p>
            </li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="summit-ways" className="mx-auto max-w-6xl px-4 py-12 sm:px-6">
        <p className={eyebrow}>Be there</p>
        <h2 id="summit-ways" className={`mt-2 ${h2}`}>Three ways to join</h2>
        <div className="mt-8 grid gap-5 md:grid-cols-3">
          {WAYS.map((w) => (
            <div key={w.title} className="rounded-xl border border-gray-800 bg-gray-900 p-6">
              <h3 className="text-lg font-semibold text-white">{w.title}</h3>
              <p className="mt-2 leading-relaxed text-gray-400">{w.text}</p>
            </div>
          ))}
        </div>
      </section>

      <section aria-labelledby="summit-agenda" className="mx-auto max-w-6xl px-4 py-12 sm:px-6">
        <p className={eyebrow}>Agenda</p>
        <h2 id="summit-agenda" className={`mt-2 ${h2}`}>Two days</h2>
        <p className="mt-2 text-sm text-gray-400">All times Eastern (EST). Agenda may change.</p>
        <div className="mt-8 grid gap-8 md:grid-cols-2">
          {SUMMIT_AGENDA.map((d) => (
            <div key={d.day}>
              <h3 className="font-semibold text-white">{d.day}</h3>
              <ol className="mt-3 border-t border-gray-800">
                {d.items.map((i) => (
                  <li key={i.time} className="flex gap-4 border-b border-gray-800 py-3">
                    <span className="w-12 shrink-0 font-mono text-sm leading-6 text-accent">{i.time}</span>
                    <span className="min-w-0 text-gray-300">{i.title}</span>
                  </li>
                ))}
              </ol>
            </div>
          ))}
        </div>
      </section>
    </>
  )
}
