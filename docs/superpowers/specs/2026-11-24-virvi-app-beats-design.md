# The Virvi app: BEATs on the phone, in AR spaces and in person

Status: drafted 2026-11-24 from the owner's conversation; awaiting approval. Part of LIV-11 (BEAT) and the Virvi AR
iPhone work (`docs/superpowers/specs/2026-11-22-virvi-ar-iphone-design.md`). Owner decisions are marked **[owner]**,
calls I made **[my call]**.

## Why

BEATs prove someone was at an event. Today they can only be claimed in a Virvi Decentraland scene, and the BEAT form
already promises "Ways to claim in person or on other platforms are coming." The iPhone app reads ARCs and knows when
a visitor is physically in an AR space, which is better proof of attendance than an avatar in a scene. So the phone app
becomes **the Virvi app**: AR spaces plus BEATs, one install. **[owner]**

## Goals

1. **Rename.** The iPhone app becomes "Virvi" (home-screen name and store listing). Bundle ID `io.virvi.ar` →
   `io.virvi.app` while nothing is in the App Store; the app-site-association file follows. Code names
   (`VirviARKit`, `apps/iphone`) stay. The Quest app's ID stays. **[owner: name; my call: IDs]**
2. **Sign in to Virvi in the app**, with the same account as the website. **[owner]**
3. **Claim BEATs in AR spaces** (iPhone and Quest): a published space whose scene has a live BEAT shows the BEAT card.
4. **Claim BEATs in person with no AR space**: scan the BEAT's **event ARC** once at the venue. **[owner]**
5. **Wallet choice:** one linked wallet → minted there; several → the visitor picks one (one BEAT per event per
   account); none → the claim **waits for a wallet**, holding one copy of the supply, and every waiting BEAT is sent
   when they link one. **[owner]**
6. **Sign a Quest in** with a code the headset shows, approved at virvi.io/pair or from the iPhone app. **[owner]**

## Non-goals

- **Secure mode** (a changing event ARC on a screen, every 30 s) — a later phase. **[owner]** Leave room for it: an
  event ARC belongs to a BEAT and has a kind (`printed` now).
- Online-platform BEATs claimed from the phone.
- Android.
- Showing collections, BEAT pages or account settings natively: the app links to virvi.io for those.
- A wallet inside the app, or custodial wallets.
- Background location or "Always" location permission.

## Anti-goals

- **A visitor who earned a BEAT loses it** because they had no wallet, or their wallet came later.
- **Location tracking**: location is read at two moments only, never stored beyond a yes/no and never sent anywhere
  but Virvi.
- **Two sign-in systems drifting apart** (the website's and the app's).
- **Farming**: one person claiming many copies from home with many accounts.

## Constraints and facts the design builds on

- Virvi accounts sign in with email + password, Google, Discord or a wallet (`/api/auth/*`); an account holds any number
  of **verified** wallets (`user_auth_methods`, type `wallet`, `/api/auth/wallets`).
- A short-lived sign-in hand-off code exists (`/api/auth/handoff`, `/api/auth/handoff/exchange`, 60 s).
- Headset pairing exists for builder devices (`ar_devices`, `AR_PAIRING`: 10-minute codes, `personal` and `shared`
  kinds, approved in the dashboard's AR apps page).
- In-world BEAT claiming (`apps/server/src/beats/visitor.ts`): Track my attendance (consent) → check-ins every 30 s
  credited only while the visitor's scene holds a live room connection → Claim (supply under a row lock, a per-network
  cap `BEAT_CLAIMS_PER_IP` default 3, new-wallet limit 10 per network per hour, a Decentraland profile check).
  `beat_claims.wallet` is NOT NULL; one claim per (BEAT, wallet) and per (BEAT, user).
- ARC ids: `ar_markers.ring_id` is unique and drawn at random (`randomRingId`). The codec and its seed never change.
- BEATs already have a location (`scene | online | in_person`, with venue, city or region, country, optional street and
  map URL) that locks at go-live. They have **no coordinates**.
- Apple App Store: an app offering Google or Discord sign-in must also offer **Sign in with Apple** (guideline 4.8).

## Approaches considered (sign-in)

1. **Virvi's own sign-in page in Apple's secure browser sheet** (`ASWebAuthenticationSession`), ending in a hand-off
   code the app exchanges for a session. Every website sign-in method works on day one, and so does wallet linking; one
   sign-in page to maintain. Looks like the website. **Chosen on iPhone. [owner]**
2. Native sign-in screens: most app-like, but every method built twice, wallet linking still on the web, roughly
   double the work.
3. A sign-in code approved elsewhere: ideal where typing hurts. **Chosen on Quest. [owner]**

## Approaches considered (in-person proof)

- **A. A printed event ARC**, scanned once. Reuses the ARC reader; no permission; a photo of it can travel.
- **B. Location** near the venue. Harder to fake; needs a permission; indoor GPS is rough.
- **C. A changing ARC on a screen.** Strongest without location; needs a screen.

