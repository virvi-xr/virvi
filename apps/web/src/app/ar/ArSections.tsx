import { AR_APPS_REPO } from '@virvixr/shared'
import { ArAppCards } from '@/components/ar/ArAppCards'
import { siteLinks } from '@/lib/site'

const link = 'text-blue-300 underline underline-offset-2 hover:text-white'

/** virvi.io/ar's content: what AR Spaces are, the apps, setting up a space, and the source. */
export function ArSections() {
  const { docs } = siteLinks()
  return (
    <>
      <section className="mx-auto max-w-6xl px-4 pb-10 pt-14 sm:px-6 sm:pt-20">
        <p className="text-sm font-medium uppercase tracking-[0.2em] text-accent">Virvi AR</p>
        <h1 className="mt-3 max-w-3xl text-4xl font-semibold tracking-tight text-white sm:text-5xl">Your scene, in a real place</h1>
        <div className="mt-6 max-w-2xl space-y-3 text-lg leading-relaxed text-gray-300">
          <p>AR Spaces put your Virvi scene in a real room, life-size.</p>
          <p>Look at the ring by the door, and the scene is there: the screens, the art, the models, where you put them.</p>
          <p>It stays in sync with Decentraland and Hyperfy. Change something in the dashboard, and it changes everywhere at once.</p>
        </div>
      </section>

      <section aria-labelledby="ar-apps" className="mx-auto max-w-6xl px-4 py-10 sm:px-6">
        <h2 id="ar-apps" className="text-2xl font-semibold tracking-tight text-white">One app, three platforms</h2>
        <p className="mt-2 max-w-2xl text-gray-400">Virvi AR is the same app, with the same spaces, on Meta Quest, Apple Vision Pro and iPhone. It isn’t in a store yet, so for now you build it from the source.</p>
        <div className="mt-6"><ArAppCards /></div>
      </section>

      <section aria-labelledby="ar-setup" className="mx-auto max-w-6xl px-4 py-10 sm:px-6">
        <h2 id="ar-setup" className="text-2xl font-semibold tracking-tight text-white">Set up your own space</h2>
        <p className="mt-2 max-w-2xl text-gray-400">For venue owners. It takes three steps, all from the dashboard.</p>
        <ol className="mt-6 grid gap-4 sm:grid-cols-3">
          <Step n="1" title="Mount a ring by the door">Print the ring from your scene’s AR spaces tab, and put it up at eye level near the entrance.</Step>
          <Step n="2" title="Line the scene up once">Stand at the ring with a headset, and nudge the scene until it sits right in the room.</Step>
          <Step n="3" title="Publish">Publish the space. Anyone who looks at the ring sees your scene.</Step>
        </ol>
        <p className="mt-6"><a href={docs} className={link}>Read the docs</a></p>
      </section>

      <section aria-labelledby="ar-source" className="mx-auto max-w-6xl px-4 pb-16 pt-10 sm:px-6">
        <h2 id="ar-source" className="text-2xl font-semibold tracking-tight text-white">Open source</h2>
        <p className="mt-2 max-w-2xl text-gray-400">
          The apps are open source, like the rest of Virvi. Read the code, build it, or help out on{' '}
          <a href={AR_APPS_REPO} className={link}>GitHub</a>.
        </p>
      </section>
    </>
  )
}

function Step({ n, title, children }: { n: string; title: string; children: React.ReactNode }) {
  return (
    <li className="rounded-lg border border-gray-800 p-5">
      <span className="text-sm font-semibold text-accent">{n}</span>
      <h3 className="mt-1 font-semibold text-white">{title}</h3>
      <p className="mt-1 text-gray-400">{children}</p>
    </li>
  )
}
