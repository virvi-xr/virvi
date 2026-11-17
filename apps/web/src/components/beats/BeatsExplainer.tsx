'use client'
// The public BEATs page (/beats for signed-out visitors): what a BEAT is, how to earn one and how hosts make one.
// Each token's external_url and the explorer listings link here, so it must make sense to someone who has never used
// Virvi. Keep it in step with how BEATs work (apps/server/src/beats) and with the transparency page.
import { signinPath } from '@/lib/landing-route'

const link = 'text-blue-400 hover:underline'

export function BeatsExplainer() {
  return (
    <div className="min-h-screen bg-gray-950 px-4 py-12 sm:px-6">
      <article className="mx-auto max-w-2xl text-gray-300 [&_h2]:mb-3 [&_h2]:mt-10 [&_h2]:text-xl [&_h2]:font-semibold [&_h2]:text-white [&_li]:mt-2 [&_p]:leading-relaxed">
        <a href="/" className="text-sm text-gray-400 hover:text-white">← Back to Virvi</a>
        <h1 className="mt-6 text-3xl font-semibold tracking-tight text-white">BEATs</h1>
        <p className="mt-2 text-lg text-gray-400">Basic Event Attendance Tokens</p>
        <p className="mt-4">
          A BEAT is a token that shows you were at an event in a virtual world, such as Decentraland. The event’s host makes one
          with Virvi, and the people who come can claim it to their wallet as a keepsake of being there.
        </p>

        <h2>Earning a BEAT</h2>
        <ol className="list-decimal pl-5">
          <li>Go to the event in Decentraland, signed in with your wallet. A BEAT card appears in the scene while the BEAT is open.</li>
          <li>Choose <strong>Track my attendance</strong> and stay for the time the card shows.</li>
          <li>Choose <strong>Claim your BEAT</strong>. It arrives in the same wallet a few minutes later.</li>
        </ol>
        <p className="mt-3">
          Claiming is free: you never sign or pay anything, and Virvi pays the network fee. Each wallet can claim a BEAT once,
          and some BEATs have a limited number. Guests without a wallet can’t claim one.
        </p>

        <h2>Where it goes</h2>
        <p>
          BEATs are ERC-1155 tokens on Polygon, the network Decentraland’s wearables use. You can see yours in your wallet, or on
          Polygonscan by searching your wallet’s address. Each one records the event’s name, where it happened and when.
        </p>
        <p className="mt-3">
          Most BEATs can’t be sold or sent to anyone else: they stay in the wallet that earned them, so they keep proving who was
          there. A host can choose to make theirs tradeable when creating it, and that choice can’t be changed afterwards.
        </p>
        <p className="mt-3">
          Lost access to your wallet, or had it stolen? Sign in to Virvi and ask for your BEATs to be moved to a new wallet
          from your settings. Virvi checks each request before moving anything.
        </p>

        <h2>Making a BEAT for your event</h2>
        <p>
          Hosts create a BEAT on Virvi: a name, an image, the event’s time, the scenes it’s in, and how long visitors need to
          stay. The price for each event is shown before you pay, and visitors never pay anything.
        </p>
        <p className="mt-4">
          <a href={signinPath('/beats/new')} className="clip-corner inline-flex items-center bg-accent px-4 py-2.5 text-sm font-semibold text-accent-ink transition-colors hover:bg-accent-hover">
            Sign in to create a BEAT
          </a>
        </p>

        <h2>Check the contract</h2>
        <p>
          Every BEAT comes from one public contract on each network. Its code is published, and it’s controlled by a
          multisig wallet that needs two of three keys. The <a href="/transparency/" className={link}>transparency page</a> lists
          the contract, with links to its code and to Polygonscan.
        </p>

        <h2>Questions</h2>
        <p>
          Email <a href="mailto:support@virvi.io" className={link}>support@virvi.io</a>. The <a href="/privacy/" className={link}>privacy page</a> explains
          what Virvi keeps when you track your attendance.
        </p>
      </article>
    </div>
  )
}
