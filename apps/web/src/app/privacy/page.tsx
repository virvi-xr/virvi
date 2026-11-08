import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Privacy',
  description: 'What Virvi collects in Decentraland scenes, in error reports and from the advertiser early-access form, and how to have it removed.',
}

// Keep in step with apps/docs/src/content/docs/privacy.md
export default function PrivacyPage() {
  return (
    <div className="min-h-screen bg-gray-950 px-4 py-12 sm:px-6">
      <article className="mx-auto max-w-2xl text-gray-300 [&_h2]:mb-3 [&_h2]:mt-10 [&_h2]:text-xl [&_h2]:font-semibold [&_h2]:text-white [&_li]:mt-2 [&_p]:leading-relaxed">
        <a href="/" className="text-sm text-gray-400 hover:text-white">← Back to Virvi</a>
        <h1 className="mt-6 text-3xl font-semibold tracking-tight text-white">Privacy and visitor data</h1>

        <h2>What is collected</h2>
        <p>
          When a scene uses Virvi, the scene sends anonymous usage events to Virvi while you're inside its parcels: when you arrive and leave, where
          you walk (sampled every few seconds), what you click or hover, videos you play, emotes, and camera mode.
        </p>

        <h2>How you're identified</h2>
        <ul className="list-disc pl-5">
          <li>
            By default Virvi stores a <strong>per-scene pseudonym</strong>: a keyed hash of your wallet (or guest id). It can't be linked across
            scenes and it isn't your wallet address.
          </li>
          <li>
            <strong>Display names and wallet addresses are only stored</strong> if the scene owner turns on wallet visibility. When they do, the
            scene shows a notice when you enter, and only data collected after that notice includes your wallet and name.
          </li>
          <li>
            <strong>IP addresses are never stored.</strong> Virvi uses them briefly to limit abuse and to look up your country, then discards them.
          </li>
        </ul>

        <h2>Retention</h2>
        <p>
          Raw events are kept for the scene owner's plan (7–365 days, unlimited on the top tier and self-hosted installs), 30 days for unclaimed
          scenes, and 7 days for local previews. Aggregated statistics (counts, heatmaps) are kept longer and contain no identities.
        </p>

        <h2>Deleting your data</h2>
        <p>
          Call <code className="rounded bg-gray-800 px-1.5 py-0.5 text-sm">POST /api/analytics/me/delete</code> with your session token. A
          dashboard control for this is coming. This removes your sessions, events and positions from every scene.
          To ask for your data to be deleted, or for help, email{' '}
          <a href="mailto:support@virvi.io" className="text-blue-400 hover:underline">support@virvi.io</a>.
        </p>

        <h2>Virvi Spaces on Quest</h2>
        <p>
          Virvi Spaces is the Meta Quest app that shows a Virvi space in your room. It talks to virvi.io. Pictures, videos and 3D models in a space load from wherever its owner hosts them, which may be outside virvi.io; those hosts see the headset's network address like any website would.
        </p>
        <ul className="list-disc pl-5">
          <li>
            <strong>Every visitor sends:</strong> the code of the ring you look at, to find its space; a request for the space's contents
            (the space feed); and anonymous visit events: when you arrive and leave, and where your head is (every few seconds), in the space's own
            coordinates rather than your room's. Each visit uses a fresh random id that is never stored, so visits can't be linked to you
            or to each other.
          </li>
          <li>
            <strong>A report, if you send one:</strong> a visitor can report a space from the menu. A report sends only the space, the reason you
            chose, the app name and the time. Nothing that identifies you is sent or stored with it.
          </li>
          <li>
            <strong>Builders also send:</strong> the edits they make to a space, the alignment of a ring, and the pairing of their headset (including the headset model)
            with a Virvi account. The headset proves who it is with a secret kept in its encrypted storage; the server stores only a hash of it.
          </li>
          <li>
            <strong>Never sent:</strong> camera images and room scans. The headset's cameras are used on the headset to find rings, and
            your room's walls and surfaces are used on the headset to hide virtual things behind real ones and to snap items to walls.
            Neither leaves the headset.
          </li>
        </ul>
        <p>
          Visit events follow the same retention as the rest of Virvi analytics, above. They carry no identity, so there is nothing to look up
          or delete for a single visitor. A builder can revoke a paired headset on virvi.io, which stops it from editing. To ask for your data to be
          deleted, or for help, email{' '}
          <a href="mailto:support@virvi.io" className="text-blue-400 hover:underline">support@virvi.io</a>.
        </p>

        <h2>Error reporting</h2>
        <p>
          When something goes wrong on virvi.io, the page and our server record the error so we can find and fix it. A report holds the error
          message, the page, the build of Virvi, your browser and operating system, your organization and scene ids, the time, and the last few
          things you did: pages you opened, the names of buttons and links you clicked, and the requests the page made (their address, result and
          timing). Before anything leaves your browser, tokens, email addresses, wallet addresses, secrets and the query part of web addresses are
          removed. It never includes what you type, passwords, wallet signatures, payment details, or what the page sent or received, other than
          the error message that came back.
        </p>
        <ul className="list-disc pl-5">
          <li>
            <strong>How you're counted:</strong> by a keyed hash of your account id, so we can see how many people an error reached without
            storing who. To count how many different places an error comes from, we also keep a hash of your network address made with a random
            key that changes every day. The key and those hashes are deleted after 2 days, after which they can't be traced back to an address or
            linked to another day. Your address itself is never stored.
          </li>
          <li>
            <strong>How long:</strong> error details, the account hashes and the breakdowns by page, browser and release are kept for 30 days.
            Hourly counts of each kind of error, with no identity, are kept for 400 days.
          </li>
          <li>
            <strong>If you send a report:</strong> when a page breaks it records the error without your account. If you press Report, you see
            exactly what will be sent before you press Submit. A report you send (what you wrote and that preview) is linked to your account if
            you're signed in, so we can follow up, and is kept for 400 days. Ask us at{' '}
            <a href="mailto:support@virvi.io" className="text-blue-400 hover:underline">support@virvi.io</a> to have it deleted sooner.
          </li>
          <li>
            <strong>Our issue tracker:</strong> when automatic bug filing is turned on, the details of errors that keep happening (the redacted
            messages, pages, steps and counts above, and what people wrote in their reports, with email addresses and similar details removed) are
            sent to Linear, the issue tracker we use, as bug reports. Your account, name and email are not.
          </li>
        </ul>

        <h2>Advertiser early access</h2>
        <p>
          When you ask for advertising early access on virvi.io, Virvi stores the email address, name, company or project, website and message you
          enter, and the time you sent the form. It's used only to contact you about advertising on Virvi. If you send the form again with the same
          email, the new answers replace the old ones (fields you leave blank keep what you sent before). Your IP address is used briefly to
          limit repeated submissions and is not stored. To be removed from the list, email{' '}
          <a href="mailto:sales@virvi.io" className="text-blue-400 hover:underline">sales@virvi.io</a>.
        </p>
      </article>
    </div>
  )
}