**Chosen: A plus a light B** (location checked at check-in and at claim, "While using the app" only); C later as
secure mode. **[owner]** **One scan only**, never a second scan to claim. **[owner]**

## The design

### 1. Sign-in

**iPhone.** The menu gains **Sign in** (and, signed in, the account's name, **Sign a headset in** and **Sign out**).
Sign in opens `virvi.io/app-sign-in` in `ASWebAuthenticationSession` with a callback scheme `virvi`. That page is the
website's sign-in (all methods, plus create account), then mints a hand-off code and redirects to
`virvi://signed-in?code=…`. The app exchanges the code for the same session tokens the website uses, and keeps the
refresh token in the Keychain. **[my call: reuse the hand-off rather than a new OAuth flow]**

**Sign in with Apple** is added to the server and the website's sign-in page (a new auth method type `apple`, linking by
verified email like Google). It shows in the app through the same page.

**Quest.** A signed-out Quest offers **Sign in**, which shows a code (the existing pairing code format and 10-minute
life). It is approved at `virvi.io/pair` (signed in; enter or open the code) or from the iPhone app's **Sign a headset
in** (type the code). Approving signs the headset in to *the approver's* account as a `personal` device. **[my call:
reuse `ar_devices` pairing with a new purpose `visitor`, so a builder headset's pairing and a visitor sign-in stay
apart.]**

Sign-in is optional for seeing AR spaces. It is needed only to track a BEAT.

### 2. Event ARCs

- A BEAT whose location is **In person** gets one **event ARC** when it goes live, drawn from the same id space as
  space ARCs (unique across `ar_markers` and the new `beat_arcs`; the code-lookup route answers either). **[my call]**
- The BEAT page offers it for download in both styles (black on white, white on black), as a paper PDF, the same way
  AR spaces do. Copy: "Print this ARC and put it up at {venue}. Visitors scan it with the Virvi app to earn this BEAT."
- `beat_arcs`: `beat_id`, `ring_id` (unique), `code` (unique), `kind` (`printed`; `rotating` reserved for secure
  mode), `created_at`.
- **Venue pin.** The in-person location form gains an optional **Pin on the map** (latitude, longitude) and a radius
  (default 150 m, 50–1000 m). Without a pin, no location check. The pin locks at go-live with the rest of the location
  and is **not** put in the token's metadata. **[my call: the address alone can't be checked without geocoding, and a
  pin is more exact indoors]**
- **Suggested pin [owner, 2026-11-24].** When the host has typed the venue's address, the form suggests a pin from it:
  the server geocodes the address (street, venue, city or region, country) and the form shows the pin on a map with
  "Suggested from the address. Drag it to the entrance if it's off." The host accepts, drags or clears it. A failed or
  empty lookup says "Couldn't find that address on the map. Drop the pin yourself." Geocoding runs only on the host's
  request (a **Suggest from address** button, and once automatically when the address fields first become complete),
  server side, with the address alone (no account or user data). **[my call: OpenStreetMap's Nominatim, behind a
  server route with a cache and 1 request per second, the map drawn with Leaflet and OpenStreetMap tiles; the
  geocoder sits behind one function so it can be swapped]**

### 3. Claiming in an AR space (iPhone and Quest)

- When a published space is up and its scene has a BEAT the in-world card would show, the hint area shows the same
  card and copy as in-world: "Attend for N minutes to earn the {name} BEAT." with **Track my attendance**.
- Signed out, the button reads **Sign in to earn this BEAT**.
- Tracking needs the same consent text as in-world (a new consent version naming the app).
- **Presence:** check-ins every 30 s (`checkInDelta`), credited only while the space is shown (its ARC found) **and**
  the server has seen this signed-in user on the space's feed. A signed-in app sends its session on the feed's
  long-poll; the server records "live since" per (user, space) as `live.ts` does for room connections, and drops it
  when the poll stops. The app's own "in view" report alone never credits time. **[my call]**
- Claim, supply, too early/too late, ended plus grace, as in-world.
- **Which BEAT:** the AR space's scene's BEATs, picked as `sceneBeats` picks them (any location type: a scene, online
  or in-person BEAT attached to that scene shows in its AR spaces too). **[my call]**
- **One claim across places:** a visitor who attends the same BEAT partly in Decentraland and partly in an AR space has
  one claim, and the minutes add up — it is one event. Each check-in keeps its own place's rules. **[my call]**

### 4. Claiming in person (iPhone only)

1. **Scan once.** Pointing the app at an event ARC (no AR space involved) opens the BEAT's card. Track my attendance
   (sign-in and consent as above) **is the check-in**. If the BEAT has a pin, the phone must be within its radius
   (location asked "While using the app", at this moment only).
