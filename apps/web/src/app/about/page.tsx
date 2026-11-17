import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'About Virvi',
  description: 'Who makes Virvi: Livication LLC, founded by Steven A. Williams.',
}

const link = 'text-blue-400 hover:underline'
const DISCORD = 'https://discord.gg/cMAK5YCtSk'

// The company and the people behind Virvi. Token listings (Polygonscan) ask for the team to be shown with links to
// their professional profiles; keep this factual and in step with the founder's own sites.
export default function AboutPage() {
  return (
    <div className="min-h-screen bg-gray-950 px-4 py-12 sm:px-6">
      <article className="mx-auto max-w-2xl text-gray-300 [&_h2]:mb-3 [&_h2]:mt-10 [&_h2]:text-xl [&_h2]:font-semibold [&_h2]:text-white [&_p]:leading-relaxed">
        <a href="/" className="text-sm text-gray-400 hover:text-white">← Back to Virvi</a>
        <h1 className="mt-6 text-3xl font-semibold tracking-tight text-white">About Virvi</h1>
        <p className="mt-4">
          Virvi runs scenes and events in virtual worlds from one dashboard: screens and live video, ads, Design Studio for
          wearables and emotes, and <a href="/beat/" className={link}>BEATs</a>, the attendance tokens people earn by showing up.
          It’s made by Livication LLC, and its code is public on{' '}
          <a href="https://github.com/virvi-xr/virvi" className={link}>GitHub</a>.
        </p>

        <h2>Team</h2>
        <section aria-labelledby="founder" className="rounded-lg border border-gray-800 bg-gray-900 p-5">
          <h3 id="founder" className="text-lg font-semibold text-white">Steven A. Williams</h3>
          <p className="text-sm text-gray-400">Founder, Livication LLC</p>
          <p className="mt-3">
            A senior software engineer and creative technologist in Melbourne, Florida, who designs and builds Virvi. He also
            makes music, writing and immersive work as Unknower, and took part in Decentraland’s 2024 DAO ReGenesis summit.
          </p>
          <p className="mt-3 flex flex-wrap gap-x-5 gap-y-1">
            <a href="https://www.linkedin.com/in/stevenwritescode" className={link} rel="me">LinkedIn</a>
            <a href="https://stevenawilliams.net" className={link} rel="me">stevenawilliams.net</a>
            <a href="https://unknower.io" className={link} rel="me">unknower.io</a>
          </p>
        </section>

        <h2>Contact</h2>
        <p>
          Email <a href="mailto:support@virvi.io" className={link}>support@virvi.io</a>, or join the{' '}
          <a href={DISCORD} className={link}>Virvi XR Discord</a>. How Virvi handles your data is on the{' '}
          <a href="/privacy/" className={link}>privacy page</a>, and what’s running is on the{' '}
          <a href="/transparency/" className={link}>transparency page</a>.
        </p>
      </article>
    </div>
  )
}
