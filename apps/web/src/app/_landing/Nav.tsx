import { signinPath } from '@/lib/landing-route'
import { siteLinks } from '@/lib/site'

export function Nav({ onAdvertise, onTry }: { onAdvertise: () => void; onTry: () => void }) {
  const { docs } = siteLinks()
  return (
    <header className="border-b border-gray-800">
      <nav className="mx-auto flex max-w-6xl items-center gap-5 px-4 py-4 sm:px-6">
        <a href="/" className="shrink-0"><img src="/virvi-logo-light.svg" alt="Virvi" className="h-7 w-auto" /></a>
        <div className="hidden flex-1 items-center gap-6 text-sm text-gray-400 md:flex">
          <a href="#features" className="hover:text-white">Features</a>
          <button type="button" onClick={onAdvertise} className="hover:text-white">Advertise</button>
          {docs && <a href={docs} className="hover:text-white">Docs</a>}
        </div>
        <div className="ml-auto flex items-center gap-2 md:ml-0">
          <button type="button" onClick={onTry} className="rounded-lg border border-blue-500 px-3 py-2 text-sm font-semibold text-blue-200 hover:bg-blue-950 hover:text-white sm:px-4">
            Try now
          </button>
          <a href={signinPath()} className="rounded-lg px-3 py-2 text-sm text-gray-300 hover:bg-gray-800 hover:text-white">Sign in</a>
          <a href={signinPath(null, 'register')} className="clip-corner hidden bg-accent sm:inline-block px-4 py-2 text-sm font-semibold text-accent-ink hover:bg-accent-hover">Get started</a>
        </div>
      </nav>
    </header>
  )
}
