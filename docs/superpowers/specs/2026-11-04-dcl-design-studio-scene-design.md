# Design Studio in Decentraland: Virvi's studio scene, wallet checkout and MANA

**Status:** draft for the owner's approval. Marks: **(owner)** the owner decided it; **(call)** the author's call, open
to change.

## Intent

The Design Studio (`docs/superpowers/specs/2026-10-24-design-studio-design.md`) lives on the Virvi website. This design
brings it into Decentraland, where its customers already are **(owner)**.

A visitor walks into a public Genesis City parcel and meets **Virvi**, the brand's mascot: a small, glowing, curious
companion. They tell Virvi what they want in a chat box. Virvi goes off to design it, using the same agents, workers and
rules as the website. The visitor can leave and come back, or wait it out. When they return, Virvi shows them what it
made on a hologram. They can ask for changes or finalize. Finalizing sends them to a Virvi checkout page, where they pay
by card or in MANA, pegged to the USD price, and download the files **(owner)**.

Their Decentraland wallet is their Virvi account, so they can come back on the website or in-world and find everything
there **(owner)**. Designs they choose to show go up on a "Made with Virvi Design Studio" wall of fame in the scene
**(owner)**.

The scene is another door into the existing studio, not a second studio. Prompts, quotas, prices, renders, the scope
guard, clipping fixes, finalizing, refunds and packages all behave as they do on the website.

## Goals

- Anyone with a Decentraland wallet can go from an idea to a paid, downloadable design without leaving for the website
  until checkout **(owner)**.
- The wait for a design is part of the fun: Virvi visibly works on it, and the visitor can leave and return to a reveal
  **(owner)**.
- Visitors can pay with MANA as easily as with a card **(owner)**.
- Everything made in the scene is in the visitor's Virvi account on the website, and the other way round **(owner)**.
- Proud creators get a public showcase in the scene **(owner)**.

## Non-goals

- A real 3D model of the design in the scene. Decentraland can't load a model from a URL
  (`packages/adapter-dcl/src/DclAdapter.ts`, `resolveModelSrc`), so showing one would mean redeploying the scene per
  design, publishing unpaid files to Decentraland's public content servers. The scene uses the same server renders as
  the website **(owner)**.
- Walkthroughs of buildings in the scene. The scene links to the design's page on the website for those **(owner)**.
- Uploading reference images from the scene: there's no file picker in Decentraland. The chat is text-only. Uploads
  stay on the website **(call)**.
- MANA on Ethereum mainnet: Polygon only **(call)**, because mainnet fees can be several dollars on a $10–20 line.
- Automatic MANA refunds from a server-held wallet **(owner)**.
- Paying in-world: Decentraland can open a link but has no checkout. Payment happens on Virvi's site **(owner)**.

## Anti-goals

- Any route by which a GLB, `.blend` or other model file reaches a visitor before payment. This is the existing
  studio's rule and still holds **(owner)**.
- A server that holds a private key with funds **(owner, as "credit instead"; reasoning in Paying)**.
- One visitor's conversation or unfinished design being visible to anyone else in the scene **(call)**.
- A second set of studio rules for Decentraland: prices, quotas and refund rules that drift from the website
  **(call)**.

## The three parts, and the order

This is three projects. Each gets its own implementation plan **(call)**:

1. **Wallet accounts and checkout (website and server).** A visitor's wallet becomes their Virvi account, the checkout
   page takes card and MANA side by side, MANA is verified on Polygon, MANA refunds become Virvi credit, and the owner
   has an admin page for sending MANA back. This is useful without the scene, and testable on its own.
2. **The scene.** The parcel and its building, the chat panel, the visitor's own Virvi and its moods, the hologram and
   its views, the wall of fame, and the server routes the scene talks to. It is built with a stand-in Virvi (a simple
   placeholder model with the same animation names).
3. **The Virvi character.** Made by the author in Blender from the owner's character sheet **(owner)**. It replaces the
   stand-in when ready.

Order: 1, then 2, then 3, with 3 able to start whenever there's capacity **(call, owner didn't object)**.

---

## Part 1: wallet accounts and checkout

### Accounts **(owner: a Virvi account tied to their wallet)**

- The scene authenticates through `POST /api/auth/platform` as Virvi's Decentraland scenes do today. A verified,
  non-guest wallet resolves to its account with `resolveVerifiedWalletUser`, which creates one when there's none.
