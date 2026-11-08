import { signinPath } from '@/lib/landing-route'

export function Closing({ onTry }: { onTry: () => void }) {
  return (
    <section className="border-t border-gray-800">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-6 gap-y-4 px-4 py-12 sm:px-6">
        <div className="mr-auto">
          <h2 className="text-2xl font-semibold tracking-tight text-white">Ready to build?</h2>
          <p className="mt-1 text-gray-400">Free plan, no card needed. Or try it first, no account at all.</p>
        </div>
        <button type="button" onClick={onTry} className="rounded-lg border border-blue-500 px-5 py-2.5 font-semibold text-blue-200 hover:bg-blue-950 hover:text-white">Try now</button>
        <a href={signinPath()} className="rounded-lg border border-gray-600 px-5 py-2.5 font-semibold text-white hover:border-gray-400 hover:bg-gray-800">Sign in</a>
        <a href={signinPath(null, 'register')} className="clip-corner bg-accent px-5 py-2.5 font-semibold text-accent-ink hover:bg-accent-hover">Get started</a>
      </div>
    </section>
  )
}
