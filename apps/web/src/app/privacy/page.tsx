import type { Metadata } from 'next'
import { beatClaimsPerNetworkText, beatConsentText } from '@virvixr/shared'

export const metadata: Metadata = {
  title: 'Privacy',
  description: 'What Virvi collects in Decentraland scenes, for BEATs, in error reports and from the advertiser early-access form, and how to have it removed.',
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
          dashboard control for this is coming. This removes your sessions, events and positions from every scene, your raffle entries, and your
          BEAT data (see BEATs below for tokens already sent).
          To ask for your data to be deleted, or for help, email{' '}
          <a href="mailto:support@virvi.io" className="text-blue-400 hover:underline">support@virvi.io</a>.
        </p>

        <h2>Raffles</h2>
        <p>
          A scene owner can run a raffle. Nothing about you is entered unless you choose to enter and agree to the raffle terms, and only while
          signed in with a verified wallet inside that scene.
        </p>
        <ul className="list-disc pl-5">
          <li>
            <strong>What's shared, and with whom:</strong> your display name (or a shortened wallet address if you have no name) is shown on the
            raffle wheel to everyone in the scene. Your name and wallet address are shared with the scene's host so they can deliver your prize.
            Other visitors never see full wallet addresses (a visitor with no name is shown as a shortened wallet like 0x1234…abcd).
          </li>
          <li>
            <strong>Check-ins:</strong> while you are entered, the scene sends a check-in every 30 seconds so the host can tell who is present.
            Check-ins stop when you withdraw or the raffle ends, and only your total time present and when you were last seen are kept.
          </li>
          <li>
            <strong>Withdrawing:</strong> you can withdraw while the raffle is open or drawn, which deletes your entry. Past draw records keep only an anonymous
            entry id, so they still check out; a withdrawn winner shows there as "Removed entrant" and is left out of later draws.
          </li>
          <li>
            <strong>Retention:</strong> 30 days after a raffle ends, its entries (with your name and wallet address) are deleted. Its draw records keep only
            anonymous entry ids.
          </li>
          <li>
            <strong>Deleting your data:</strong> deleting your data (above) also deletes your raffle entries.
          </li>
        </ul>

        <h2>BEATs</h2>
        <p>
          A BEAT is a free token that shows you were at an event. Nothing about you is stored unless you choose to track your attendance and
          agree to this, while signed in with a verified wallet inside the event's scene:
        </p>
        <blockquote className="my-3 border-l-2 border-gray-700 pl-4 text-gray-400">{beatConsentText('{name}')}</blockquote>
        <ul className="list-disc pl-5">
          <li>
            <strong>What's stored:</strong> your wallet address, your display name, and how long you were present at the event (from a check-in every 30 seconds while you're in the scene; time only counts while the scene is connected to Virvi's live room). To check that your wallet has a Decentraland profile, Virvi asks Decentraland's public profile server about your wallet address when you track and when you claim; only whether a profile exists is kept, for up to a day. To allow only {beatClaimsPerNetworkText()}, Virvi keeps a count per BEAT under a scrambled code (a keyed hash) of your network, never your internet address and not linked to your claim; the counts are deleted once the BEAT's claims are over.
          </li>
          <li>
            <strong>Who sees it:</strong> the event's hosts (the BEAT's creator, and anyone who can run events in its scenes) see your display name, wallet and whether you claimed, even when the scene's wallet visibility for analytics is off, because you agreed to it for the BEAT. Virvi staff can also see them, to fix problems.
          </li>
          <li>
            <strong>On the blockchain:</strong> once your BEAT is sent, the token, your wallet address and when it was sent are recorded on Polygon, a public blockchain. Anyone can see them, and they can't be deleted, by you or by Virvi. The BEAT's name, picture and place are served by Virvi.
          </li>
          <li>
            <strong>Stopping:</strong> you can stop tracking at any time before you claim, which deletes what was stored. If the host cancels the BEAT, what tracking stored is deleted too.
          </li>
          <li>
            <strong>Retention:</strong> if you opted in but never claimed, your data is deleted 30 days after the BEAT ends. The list of wallets in each transaction Virvi sends is deleted 30 days after it settles (or 30 days after it was made, if it never settles); the transaction's id stays. If you claimed, your wallet address and display name are kept with your BEAT until you delete your data (above). If a host removed your claim and you then delete your data, Virvi keeps only that claim's wallet address, so it can't claim that BEAT again, until 30 days after the BEAT ends; hosts don't see it.
          </li>
          <li>
            <strong>Deleting your data:</strong> deleting your data (above), or your account, deletes your BEAT data that hasn't been sent, though your wallet address can stay in Virvi's transaction records for up to 30 days. For a BEAT already sent, the token stays in your wallet and on the blockchain, but Virvi removes your display name, how long you were there and the link to your account. A BEAT being sent at that moment is hidden from the host at once; once the send settles, it is deleted if the send failed, or unlinked like this if it arrived.
          </li>
          <li>
            <strong>A lost or stolen wallet:</strong> you can ask Virvi to move your BEATs to a new wallet (Settings, Move my BEATs to a new wallet). Virvi stores both wallets, your reason, your account, and how your session signed in when you asked or cancelled; reviewers see these with your account's name and email, and you see the reviewer's note. Virvi also records when and how each wallet was linked to your account, and unlinks and blocks. If approved, the old wallet is blocked from your account and from BEATs (it can't sign in to your account, its sessions there are refused, and it can never collect a BEAT again), your API keys and paired devices are removed, and a reviewer may also remove and block other wallets linked while signed in with the old wallet. The move is recorded on Polygon for good: anyone can see that the old wallet was replaced by the new one for that BEAT, and the Safe's signers see both wallets in the transaction file. The old copy stays in the old wallet and can never move. Hosts see your new wallet marked as reissued. Requests are deleted 30 days after they close, or when you delete your data; if you delete your data while a move is under way, Virvi keeps only the two wallets, the BEAT numbers and the state, with no link to you, until it finishes or is withdrawn (and for 7 days after a withdrawal, in case the transaction goes through anyway). A blocked wallet stays blocked after you delete your data or your account: Virvi keeps only its address and why it was blocked.
          </li>
        </ul>

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
            <strong>If you send a report:</strong> when a page breaks it records the error without your account. If something you were doing
            fails and we need more detail, we may ask you about it, at most once a day; you can turn that off in Settings (or from the
            message itself). Whether you report from there, a crash page or Report a bug in the menu, you see exactly what will be sent before
            you press Submit, and nothing is sent before that. A report you send (what you wrote, that preview and a screenshot if you add one)
            is linked to your account if you're signed in, so we can follow up. Reports are kept for 400 days, and screenshots for 30
            days. Ask us at{' '}
            <a href="mailto:support@virvi.io" className="text-blue-400 hover:underline">support@virvi.io</a> to have one deleted sooner.
          </li>
          <li>
            <strong>Asking only when it helps:</strong> to ask you at most once a day, and to say &ldquo;we know about this&rdquo; only once
            for each problem, we keep when we last asked you and which problems we told you about by the account hash above (never your
            account itself), for 30 days, and on your account only whether you turned asking off; if you're not signed in, this browser
            keeps it.
          </li>
          <li>
            <strong>Our issue tracker:</strong> when automatic bug filing is turned on, the details of errors that keep happening (the redacted
            messages, pages, steps and counts above) are sent to Linear, the issue tracker we use, as bug reports, without your account. A report
            you choose to send is added to that bug with what you wrote (with email addresses and similar details removed) and, if you're
            signed in, your account id, never your name or email. Screenshots stay with us and are not sent to Linear. Those Linear comments
            aren't removed by the 400-day limit or when you delete your account; ask us at support@virvi.io and we'll remove them.
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