- The studio routes today accept account tokens only, and a scene pass is refused off its scene's routes. The studio
  scene needs to act as the visitor's account on the **studio routes only**, and never on scene-editing routes
  **(call)**. How (a new pass kind, or a scope on the existing pass) is left to the builder. It must be impossible to
  turn this into a general account token.
- New accounts start on the Free plan, like website sign-ups: 3 prompts a day, one open design **(call)**.
- Guests (no wallet) can't design. Virvi greets them and asks them to sign in with a wallet **(call)**.
- On the website, the visitor signs in with the same wallet (the existing SIWE sign-in in `routes/wallet-auth.ts`) and
  lands on the same account.
- **An existing email account that later links the wallet used in-world gets its studio data** **(call)**. Today
  `linkVerifiedWallet` → `absorbVisitor` (`auth/wallet-users.ts`) moves sign-in methods, grants and scene roles and
  never looks at studio tables. It must also move designs, conversations, revisions, payments, entitlements, packages,
  prompt usage, top-ups, gift-code credits, the credit balance (summed, with a ledger entry each) and wall entries,
  in one transaction. After a merge the account may have more open designs than its plan allows. They stay open, and
  only new designs are limited.

### The checkout page **(owner: card and MANA side by side)**

The scene's Finalize (and top-up) opens a Virvi web page with Decentraland's open-link prompt. The page:

1. **Signs them in with a one-time link** **(owner)**. Many Decentraland players use email or Google sign-in, and their
   wallet exists only inside Decentraland, so the page can't ask them to prove it with a browser wallet. Instead:
   - When they click Finalize or top up, the scene asks the server for a link with a signed request, which proves
     their wallet.
   - The server makes a random, single-use token that expires after 10 minutes **(call)**. It stores only the token's
     hash, and the token is never logged.
   - Opening the link signs that browser into their account and takes them to the design's checkout. A used or
     expired link shows "Go back to Virvi in Decentraland for a new link", with the website's normal sign-in as the
     other way in.
   - Holding the link is enough to get in during those 10 minutes, and the owner accepted that trade **(owner)**.
2. **MANA needs a browser wallet** **(call)**. Pay with MANA asks a browser wallet (MetaMask or similar) to send it.
   The transfer may come from a different wallet than the account's, because email and Google players' MANA may live
   elsewhere. It settles the quote by the quote's unique amount, recipient and time window, not by sender. Players
   with no browser wallet see that card is the way to pay.
3. **Shows the same quote** the website shows (`GET /designs/:id/finalize`), with any Virvi credit applied first.
4. **Offers two buttons:** Pay by card (the existing Stripe Checkout, unchanged) and Pay with MANA.
5. **After payment,** it shows the download, as the website's studio page does. It also tells them that the scene now
   shows the design as finalized.

The same page works for website users who want to pay in MANA **(call)**. It's a payment option, not a
Decentraland-only feature.

### MANA payments

- **Network and token:** MANA on Polygon PoS (the bridged MANA contract) **(call)**. The page asks the wallet to switch
  to Polygon if needed.
- **Recipient:** `0x01d871870CbBddE934526E17637c0cfEf0b3b38B` **(owner)**, held as a setting
  (`STUDIO_MANA_RECIPIENT`), checksum-validated at boot. If it's unset, MANA is hidden.
- **Pegging:** the server converts the USD total to MANA at the live MANA/USD rate and stores a **quote**: the design
  lines, USD total, MANA amount (in wei), rate, rate source and expiry **(call: 10 minutes)**. Price sources are left
  to the builder, with two requirements: the server never trusts a rate from the browser, and it refuses to quote when
  it can't get a fresh rate.
- **Unique amounts** **(call)**. Each quote's MANA amount gets a few random low-order wei added, so no two open quotes
  ask for the same amount. A transfer can then be matched to its quote without knowing the sender.
- **Paying:** a browser wallet sends a plain ERC-20 `transfer` of exactly the quoted amount to the recipient. The page
  then reports the transaction hash to the server, along with the quote it's for. The sending wallet may be any wallet
  (see the checkout page, step 2).
- **Verifying:** the server checks the transaction itself on Polygon. It must:
  - have succeeded;
  - be on the MANA contract;
  - contain a `Transfer` to the recipient of exactly that quote's amount;
  - have been mined before the quote expired, plus a grace period;
  - have enough confirmations **(call: number left to the builder)**.

  Each transaction hash can settle exactly one quote, ever. A background check watches the recipient's incoming MANA
  transfers and settles open quotes by their exact amount, for pages closed before reporting.
