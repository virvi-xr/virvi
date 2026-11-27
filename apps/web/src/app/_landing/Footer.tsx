import { siteLinks } from '@/lib/site'

export function Footer({ onAdvertise }: { onAdvertise: () => void }) {
  const { docs, discord, privacy, terms, summit, ar } = siteLinks()
  return (
    <footer className="border-t border-gray-800">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-6 gap-y-2 px-4 py-6 text-sm text-gray-500 sm:px-6">
        <span className="mr-auto text-gray-400">© {new Date().getFullYear()} Livication LLC</span>
        {docs && <a href={docs} className="hover:text-white">Docs</a>}
        <a href={summit} className="hover:text-white">Summit</a>
        <a href={ar} className="hover:text-white">AR</a>
        <button type="button" onClick={onAdvertise} className="hover:text-white">Advertise</button>
        {discord && <a href={discord} className="hover:text-white">Discord</a>}
        {privacy && <a href={privacy} className="hover:text-white">Privacy</a>}
        <a href={terms} className="hover:text-white">Terms</a>
        <a href="/transparency/" className="hover:text-white">Transparency</a>
        <a href="/status/" className="hover:text-white">Status</a>
        <a href="/about/" className="hover:text-white">About</a>
      </div>
    </footer>
  )
}