2. **Time.** The minimum minutes count from the check-in, wall-clock, inside the BEAT's window. The app can be closed.
   The signed-in home of the app lists **My BEATs in progress**, with the time left.
3. **Claim.** When the time is up the app (and a local notification, if allowed) offers **Claim your BEAT**. Tapping it
   re-checks the pin if there is one: inside → claimed; outside → "Come back to {venue} to claim this BEAT." until the
   claim window closes.
4. A BEAT with 0 minimum minutes: the scan's Track is the claim (one location check).

### 5. Wallets and waiting claims

- **The wallet is chosen at claim time, not at Track** (in the app; in-world stays as it is). A tracking (`present`)
  row from the app has no wallet. The per-wallet checks (blocked wallet, one claim per wallet per BEAT) move to claim
  time, and to wallet-link time for waiting claims. **[my call]**
- **At claim time** the app asks which wallet when the account has more than one verified, unblocked wallet; one →
  that wallet, no question. One BEAT per account per event (existing unique index). **[owner]**
- **No wallet:** the claim is stored with `wallet` NULL and status **`waiting`**. It **holds a copy** (counts in
  `takenCount`) **[owner]** and **never lapses** **[my call]**. The card says "Saved for you. Link a wallet at virvi.io
  and it'll be sent." with a link.
- **Linking a wallet** (on the website or through the app's sign-in page) moves every `waiting` claim of the account to
  `claimed` with that wallet; the minting job sends them as usual. If several wallets are linked at once, the first
  linked wins. A waiting claim whose BEAT already has a claim on that wallet (from another account) stays waiting and
  the Collected tab says why.
- The host's BEAT page shows a **Waiting for a wallet** count; with "Check claims before they are sent" on, the host can
  remove waiting claims like any other.
- "Check claims": the existing 24-hours-after-end auto-send skips `waiting` claims (nothing to send to).
- Schema: `beat_claims.wallet` becomes nullable, with a check that it is set for `claimed`, `minting`, `minted` and
  `failed`; the (BEAT, wallet) unique index ignores NULLs. A new `source` (`decentraland | app_space | app_event`)
  records where the claim started.
- **Host review and late wallets:** a waiting claim the host didn't remove goes out as soon as its wallet is linked,
  even after the review window — the host saw it in "Waiting for a wallet" while the window was open. **[my call]**
- **Retention:** waiting claims are exempt from the 30-day clean-up of unclaimed rows; they are kept until sent, removed
  by the host, or the account is deleted. The privacy page says so. **[my call]**
- **Retired and test BEATs:** a waiting claim follows its BEAT: sent on the BEAT's own chain (Amoy for a test BEAT),
  and on a retired BEAT handled like its other unsent claims. **[my call]

### 6. Anti-farming in the app

- Venue Wi-Fi puts every visitor on one network, so the **per-network claim cap and new-wallet-per-network limit do not
  apply to app claims** (AR space or event ARC). **[my call]**
- In their place:
  - An account must have a **verified email or a verified wallet** to track. A Sign in with Apple address counts as
    verified, including a "Hide My Email" relay; a relay address never links to an existing account by email (the
    visitor can link accounts from the website). **[my call]**
  - **App Attest:** every app claim carries an App Attest assertion, so only the genuine app on a real iPhone can track
    or claim (no scripts). **One claim per app install per BEAT**, from the attested key's id stored on the claim;
    reinstalling the app makes a new key, which is the remaining cost of farming. (DeviceCheck's two bits can't count
    per BEAT, so it isn't used.) **[my call]**
  - Location where there's a pin. **[my call]**
- The Quest: a signed-in headset is a `personal` device of one account; one claim per device per BEAT from its device id.
- The Decentraland profile check does not apply to app claims.

### 7. Where the code changes

- **Server:** Apple sign-in; `app-sign-in` hand-off redirect; visitor pairing purpose; `beat_arcs` and lookup; venue
  pin; app claim routes (`/api/app/beats/...`: card for a space or event ARC, track, check-in, claim with wallet
  choice, in-progress list); waiting claims and wallet-link fulfilment; App Attest; feed presence; host counts.
- **Website:** Sign in with Apple; `/app-sign-in`; `/pair` visitor approvals; BEAT form pin; event ARC download;
  Waiting for a wallet count; Collected tab note for waiting claims.
- **Swift package / iPhone:** rename; sign-in and Keychain; BEAT card in the visitor flow; event ARC handling; location
  (when-in-use, two moments); My BEATs in progress; local notification; Sign a headset in.
- **Quest:** sign-in code; BEAT card in AR spaces.
- **Docs:** BEATs page (in person, event ARCs, waiting claims), privacy (location, App Attest, waiting claims), app store listing.

## Left to the builder

Exact routes and payloads; screen layout within the existing hint card and menu; the in-progress list's look; the
App Attest storage; test structure; the order of the work (suggested: sign-in, then AR-space claims, then
in-person, then waiting claims, then Quest).