- **Settled:** it applies exactly as a paid Stripe Checkout does today: entitlements, the finalize job and the package.
  The webhook and MANA paths share one "apply a paid order" function, so they can't drift.
- **Overpaying** is kept, with no credit. **Underpaying, the wrong token or a late transaction** doesn't settle. The
  page explains this, and the owner sees it on the admin page, where they can settle it by hand or send it back
  **(call)**.

### Virvi credit and refunds **(owner: credit instead, MANA back on request)**

- **Credit** is a USD balance per account, held in cents **(call)**, with a ledger of every change.
- **A mistake refund on a MANA-paid line** adds that line's USD price as credit at once, with the same rules and
  instant-refund limits as card refunds (`STUDIO_INSTANT_REPORTS`, the owner's Approve or Decline after that).
- **Credit is spent automatically,** first, on the next finalize or top-up, whether by card or MANA. A fully covered
  order is granted at once, as waived lines are today.
- **"Send it back as MANA instead".** The refund screen offers this. It moves that credit into a request on the
  owner's admin page. There the owner clicks Send, and their own wallet (MetaMask or similar) is asked to approve a
  MANA transfer of the USD value at the current rate. The page records the transaction hash, and the request is done.
  The server never holds a key **(owner)**. If the owner declines, the credit goes back to the account.
- **Card-paid refunds** are unchanged: Stripe, in full, at once.
- **Mixed orders** **(call)**. The order of spending is:
  1. the existing gift-code finalize credits (`studioFinalizeCredits`), which cover whole lines;
  2. then the USD credit balance;
  3. then card or MANA for the rest.

  Every paid line records how much of it each source paid. A mistake refund on a line goes back the way that line
  was paid: the card part through Stripe, the MANA part as credit (with the MANA-back option), the credit part as
  credit, and a gift-credit line as a restored gift credit.

---

## Part 2: the scene

### Place **(owner: a 1×1 Genesis City parcel, location unknown)**

- One parcel: 16 × 16 m, about 20 m tall. The soft budget is about 10,000 triangles, 200 entities, 20 materials and 10
  textures. The hard limit is 15 MB.
- **Its own SDK7 project** **(call)**: `apps/dcl-studio-scene`, using the `@virvixr/*` packages for the client, auth
  and UI. It isn't a Virvi-managed scene in the hosted `dcl-runtime`. It is a fixed, owner-run scene, not one
  customers edit.
- **Deploying** **(call)**: whoever holds the land, or an operator they authorize, deploys it by hand with
  Decentraland's CLI (`sdk-commands deploy`). The plan documents these steps; it doesn't build a Genesis City deploy
  path in the dashboard. The parcel is held in `scene.json` and a server setting, since the location isn't known yet.
- **Sign-in from the scene**: `/api/auth/platform` matches a signed request to its scene by parcel
  (`bindSceneRequest`). The studio scene's parcel is registered as the studio scene, so a request from it gets the
  studio-scoped token (Part 1, Accounts), and no other scene's request ever does.
- **Layout (call, shown to the owner as a mockup before building):** a compact open studio. Virvi waits near the
  entrance at the front. The reveal pedestal and hologram are in the middle. The wall of fame runs along the back wall.

### Each visitor has their own Virvi **(call)**

The scene's code runs on each visitor's own computer, so each visitor's scene draws only their own Virvi, and the
budget is for one Virvi. Others' conversations and designs never appear on someone else's screen.

### Talking to Virvi **(owner: a dedicated chat box)**

- Walking up to Virvi (or clicking it) opens a chat panel. The panel shows the design's conversation, as the website
  shows it, and has a text box. Virvi's latest line also floats over its head for a few seconds **(call)**.
- The panel shows prompts left today, as the website does. When they run out, it offers a top-up through the checkout
  page.
- **Starting:** "What do you want to make?" Kinds: wearable or set, emote, building, furniture, which is everything the
  studio makes **(owner)**. The agent picker uses the website's default and isn't shown in the scene **(call)**.
- **Several designs:** the panel can switch between the visitor's open designs, including ones started on the
  website **(call)**.
- The agent's questions and the slot tick-boxes appear in the panel, as on the website.

### Virvi's moods **(call, from the owner's character sheet)**

| Studio state | Virvi |
|---|---|
| Visitor arrives (and no design is ready) | Wave, Happy |
| Reading the request, asking questions | Thinking |
| Building or rendering | Use Tech, Determined, with the hologram showing live progress steps |
| Visitor has waited a long time | Sleep |
| A design is ready (on arrival, or while waiting) | runs to the visitor, Excited, then Point and Proud at the hologram |
| A build failed | Sad, briefly, then the free retry starts as on the website |
| Finalized | Jump, Laughing |
| Guest without a wallet | Wave, then Curious, and asks them to sign in |

Expressions are swappable face textures. Poses are animations: the sheet's wave, point, jump, sit, run, float, use tech
and sleep, plus idle and walk.

### Progress and leaving

Designs run on the server whether or not the visitor is in the scene. Progress reaches the scene the way the builder
finds works in Decentraland, either the studio's websocket room or polling. A visitor who returns sees the current
state immediately.

### The hologram **(owner: image renders, simulated spinning)**

- A floating screen next to Virvi shows the server renders the website shows. Nothing else is ever loaded. Render URLs
  are the existing signed, hour-long URLs.
- **Spin:** the scene flips through the spin frames as the visitor drags or clicks arrows, so the piece seems to turn,
  as on the website. Frames load on demand and are kept. The scene's smoothness with ~36 large images must be checked
  early in the Decentraland desktop explorer. If it stutters, the fallback is one short spin video per view **(call)**.
- **Views:** the piece on its own (Inspect), on an avatar, and the emotes (idle, wave, dance, clap, walk, run, jump),
  each rendered the first time it's picked, as on the website. A set has piece tabs.
- **Clipping:** "Looks fine" and "I see clipping" on each emote, with the website's free fixes **(call)**.
- **Buildings and furniture:** the hologram shows their spin and stills. "Walk through it" opens the design's website
  page **(owner)**.
- **Finalize:** a button on the hologram shows the price and opens the checkout page. When payment settles, the scene
  shows the design as finalized and offers a "Download on Virvi" link.

### The wall of fame **(owner)**

- A "Made with Virvi Design Studio" wall shows designs their owners chose to show.
- Shown: a spin or thumbnail of the latest finalized revision, the design's name, and the creator's Decentraland name
  or shortened wallet. If the owner adds a marketplace link, that's shown too **(call)**.
- **Who can show:** only finalized designs **(call)**, so the wall never shows unpaid work. Visitors opt in from the
  scene or the website, and opt out any time.
- The wall shows a few designs at a time and cycles through them, because of the parcel's texture budget **(call)**.
  Clicking one shows it larger and offers its website page.
- The owner can hide any entry from the admin page **(call)**.

---

## Part 3: the Virvi character **(owner: the author makes it in Blender)**

- **Source:** the owner's character sheet, `docs/superpowers/specs/assets/virvi-character-sheet.png`: the Virvi
  turnaround (front, 3/4, side, back), twelve expressions, eight poses, the palette, and the material references
  (fur, iridescent ears, eyes, fabric, metal accents, glow). It's about 76 cm tall next to a 183 cm figure.
- **The stand-in (Part 2)** uses the same rig bone names, animation names and face-texture setup as the real model, so
  swapping it in is a file change **(call)**.
- **Target:** a low-poly, rigged, animated GLB within the parcel budget. About 2,000–4,000 triangles, a few materials
  and one or two textures **(call)**. It's about 76 cm tall at scale.
- **Signature details:** iridescent ears, the glowing tail orb (emissive, no real light), the forehead triangle mark,
  the jacket with the Virvi logo, and the glowing paw pads and sneakers.
- **Animations:** idle, walk, run, wave, point, jump, sit, float, use tech (with the hologram tablet as a separate
  prop), sleep.
- **Expressions:** a face texture per expression on the sheet (happy, excited, curious, wink, laughing, surprised,
  determined, thinking, silly, proud, sad, sleepy), swapped by the scene.
- The owner approves the look from renders before rigging, and again before it goes in the scene **(call)**.

## Left to the builder

- The schema for quotes, MANA payments, credit and its ledger, refund requests and wall entries.
- How the studio scene's token is scoped, within the rule above.
- MANA price sources, confirmation count, and the grace period after a quote expires.
- Progress delivery: websocket or polling.
- How the chat panel lays out on small screens, and how much of the conversation history it shows.
- The scene's server routes, and whether they reuse `/api/studio` directly.

## Open, for the owner later

- The parcel's location.
- Whether Decentraland visitors should get anything beyond the Free plan, such as a first design free.
- Whether to post the MANA price source publicly on the checkout page.
