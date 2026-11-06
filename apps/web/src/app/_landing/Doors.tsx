import { signinPath } from '@/lib/landing-route'

/** A night plaza with a billboard in each of the four ad shapes; the 16:9 one carries the visitor's brand. */
function BillboardScene() {
  // Each billboard: x, width, height (from its shape), posts below it, all standing on the same ground line at y=150
  const boards = [
    { x: 14, w: 112, h: 63, label: 'Your brand here', lit: true, shape: '16:9' },
    { x: 146, w: 52, h: 52, shape: '1:1' },
    { x: 218, w: 34, h: 60, shape: '9:16' },
    { x: 272, w: 30, h: 75, shape: '2:5' },
  ]
  return (
    <figure className="mt-8">
      <svg viewBox="0 0 316 172" className="w-full max-w-md" role="img" aria-label="Billboards in a virtual plaza, one showing your brand">
        <defs>
          <radialGradient id="lp-sky" cx="0.3" cy="1" r="0.8">
            <stop offset="0" stopColor="#0e7490" stopOpacity="0.45" />
            <stop offset="1" stopColor="#0e7490" stopOpacity="0" />
          </radialGradient>
          <linearGradient id="lp-lit" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#67e8f9" />
            <stop offset="1" stopColor="#22d3ee" />
          </linearGradient>
        </defs>
        <rect x="0" y="0" width="316" height="150" fill="url(#lp-sky)" />
        {/* skyline */}
        <path d="M0 150V112h18V96h22v20h16V88h20v28h14v-14h26v48M200 150v-30h18v-18h30v26h22v-40h24v62h22" fill="none" stroke="#30353d" strokeWidth="1" />
        <line x1="0" y1="150" x2="316" y2="150" stroke="#474d57" />
        {boards.map((b) => {
          const top = 150 - 16 - b.h
          return (
            <g key={b.shape}>
              <line x1={b.x + b.w / 2} y1={top + b.h} x2={b.x + b.w / 2} y2="150" stroke="#474d57" strokeWidth="2" />
              {b.lit && <rect x={b.x - 6} y={top - 6} width={b.w + 12} height={b.h + 12} fill="#22d3ee" opacity="0.12" rx="4" />}
              <rect x={b.x} y={top} width={b.w} height={b.h} rx="1.5" fill={b.lit ? 'url(#lp-lit)' : '#1d2128'} stroke={b.lit ? '#a5f3fc' : '#30353d'} />
              {b.label && <text x={b.x + b.w / 2} y={top + b.h / 2 + 4} textAnchor="middle" fontSize="11" fontWeight="700" fill="#062a33">{b.label}</text>}
              <text x={b.x + b.w / 2} y="166" textAnchor="middle" fontSize="9" fill="#8a919c">{b.shape}</text>
            </g>
          )
        })}
      </svg>
      <figcaption className="sr-only">Ads come in four shapes: 16:9, 1:1, 9:16 and 2:5.</figcaption>
    </figure>
  )
}

export function Doors({ onAdvertise }: { onAdvertise: () => void }) {
  return (
    <section className="mx-auto grid max-w-6xl gap-5 px-4 pb-10 pt-10 sm:px-6 md:grid-cols-[1.3fr_1fr] md:items-start md:pt-16">
      <div className="relative corner-notch overflow-hidden rounded-xl border border-blue-700 bg-gradient-to-br from-blue-950 via-gray-900 to-gray-900 p-6 sm:p-10">
        <p className="mb-4 text-sm font-medium text-blue-300">For brands and creators</p>
        <h1 className="max-w-xl text-4xl font-semibold leading-[1.05] tracking-tight text-white sm:text-5xl">
          Put your brand where people actually hang out in the metaverse
        </h1>
        <p className="mt-5 max-w-lg text-base leading-relaxed text-gray-300">
          Image and video ads on screens and billboards inside live Decentraland scenes. Advertising is in early access: we set up each
          campaign with you and report what it delivered. No wallet or Decentraland account needed.
        </p>
        <button
          type="button"
          onClick={onAdvertise}
          className="clip-corner mt-8 bg-accent px-7 py-4 text-base font-semibold text-accent-ink hover:bg-accent-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-blue-300"
        >
          Advertise with Virvi →
        </button>
        <BillboardScene />
      </div>

      <div className="rounded-xl border border-gray-800 bg-gray-900 p-6 sm:p-10">
        <p className="mb-4 text-sm font-medium text-gray-400">For builders and venue owners</p>
        <h2 className="text-3xl font-semibold leading-tight tracking-tight text-white">Run every scene you own from one dashboard</h2>
        <p className="mt-5 text-base leading-relaxed text-gray-400">
          Change screens, streams and events live, without redeploying. Then turn your screens into ad spaces and earn from the campaigns we
          place in them.
        </p>
        <div className="mt-8 flex flex-wrap items-center gap-x-5 gap-y-3">
          <a href={signinPath(null, 'register')} className="inline-block rounded-lg border border-gray-600 px-5 py-3 font-semibold text-white hover:border-gray-400 hover:bg-gray-800">
            Start building — it's free
          </a>
          <a href="/try/studio/" className="text-sm font-medium text-blue-300 underline-offset-4 hover:underline">Try it — no account needed</a>
        </div>
      </div>
    </section>
  )
}
