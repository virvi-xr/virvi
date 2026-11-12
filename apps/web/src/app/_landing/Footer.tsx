import { siteLinks } from '@/lib/site'

export function Footer({ onAdvertise }: { onAdvertise: () => void }) {
  const { docs, discord, privacy } = siteLinks()
  return (
    <footer className="border-t border-gray-800">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-6 gap-y-2 px-4 py-6 text-sm text-gray-500 sm:px-6">
        <span className="mr-auto text-gray-400">Virvi</span>
        {docs && <a href={docs} className="hover:text-white">Docs</a>}
        <button type="button" onClick={onAdvertise} className="hover:text-white">Advertise</button>
        {discord && <a href={discord} className="hover:text-white">Discord</a>}
        {privacy && <a href={privacy} className="hover:text-white">Privacy</a>}
        <a href="/transparency/" className="hover:text-white">Transparency</a>
      </div>
    </footer>
  )
}
