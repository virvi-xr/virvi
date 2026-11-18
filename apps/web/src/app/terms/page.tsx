import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Terms of Service',
  description: 'The rules for using Virvi, its content policy, and who owns what you make in the Design Studio.',
}

const link = 'text-blue-400 hover:underline'

// Keep in step with apps/docs/src/content/docs/terms.md (both are generated from the same text)
export default function TermsPage() {
  return (
    <div className="min-h-screen bg-gray-950 px-4 py-12 sm:px-6">
      <article className="mx-auto max-w-2xl text-gray-300 [&_h2]:mb-3 [&_h2]:mt-10 [&_h2]:text-xl [&_h2]:font-semibold [&_h2]:text-white [&_h3]:mb-2 [&_h3]:mt-6 [&_h3]:font-semibold [&_h3]:text-white [&_li]:mt-2 [&_ol_ul]:mt-1 [&_p]:mt-3 [&_p]:leading-relaxed [&_ul_ul]:mt-1">
        <a href="/" className="text-sm text-gray-400 hover:text-white">← Back to Virvi</a>
        <h1 className="mt-6 text-3xl font-semibold tracking-tight text-white">Terms of Service</h1>
        <p>Last updated: [date]</p>
        <p>These Terms are an agreement between you and Livication LLC, which runs Virvi (&quot;Virvi&quot;, &quot;we&quot;, &quot;us&quot;). They cover the Virvi website, dashboard, Design Studio, Virvi worlds and Cities, events, Drops, AR, the in-world HUD, our APIs and SDKs, and anything else we offer under the Virvi name (together, the &quot;Services&quot;). By using the Services you accept these Terms and our <a href="/privacy/" className={link}>Privacy Policy</a>. If you don&apos;t accept them, don&apos;t use the Services.</p>
        <h2>1. Who can use Virvi</h2>
        <ul className="list-disc pl-5"><li>You must be at least 18 years old, or the age of majority where you live if that is higher.</li><li>If you use Virvi for a company or other organisation, you confirm that you can accept these Terms on its behalf.</li><li>You are responsible for your account, your wallet, and everything done with them. Keep your keys and sign-in details safe. We can&apos;t recover a wallet or reverse a blockchain transaction.</li></ul>
        <h2>2. Content policy</h2>
        <p>These rules apply to everything you upload, post, create, display, stream or send through the Services: images, models, sounds, video, text, scenes, wearables, emotes, Drops, NFTs, and anything you ask the Design Studio to make (&quot;Your Content&quot;).</p>
        <h3>2.1 Not allowed anywhere on Virvi</h3>
        <ol className="list-decimal pl-5"><li><strong>Illegal content:</strong> piracy, criminal activity, terrorism, obscenity, child sexual abuse material (we report it to the authorities), illegal drug use, and gambling except as allowed in 2.3.</li><li><strong>Infringement:</strong> content that infringes someone else&apos;s copyright, trademark or other intellectual property.</li><li><strong>Hate and cruelty:</strong> content that harms, harasses, or promotes or condones violence against animals, people, or groups based on race or ethnic origin, religion, nationality, disability, gender, age, veteran status, sexual orientation or gender identity, and content mainly meant to stir up hatred on those grounds.</li><li><strong>Falsehoods and privacy:</strong> content that is defamatory, false or misleading, or that invades someone&apos;s privacy.</li><li><strong>Personal data:</strong> content that breaks our Privacy Policy or data-protection law, including posting someone&apos;s personal details (such as full name with other identifiers, address, phone number, email, passwords, card numbers or medical information).</li><li><strong>Evasion:</strong> content mainly meant to get around these rules.</li></ol>
        <h3>2.2 Restricted content (18+ only, with a warning)</h3>
        <p>Intensely violent or graphic content, gambling and sexually explicit content may only be made available to people aged 18 or over, with a clear warning before anyone sees it. The Design Studio never makes sexually explicit content, even on request.</p>
        <h3>2.3 Gambling</h3>
        <p>Gambling content is allowed only if you hold any licence it needs where you live, follow local law, block access from places where online gambling is banned (including the United States, South Korea and China), and release Virvi from liability for it in your own terms.</p>
        <h3>2.4 Your promises about Your Content</h3>
        <p>You confirm that you own Your Content or have the rights to use it as you do on Virvi, and that it doesn&apos;t break these Terms or anyone else&apos;s rights. If Your Content shows a minor, you are their parent or guardian or have their consent.</p>
        <h3>2.5 Other platforms</h3>
        <p>When you deploy to Decentraland, Hyperfy or any other platform, its own terms and content policy also apply.</p>
        <h3>2.6 Enforcement</h3>
        <p>We may remove or block content, limit features, or suspend or close accounts that break these rules, and we may report illegal content to the authorities. To report content, email <a href="mailto:support@virvi.io" className={link}>support@virvi.io</a>. To appeal a decision about your content or account, email the same address within 30 days; a person will review it. Copyright notices go to [DMCA agent&apos;s name and address, once registered with the US Copyright Office].</p>
        <h2>3. The Design Studio: who owns what</h2>
        <h3>3.1 Definitions</h3>
        <ul className="list-disc pl-5"><li><strong>Your Inputs:</strong> your prompts and the files you upload (for example images, 3D models and sounds).</li><li><strong>Output:</strong> what the Design Studio&apos;s agent makes for you: models, textures, animations, sounds, previews, renders and packages, with every revision of each piece.</li><li><strong>Paid For:</strong> a piece&apos;s revision is Paid For when you finalize it and the payment completes (by card, credit, MANA, or a free finalize or waiver we give you).</li></ul>
        <h3>3.2 Your Inputs stay yours</h3>
        <p>You keep all rights in Your Inputs. You give Virvi a licence to store, copy, process and change them only to run the Design Studio for you and the people you share the design with.</p>
        <h3>3.3 Output is Virvi&apos;s until it&apos;s Paid For</h3>
        <ul className="list-disc pl-5"><li><strong>Until a revision is Paid For, its Output is the property of Virvi.</strong></li><li>You may view it, render it, try it on and share previews of it inside Virvi.</li><li>You may not download, export, extract, copy, deploy, sell or use it outside Virvi, for example by capturing it from a render or preview.</li><li>Virvi won&apos;t sell or give a design you haven&apos;t paid for to anyone else, or publish it as its own work. It stays in your account for you to finish or delete.</li></ul>
        <h3>3.4 Once it&apos;s Paid For, it&apos;s yours</h3>
        <ul className="list-disc pl-5"><li><strong>When a revision is Paid For, Virvi transfers to you all the rights it has in that revision&apos;s Output.</strong> This covers its finalized package, every file in it, and the renders made for it.</li><li>You may edit, remix, rework, combine, publish, deploy and sell it, and as many items made from it as you like, on any platform, with nothing more to pay Virvi.</li><li>Virvi may keep a copy to run the Services, such as letting you download the package again or fixing a failed package.</li><li>Virvi may show renders of Paid For designs in its own showcases and promotion. To opt out, email <a href="mailto:support@virvi.io" className={link}>support@virvi.io</a> and we&apos;ll leave that design out of anything new. Designs that aren&apos;t Paid For are never shown publicly without your permission.</li><li>A wearable&apos;s price covers both body shapes.</li></ul>
        <h3>3.5 Revisions</h3>
        <ul className="list-disc pl-5"><li>Each revision is paid for separately (revisions after a piece&apos;s first finalize are half price).</li><li>Rights pass for the revisions you pay for. Later revisions you don&apos;t pay for remain Virvi&apos;s under 3.3.</li></ul>
        <h3>3.6 Shared designs</h3>
        <ul className="list-disc pl-5"><li>When someone on a shared design pays for a revision, the rights in that revision go to the person who paid.</li><li>Everyone else on the design when it was paid for gets a permanent, free licence to download, use and edit that package and to wear or show it. Only the payer may sell it or items made from it, unless the payer agrees.</li></ul>
        <h3>3.7 Mistake refunds</h3>
        <p>If we refund a revision because it fixed the agent&apos;s mistake, the rights you already received stay with you.</p>
        <h3>3.8 About AI-made work</h3>
        <ul className="list-disc pl-5"><li>The Output is made with AI. In some countries, including the United States, work made by AI without enough human authorship may not be protected by copyright.</li><li>Virvi transfers whatever rights it has. It doesn&apos;t promise that the Output can be registered or enforced against others, or that it is unique; someone else&apos;s prompts may produce similar results.</li><li>You are responsible for making sure your prompts and uploads don&apos;t ask for someone else&apos;s protected work, characters or trademarks.</li></ul>
        <h2>4. Payments, credit and prompts</h2>
        <ul className="list-disc pl-5"><li>Prices are shown before you pay.</li><li>Prompt top-ups and credit don&apos;t expire and can&apos;t be cashed out or refunded once bought, except where the law requires it.</li><li>MANA payments are final once they settle on-chain, except where these Terms or the Studio&apos;s mistake refunds say otherwise.</li></ul>
        <h2>5. Drops, BEATs, NFTs and other digital items</h2>
        <p>Digital collectibles and rewards are given or sold as they are. Their value, if any, can change or disappear. Blockchain transactions are permanent and are your responsibility.</p>
        <h2>6. Feedback</h2>
        <p>If you send us ideas or suggestions, we may use them without paying you or owing you anything.</p>
        <h2>7. Our rights</h2>
        <ul className="list-disc pl-5"><li>The Virvi name, logo, mascot, website, software and Services belong to Virvi and its licensors.</li><li>Except for Output you have Paid For, nothing in these Terms gives you rights in them.</li><li>Self-hosted copies of Virvi software follow the licence that comes with that software.</li></ul>
        <h2>8. Ending your account</h2>
        <ul className="list-disc pl-5"><li>You can stop using Virvi at any time.</li><li>We may suspend or close accounts that break these Terms.</li><li>Output you have Paid For stays yours after your account closes; download your packages first.</li><li>Sections 3.4, 3.8 and 6 to 11 continue after your account closes.</li></ul>
        <h2>9. Disclaimers</h2>
        <p>The Services are provided &quot;as is&quot; and &quot;as available&quot;, without warranties of any kind, to the extent the law allows. We don&apos;t promise that the Services will be uninterrupted or error-free, or that Output will suit a particular purpose or pass any platform&apos;s review (such as Decentraland curation).</p>
        <h2>10. Limitation of liability</h2>
        <p>To the extent the law allows, Virvi is not liable for indirect or consequential losses. Its total liability to you is limited to the greater of what you paid Virvi in the 12 months before the claim and $100.</p>
        <h2>11. Disputes and governing law</h2>
        <p>These Terms are governed by the laws of [State], USA. Disputes go to the courts of [County, State], unless your lawyer adds arbitration here. Nothing here takes away rights that consumer law where you live gives you.</p>
        <h2>12. Changes</h2>
        <p>We may update these Terms. We&apos;ll post the new version with its date and tell you about important changes beforehand. If you keep using Virvi after a change takes effect, you accept the new Terms.</p>
        <h2>13. Contact</h2>
        <p><a href="mailto:support@virvi.io" className={link}>support@virvi.io</a> · [mailing address]</p>
      </article>
    </div>
  )
}
