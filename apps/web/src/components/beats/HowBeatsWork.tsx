// virvi.io/beat/how-it-works: how BEATs work, for attendees, hosts and reviewers (explorer listings link it as the
// token's whitepaper). Every claim here must match the code and the privacy page (apps/docs/.../privacy.md): say what
// is live today and what is planned. Styles: .beat-world in styles/globals.css.
import { beatDisplay } from '@/lib/beat-fonts'

const CONTRACT = '0x2ca6538745C5D611F14291631B16373B05F1F0d3'
const SAFE = '0xd119BDeA989C2816b412D8ECd7368f2C9C7F45b6'
const STANDARDS = 'https://github.com/virvi-xr/metaverse-standards/blob/main/analytics-and-data-collection.md'
const link = 'text-[var(--bw-cyan)] underline-offset-4 hover:underline'
const quiet = 'text-sm text-[var(--bw-dim)] hover:text-[var(--bw-chrome)]'

export function HowBeatsWork() {
  return (
    <div className={`beat-world ${beatDisplay.variable} min-h-screen overflow-x-hidden`}>
      <header className="mx-auto flex max-w-5xl items-center justify-between px-4 py-5 sm:px-6">
        <a href="/beat/" className="shrink-0"><img src="/virvi-logo-light.svg" alt="Virvi BEATs" className="h-7 w-auto" /></a>
        <a href="/beat/" className={quiet}>Check a wallet</a>
      </header>

      <main>
      <article className="mx-auto max-w-3xl px-4 pb-24 pt-10 sm:px-6 [&_p]:leading-relaxed [&_p]:text-[var(--bw-dim)] [&_li]:leading-relaxed [&_li]:text-[var(--bw-dim)] [&_strong]:text-[var(--bw-chrome)]">
        <h1 className="bw-display text-[clamp(2.2rem,7vw,4.2rem)] font-black leading-[0.95] tracking-tight">How BEATs work</h1>
        <p className="mt-6 text-lg">
          A BEAT (Basic Event Attendance Token) is an on-chain record that someone was at an event. Hosts create one for
          their event; the people who come receive it in their wallet, free, as proof they were there. It’s built to be
          open by default and private where it matters, and to survive a lost or stolen wallet.
        </p>

        <Section title="The token">
          <ul className="list-disc space-y-2 pl-5 marker:text-[var(--bw-cyan)]">
            <li>Every BEAT comes from one public ERC-1155 contract on Polygon,{' '}
              <a href={`https://polygonscan.com/address/${CONTRACT}`} className={`${link} break-all font-mono text-sm`}>{CONTRACT}</a>. Each event is its own token id.</li>
            <li>Claiming is free. Attendees never sign or pay anything: Virvi sends the token and pays the network fee, and the host pays a flat price per event.</li>
            <li>A BEAT can’t be sold or sent on by default, so it keeps proving who was there. A host can make theirs tradeable when creating it; that choice is fixed on chain and can never change.</li>
            <li>There’s no token sale, and a BEAT carries no promise of value. Its name, picture, place and time are its metadata.</li>
          </ul>
        </Section>

        <Section title="Given out where people gather">
          <ul className="space-y-3">
            <li><strong>In the metaverse, automatically.</strong> In a Virvi scene, an attendee chooses to track their attendance, stays as long as the host asks, and claims. Live today in Decentraland.</li>
            <li><strong>In AR experiences.</strong> The same tracking and claiming in Virvi’s AR spaces. Planned.</li>
            <li><strong>At in-person events.</strong> The host scans attendees’ wallet codes at the door, or shows a code that changes every 30 seconds for attendees to scan. Planned.</li>
          </ul>
          <p className="mt-4">Wherever it’s given out, it’s the same token on the same contract, with one supply and one claim per wallet.</p>
        </Section>

        <Section title="Open and on chain">
          <ul className="list-disc space-y-2 pl-5 marker:text-[var(--bw-cyan)]">
            <li>The contract’s source code is published and verified on Polygonscan and Sourcify, and Virvi’s code is public on{' '}
              <a href="https://github.com/virvi-xr/virvi" className={link}>GitHub</a>.</li>
            <li>No single key controls it. The admin is a Safe multisig, <span className="break-all font-mono text-sm">{SAFE}</span>, that needs two of three signers. Virvi’s server holds only a minter key, which can create, send and close BEATs, and nothing else: it can’t move anyone’s tokens or change the contract.</li>
            <li>The <a href="/transparency/" className={link}>transparency page</a> shows the live contract, the commit it was deployed from, and the signed build Virvi runs, so anyone can check it against the code.</li>
            <li><strong>More chains, planned.</strong> BEATs live on Polygon today. Solana and other chains are planned, so attendees can choose where their BEAT is minted. Each attendee will still get one BEAT per event, on the chain they choose.</li>
          </ul>
        </Section>

        <Section title="Private by design">
          <p>
            BEATs follow the{' '}
            <a href={STANDARDS} className={link}>Standards for Ethical Analytics and Data Collection in the Metaverse</a>,
            the open privacy whitepaper Virvi published in 2023: informed consent, collecting only what’s needed, and the
            user in control. In practice:
          </p>
          <ul className="mt-4 list-disc space-y-2 pl-5 marker:text-[var(--bw-cyan)]">
            <li><strong>Nothing until you opt in.</strong> Attendance is tracked only after the attendee agrees, and the consent says exactly what’s stored and what becomes public.</li>
            <li><strong>Only what’s needed.</strong> A wallet address, a display name and how long they stayed. Per-network limits use a scrambled, keyed code, never an internet address, and aren’t linked to the claim.</li>
            <li><strong>On chain, only the essentials.</strong> The blockchain records the wallet, the BEAT and when it was sent. Names and time spent stay off chain.</li>
            <li><strong>In the attendee’s control.</strong> Stopping before claiming deletes what was stored. Deleting their data later removes their name, time and account link from BEATs already sent; unclaimed data is deleted 30 days after the event.</li>
          </ul>
          <p className="mt-4">The full details are on Virvi’s <a href="/privacy/" className={link}>privacy page</a>.</p>
        </Section>

        <Section title="If a wallet is compromised">
          <p>
            A BEAT that can’t be transferred would be lost with a stolen wallet. Instead, the contract has a reissue built in:
          </p>
          <ol className="mt-4 list-decimal space-y-2 pl-5 marker:text-[var(--bw-cyan)]">
            <li>The owner asks for their BEATs to be moved to a new wallet from their Virvi settings.</li>
            <li>Virvi reviews the request. On approval, the old wallet is blocked from the account and from BEATs.</li>
            <li>The Safe’s signers approve the move, and the contract sends a fresh copy to the new wallet.</li>
            <li>The contract records for good that the old copy was replaced. The old copy can never move again, and collection pages show only the new one.</li>
          </ol>
          <p className="mt-4">The record stays open, the attendee keeps their proof, and whoever took the old wallet gets nothing they can use.</p>
        </Section>

        <p className="mt-16 flex flex-wrap gap-x-6 gap-y-2 text-sm">
          <a href="/beat/" className={link}>Check a wallet’s BEATs</a>
          <a href="/about/" className={link}>About Virvi</a>
          <a href="mailto:support@virvi.io" className={link}>support@virvi.io</a>
        </p>
      </article>
      </main>
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-14">
      <h2 className="bw-display mb-4 text-2xl font-bold text-[var(--bw-chrome)]">{title}</h2>
      {children}
    </section>
  )
}
