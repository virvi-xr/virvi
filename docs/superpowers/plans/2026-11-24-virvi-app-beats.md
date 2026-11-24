# The Virvi app: BEATs on the phone — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rename the iPhone app to Virvi, let it (and the Quest) sign in to Virvi, and let visitors claim BEATs in AR spaces and in person with a printed event ARC, including claims that wait for a wallet.

**Architecture:** The server gains an app-facing BEAT service (`apps/server/src/beats/app.ts`, routes under `/api/app/`) beside the in-world one, sharing its supply lock, window and minting. Sign-in reuses the website's page through a hand-off code (iPhone) and the AR device pairing table (Quest). Event ARCs share the ring-id space with space ARCs; the app looks codes up through one new route that answers either.

**Tech Stack:** Fastify + Drizzle + Vitest (server), Next.js 15 static export + Vitest (web), Swift/ARKit/RealityKit + XCTest (`packages/virvi-ar-swift`, `apps/iphone`), Kotlin + JUnit (`apps/quest`).

**Spec:** `docs/superpowers/specs/2026-11-24-virvi-app-beats-design.md`

## Global Constraints

- Every user-facing word says **ARC** for the markers; code names (`RingCodec`, `ringId`, `ring-marker`) and the codec's seed "VLM ring marker v0" never change.
- Commit subjects are public release notes (posted to Discord on push to `main`): `feat`/`fix` subjects written for players; `test`/`chore`/`docs` otherwise. Never mention Virvi OS. Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Schema changes: edit `apps/server/src/db/schema.ts` **and** mirror them in the raw-SQL fallback in `apps/server/entrypoint.sh` (giveaways block near line 570 is the pattern; `test/entrypoint-fallback-beats.test.ts` guards beats). There are no migration files; production runs `drizzle-kit push`.
- Server tests: `cd apps/server && TEST_DATABASE_URL=postgres://vlm:vlm_dev@localhost:5432/vlm_test_sounds npx vitest run <file>` (Node 22: `source ~/.nvm/nvm.sh; nvm use 22`).
- Web tests: `cd apps/web && npx vitest run <file>`. Swift package: `cd packages/virvi-ar-swift && xcodebuild -scheme VirviARKit -destination 'platform=iOS Simulator,name=iPhone 16,OS=18.0' test` plus `-destination 'generic/platform=visionOS Simulator' build`. iPhone: `cd apps/iphone && xcodegen generate && xcodebuild -project VirviAR.xcodeproj -scheme VirviAR -destination 'platform=iOS Simulator,name=iPhone 16,OS=18.0' test` (needs `cd apps/ring-marker && python3 -m ringmarker.testset testset` once). Quest: `cd apps/quest && ./gradlew :app:testDebugUnitTest`.
- App claims (source `app_space` or `app_event`) skip `BEAT_CLAIMS_PER_IP`, the new-wallets-per-network limit and the Decentraland profile check; in-world claims keep all three unchanged.
- In-world BEAT behaviour (`apps/server/src/beats/visitor.ts`, its routes and its tests) must not change, except that `takenCount` also counts `waiting`.
- Location: read on the phone "While using the app", only at check-in and claim; sent as `{lat, lng, accuracyM}`; **never stored** on the server (only the pass/fail decision is used).
- Pin radius: default 150 m, allowed 50–1000 m. Accuracy rule: pass when `distance − min(accuracyM, 200) ≤ radius`; refuse when `accuracyM > 500`.
- A waiting claim holds a copy, never lapses, is exempt from the 30-day clean-up, and is sent as soon as a wallet is linked (first linked wins), even after the review window.
- One claim per account per BEAT (existing index), and in the app one claim per App Attest key per BEAT.
- Copy (exact):
  - Card: "Attend for N minutes to earn the {name} BEAT." · button **Track my attendance** · signed out **Sign in to earn this BEAT**
  - Claim: **Claim your BEAT** · done "Your {name} BEAT is in your wallet" · waiting "Saved for you. Link a wallet at virvi.io and it'll be sent."
  - Outside the pin: "Come back to {venue} to claim this BEAT." · at check-in outside: "You need to be at {venue} to check in."
  - Poor fix: "Couldn't get your location accurately. Step outside or near a window and try again."
  - Event ARC download: "Print this ARC and put it up at {venue}. Visitors scan it with the Virvi app to earn this BEAT."
  - Pin: "Suggested from the address. Drag it to the entrance if it's off." · failed: "Couldn't find that address on the map. Drop the pin yourself." · button **Suggest from address**
  - Host count label: **Waiting for a wallet**
  - Menu: **Sign in**, **Sign out**, **Sign a headset in**; Quest pairing screen: "Go to virvi.io/pair or open the Virvi app on your phone and enter this code:"
  - App consent (`beatAppConsentText(name)`, `BEAT_APP_CONSENT_VERSION = 1`): "To track your attendance for the {name} BEAT, Virvi stores your account, how long you're here and, when you claim, the wallet you choose. Virvi checks your location only when you check in and when you claim, and doesn't keep it. The hosts of this event will see your name and time. If you claim, your wallet, this BEAT and the time it was sent are recorded on Polygon, a public blockchain: anyone can see that record, and nobody can delete it. You can stop tracking at any time before you claim, which deletes what was stored."

## Review Focus

1. **Two accounts aim at one wallet** (a waiting claim fulfilled to a wallet that already holds this BEAT from another account): the claim stays waiting and the Collected tab explains; nothing throws, nothing double-mints. → test in Task 9.
2. **Venue Wi-Fi**: 30 app visitors from one IP all claim; none hit the network cap. → test in Task 7.
3. **Wallet linked weeks after the event, BEAT ended and its review window long closed**: the waiting claim is minted, not dropped. → test in Task 9.
4. **Old Quest/iPhone builds**: `/api/ar/markers/by-code/:code` still answers space ARCs exactly as before and 404s an event ARC (old apps must not misread it). → test in Task 2.
5. **Supply full of waiting claims**: the next claimer gets "All of these BEATs have been claimed." and the host sees the waiting count. → test in Task 9.

---

### Task 1: Schema and shared types

**Files:**
- Modify: `apps/server/src/db/schema.ts` (beats ~2830, beatClaims ~2950, arDevices ~1295), `apps/server/entrypoint.sh`, `packages/shared/src/beats.ts`, `packages/shared/src/ar.ts`
- Test: `apps/server/test/entrypoint-fallback-beats.test.ts`, `apps/server/test/beats-shared.test.ts`

**Interfaces — Produces:**
- `BeatClaimStatus` gains `'waiting'`. `BeatClaimSource = 'decentraland' | 'app_space' | 'app_event'`.
- `beats`: `pinLat double`, `pinLng double`, `pinRadiusM integer` (all nullable).
- `beatClaims`: `wallet` nullable; `source text not null default 'decentraland'`; `installKeyId text` nullable; check `wallet is not null or status in ('present','waiting','removed')`; unique `(beat_id, install_key_id) where install_key_id is not null`; the (beat, wallet) unique index is unchanged (Postgres ignores NULLs).
- New `beatArcs`: `id uuid pk`, `beatId uuid unique → beats cascade`, `ringId bigint unique`, `code text unique`, `kind text not null default 'printed'` (`'printed' | 'rotating'`), `createdAt`.
- `arDevices`: `purpose text not null default 'builder'` (`'builder' | 'visitor'`).
- New `appAttestKeys`: `keyId text pk`, `publicKey text`, `counter bigint`, `userId uuid → users set null`, `createdAt`.
- `BEAT_APP_CONSENT_VERSION = 1`, `beatAppConsentText(name)` (exact text in Global Constraints), `BEAT_PIN_RADIUS = { defaultM: 150, minM: 50, maxM: 1000 }`.

- [ ] **Step 1:** Extend `entrypoint-fallback-beats.test.ts` so it asserts the fallback SQL creates `beat_arcs`, `app_attest_keys`, adds `beats.pin_lat|pin_lng|pin_radius_m`, `beat_claims.source|install_key_id`, drops NOT NULL on `beat_claims.wallet`, and adds `ar_devices.purpose`. Add to `beats-shared.test.ts`: `expect(beatAppConsentText('Launch')).toBe(<exact text with Launch>)` and `expect(BEAT_APP_CONSENT_VERSION).toBe(1)`.
- [ ] **Step 2:** Run both; expect FAIL on the missing SQL and export.
- [ ] **Step 3:** Make the schema, fallback SQL and shared changes above.
- [ ] **Step 4:** Run both plus `npx vitest run test/beat-visitor.test.ts test/beat-host.test.ts`; expect PASS (in-world unchanged).
- [ ] **Step 5:** Commit `chore(beats): schema for app claims, event ARCs and venue pins`.

### Task 2: One ARC id space, and the app's ARC lookup

**Files:**
- Create: `apps/server/src/ar/arcs.ts`
- Modify: `apps/server/src/ar/spaces.ts:137` (use the allocator), `apps/server/src/routes/ar-feed.ts` (new route beside by-code)
- Test: `apps/server/test/app-arcs.test.ts`

**Interfaces — Produces:**
- `allocateRingId(tx): Promise<number>` — a `randomRingId()` free in both `ar_markers.ring_id` and `beat_arcs.ring_id` (retry ≤ 20, then throw).
- `type AppArc = { kind: 'space'; lookup: ArMarkerLookup } | { kind: 'beat'; beatId: string; name: string }` in `packages/shared/src/ar.ts`.
- `lookupArc(code: string): Promise<AppArc | null>`; route `GET /api/app/arcs/:code` → `AppArc` or 404 `{error:'not_found'}`. A beat ARC answers only while its BEAT is visible (paid, live or within the claim grace); otherwise 404. Space ARCs follow by-code's published/builder rule.

- [ ] **Step 1:** Tests: `allocateRingId` skips an id taken in `beat_arcs` (stub `randomRingId` via `vi.mock` returning a taken id then a free one); `GET /api/app/arcs/<space code>` returns `{kind:'space', lookup}`; `GET /api/app/arcs/<event code>` returns `{kind:'beat', beatId, name}`; **Review Focus 4:** `GET /api/ar/markers/by-code/<event code>` is 404 and `<space code>` is byte-identical to before.
- [ ] **Step 2:** Run; FAIL (module missing).
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run with `test/ar-*.test.ts`; PASS.
- [ ] **Step 5:** Commit `feat(ar): one ARC code can open an AR space or a BEAT in the Virvi app`.

### Task 3: Event ARCs and their print files

**Files:**
- Create: `apps/server/src/beats/arc.ts`
- Modify: `apps/server/src/beats/routes.ts` (host routes), `apps/server/src/ar/printfiles.ts` (a caption parameter for `paperPdf`)
- Test: `apps/server/test/beat-arc.test.ts`

**Interfaces — Produces:**
- `ensureBeatArc(beatId: string): Promise<{ code: string; ringId: number }>` — creates the BEAT's one `printed` ARC on first call, for an **in-person, paid** BEAT only (else throws `BeatError(409,'no_arc','Only in-person BEATs have an ARC.')`). Ruling: created lazily on first request rather than by a go-live hook; same result for the host.
- `GET /api/beats/:beatId/arc` (host who can run events on the BEAT's scenes) → `{code}`; `GET /api/beats/:beatId/arc/files?style=normal|inverted` → paper PDF `virvi-arc-<code>-beat[-inverted].pdf`, its caption the exact event-ARC copy with the venue.
- `paperPdf(markerId, diameterMm, style, caption?: string)`; no caption keeps today's output byte-identical.

- [ ] **Step 1:** Tests: two calls return the same code; a `scene` BEAT gets 409 `no_arc`; a draft (unpaid) BEAT gets 409; a non-host gets 403; the PDF contains the caption text and, with `style=inverted`, the inverted fill (assert as `ar-printfiles.test.ts` does); `paperPdf` without a caption equals the old bytes for a fixed id.
- [ ] **Step 2:** Run; FAIL. **Step 3:** Implement. **Step 4:** Run with `test/ar-printfiles.test.ts`; PASS.
- [ ] **Step 5:** Commit `feat(beats): in-person BEATs get a printable ARC, black on white or white on black`.

### Task 4: Venue pin and address suggestion

**Files:**
- Create: `apps/server/src/beats/geocode.ts`
- Modify: the BEAT create/update validation in `apps/server/src/beats/` (where `locationVenue` is validated) and `packages/shared/src/beats.ts` (location input type)
- Test: `apps/server/test/beat-pin.test.ts`

**Interfaces — Produces:**
- Location input gains `pin?: { lat: number; lng: number; radiusM?: number } | null` (in-person only; radius defaults to 150, 50–1000; lat −90..90, lng −180..180; locked at go-live like the rest of the location; never in token metadata).
- `geocodeAddress(parts: { venue?: string; address?: string; city?: string; country: string }, fetcher = fetch): Promise<{ lat: number; lng: number } | null>` — Nominatim `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&q=<address, city, country>` (venue name tried only if the address alone finds nothing), header `User-Agent: Virvi/1.0 (+https://virvi.io)`, 5 s timeout; in-memory cache 24 h keyed by the normalised query; a process-wide queue of at most 1 request per second.
- `POST /api/beats/geocode` (authenticate; body the parts) → `{pin: {lat,lng} | null}`; 429 over 10 per user per minute.

- [ ] **Step 1:** Tests (fetcher stubbed): a hit returns lat/lng parsed from strings; an empty result returns null; a second identical call doesn't call the fetcher; two calls in the same second are spaced ≥ 1000 ms (fake timers); the address is tried before the venue name; creating a BEAT with a pin on a `scene` location is 400; radius 40 is 400; a pin change after go-live is 409 as other location fields are; the token metadata has no pin.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS with `test/beat-host.test.ts`.
- [ ] **Step 5:** Commit `feat(beats): in-person BEATs can pin the venue on a map, suggested from its address`.

### Task 5: Sign in with Apple

**Files:**
- Modify: `apps/server/src/routes/auth.ts` (beside Google, ~407–470), `apps/server/src/config.ts`
- Test: `apps/server/test/auth-apple.test.ts`

**Interfaces — Produces:**
- Config: `APPLE_SIGNIN_SERVICE_ID`, `APPLE_SIGNIN_TEAM_ID`, `APPLE_SIGNIN_KEY_ID`, `APPLE_SIGNIN_PRIVATE_KEY` (all needed to enable; secrets never logged).
- `GET /api/auth/apple` → redirect to `https://appleid.apple.com/auth/authorize` (`response_mode=form_post`, `scope=name email`, state as Google's); `POST /api/auth/apple/callback` (form body) exchanges the code (client secret = ES256 JWT signed with the key), verifies the `id_token` against Apple's JWKS (`https://appleid.apple.com/auth/keys`, cached 1 h; `iss` `https://appleid.apple.com`, `aud` = service id), then `finishOAuth(app, {type:'oauth', identifier:'apple:<sub>', email, emailVerified: true, displayName: <name from the first callback's user field or null>})` and redirects like Google.
- `/api/auth/providers` adds `apple: boolean`. Ruling: Apple, like Google today, links only by its own identifier (`finishOAuth` never links by email), which also satisfies "a relay address never links by email".
- Token verification lives in `verifyAppleIdToken(idToken, jwks, now): AppleIdentity` so it is testable without network.

- [ ] **Step 1:** Tests with a locally generated ES256/RS256 key standing in for Apple's JWKS: a valid token yields `{sub, email, emailVerified:true}`; wrong `aud`, wrong `iss`, expired → throws; the callback creates one user, a second callback for the same `sub` signs in the same user; a `privaterelay.appleid.com` email is verified and does not attach to an existing user with another method; providers shows `apple:false` without config.
- [ ] **Step 2:** FAIL. **Step 3:** Implement (use `node:crypto` for JWT/JWK; no new dependency). **Step 4:** PASS with `test/auth*.test.ts`.
- [ ] **Step 5:** Commit `feat(auth): sign in to Virvi with Apple`.

### Task 6: App sign-in hand-off and Quest visitor sign-in

**Files:**
- Modify: `apps/server/src/routes/auth-handoff.ts`, `apps/server/src/routes/ar-devices.ts`, `apps/server/src/ar/devices.ts`, `apps/server/src/app.ts` (`config.appleAppIds` default `P22YGT64VU.io.virvi.app`), `packages/shared/src/ar.ts`
- Test: `apps/server/test/app-signin.test.ts`

**Interfaces — Produces:**
- `POST /api/auth/app-handoff` (authenticate; any signed-in account, wallet not required) → `{code, expiresAt}`, kind `'app'`, 60 s. `/api/auth/handoff/exchange` with an `app` code returns `issueAccountSession(app, user, <the session's sign-in method>)` (`{user, accessToken, refreshToken}`). Existing `account`/`scene` kinds unchanged.
- `POST /api/ar/pair` accepts `purpose: 'builder' | 'visitor'` (default builder). `GET /api/ar/pair/:code` returns `purpose`. `POST /api/ar/pair/:code/approve` on a visitor code ignores `kind` (always `personal`). `POST /api/ar/pair/:code/claim` on an approved visitor code returns `{status:'approved', purpose:'visitor', session: {user, accessToken, refreshToken}}` and consumes the code; builder codes return what they do today.
- `ArPairClaimResponse` gains the visitor variant.

- [ ] **Step 1:** Tests: an email-only account gets an app code and the exchange returns a session for that user; the code works once; after 60 s it is 410; the old `/handoff` still refuses a wallet-less account; a visitor pairing approved by user A and claimed returns A's session; a builder pairing's claim response is unchanged (deep-equal to a fixture); AASA serves `P22YGT64VU.io.virvi.app` by default.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS with `test/ar-devices*.test.ts test/auth-handoff*.test.ts`.
- [ ] **Step 5:** Commit `feat(auth): the Virvi app and Quest headsets can sign in to your Virvi account`.

### Task 7: App Attest, AR presence, and claiming in an AR space

**Files:**
- Create: `apps/server/src/app-attest/verify.ts`, `apps/server/src/beats/app.ts`, `apps/server/src/beats/app-routes.ts`
- Modify: `apps/server/src/beats/live.ts`, `apps/server/src/routes/ar-feed.ts` (feed records presence when signed in), `apps/server/src/beats/visitor.ts` (export `claimUntil`, `takenCount`; `TAKEN` gains `'waiting'`), `apps/server/src/config.ts`
- Test: `apps/server/test/app-attest.test.ts`, `apps/server/test/beat-app-space.test.ts`

**Interfaces — Produces:**
- App Attest: `GET /api/app/attest/challenge` (authenticate) → `{challenge}` (32 random bytes, 5 min, single use); `POST /api/app/attest/register` `{keyId, attestation, challenge}` verifies Apple's attestation (x5c chain to the App Attest root, nonce, `rpIdHash` = SHA-256 of `<team>.<bundle id>`, aaguid by `APP_ATTEST_ENV` `development|production`) and stores the key. `requireAssertion(request, body): Promise<string /* keyId */>` checks header `X-Virvi-Attest: <keyId>.<base64 assertion>` over SHA-256 of the raw body, signature and counter increase. CBOR: a minimal decoder in `verify.ts` (attestation objects only) — no new dependency. The root certificate is a config value so tests can inject their own CA.
- Presence: `markArLive(spaceId, userId, sinceMs)`, `arLiveSince(spaceId, userId): Promise<number|null>` in `live.ts` (same store and 90 s TTL as `markBeatLive`); the space feed calls `markArLive` on each poll when `signInIfPresent` signed the caller in (`sinceMs` kept from the first poll while the key lives).
- Service (`beats/app.ts`): `appSpaceBeat(spaceId, userId|null)` → `AppBeatCard | null` (the scene's BEAT as `sceneBeats` picks it); `appTrack(beatId, {userId, installKeyId, consentVersion, via: {spaceId} | {arcCode, location?}})`; `appCheckIn(beatId, {userId, spaceId})` — credits `checkInDelta`'s seconds only since `arLiveSince`, inside the window; `appClaim(beatId, {userId, installKeyId, wallet?: string, location?})`.
- `AppBeatCard` (shared): `{ beatId, name, imageUrl, minMinutes, startsAt, endsAt, location: {type, venue?}, claim: null | { status: BeatClaimStatus; secondsPresent: number; wallet: string | null; checkedInAt: string | null } , wallets: string[] /* the caller's verified unblocked wallets */ }`.
- Routes (`app-routes.ts`, all authenticate + `requireAssertion` on writes): `GET /api/app/spaces/:spaceId/beat`, `POST /api/app/beats/:beatId/track`, `POST /api/app/beats/:beatId/checkin`, `POST /api/app/beats/:beatId/claim`, `DELETE /api/app/beats/:beatId/track` (stop: deletes a present claim), `GET /api/app/beats/mine` → `{ beats: AppBeatCard[] }` (present, waiting, claimed–minted, newest first).
- Rules: tracking needs `users.emailVerifiedAt` or a verified wallet (else 403 `verify_first` "Verify your email at virvi.io to earn BEATs."); consent must equal `BEAT_APP_CONSENT_VERSION`; one claim per (BEAT, installKeyId) (409 `this_device` "This phone already has this BEAT."); wallet: 0 → status `waiting`, 1 → it, >1 and none given → 409 `choose_wallet` with `{wallets}`, given but not the caller's → 400; per-wallet checks (blocked, unique per BEAT) run at claim; supply counts under the BEAT row lock as `claimBeat` does; source `app_space`.

- [ ] **Step 1:** Attestation tests with a test CA and a P-256 key building a synthetic attestation object: valid registers; wrong nonce, wrong rpIdHash, wrong aaguid → 400; an assertion with a non-increasing counter → 401; a replayed challenge → 400.
- [ ] **Step 2:** Space claim tests (attestation stubbed by registering a key with the test CA): card appears for a published space whose scene has a live BEAT; check-ins with no feed poll credit 0; after polls covering 6 min, a 5-minute BEAT claims; >1 wallet without choice → 409 `choose_wallet`; with choice → claimed to that wallet; no wallet → `waiting` and counted by `takenCount`; same install key on a second account → 409 `this_device`; **Review Focus 2:** 30 accounts from one IP each claim (supply 100) with no network-cap error; in-world `beat-visitor.test.ts` still passes untouched.
- [ ] **Step 3:** Run; FAIL. **Step 4:** Implement. **Step 5:** Run both plus all `test/beat-*.test.ts`; PASS.
- [ ] **Step 6:** Commit `feat(beats): visitors can earn BEATs in AR spaces with the Virvi app`.

### Task 8: Claiming in person with the event ARC

**Files:**
- Modify: `apps/server/src/beats/app.ts`, `apps/server/src/beats/app-routes.ts`
- Create: `apps/server/src/beats/geo.ts`
- Test: `apps/server/test/beat-app-event.test.ts`

**Interfaces — Consumes:** Task 7's `appTrack`/`appClaim`, Task 3's `beat_arcs`, Task 4's pin. **Produces:** `distanceM(a, b): number` (haversine, Earth radius 6 371 000 m); `locationCheck(pin | null, loc?: {lat,lng,accuracyM}): 'ok' | 'outside' | 'poor' | 'missing'`; `GET /api/app/arcs/:code` returns the `AppBeatCard` in its beat variant when the caller is signed in (`{kind:'beat', beatId, name, card}`).

Rules: `via: {arcCode, location}` — the code must be this BEAT's ARC (else 400); with a pin, `locationCheck` must be `ok` at track (`outside` → 403 `outside` with the check-in copy; `poor` → 422 `poor_fix`; `missing` → 400). Time = wall clock from `consentedAt`, clipped to the window, stored as `secondsPresent` at claim. Claim re-checks the pin (`outside` → 403 with "Come back to {venue} to claim this BEAT."). 0 minimum minutes: track claims at once. Source `app_event`.

- [ ] **Step 1:** Tests: distance Paris→London ≈ 343 km (±1 km); `locationCheck` with radius 150: 120 m acc 10 → ok, 300 m acc 20 → outside, 300 m acc 200 → ok (300−200 ≤ 150), acc 600 → poor; track outside → 403 `outside`; track ok at t, claim at t+4 min on a 5-minute BEAT → 409 `not_yet`, at t+5 min inside → claimed; at t+5 min outside → 403; no pin → no location needed; 0 minutes → track returns status `claimed` (or `waiting`).
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS. **Step 5:** Commit `feat(beats): visitors can earn in-person BEATs by scanning the event's ARC`.

### Task 9: Waiting claims: wallet-link fulfilment, host count, retention

**Files:**
- Create: `apps/server/src/beats/waiting.ts`
- Modify: `apps/server/src/auth/wallet-users.ts` (`linkVerifiedWallet`, on `'linked'`), `apps/server/src/beats/retention.ts` (`scrubBeats`), the host BEAT detail response in `apps/server/src/beats/` (add `waitingCount`), the review auto-send (skip `waiting`), `apps/server/src/beats/collection.ts` (waiting entries)
- Test: `apps/server/test/beat-waiting.test.ts`

**Interfaces — Produces:** `fulfilWaitingClaims(userId: string, wallet: string, now?: Date): Promise<{ sent: number; kept: number }>` — every `waiting` claim of the user becomes `claimed` with that wallet unless the wallet is blocked or already holds that BEAT (then stays `waiting` with `failReason = 'wallet_has_it'`). Called after a `'linked'` result, outside the link's transaction, errors logged not thrown. When several wallets are linked, each call takes only claims still waiting, so the first linked wins. Host detail gains `waitingCount: number`; host claim removal accepts waiting claims. `collectionFor` returns waiting claims for the signed-in account as `{ status: 'waiting', reason?: 'wallet_has_it' }` items (never on the public wallet page).

- [ ] **Step 1:** Tests: link → claims become `claimed` with the wallet and the mint job picks them; **Review Focus 1:** the wallet already has this BEAT from another account → stays waiting, `wallet_has_it`, no throw; **Review Focus 3:** BEAT ended 40 days ago, review on, wallet linked now → claimed; `scrubBeats` 31 days on leaves waiting claims intact; the review auto-send skips waiting; host removes a waiting claim → `removed`, copy freed; **Review Focus 5:** supply 2 with 2 waiting → the third claimer gets 409 `all_claimed` "All of these BEATs have been claimed." and the host sees `waitingCount: 2`.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS with all `test/beat-*.test.ts`. **Step 5:** Commit `feat(beats): a BEAT earned before you have a wallet is saved and sent when you link one`.

### Task 10: Website — Apple, app sign-in page, pairing page

**Files:**
- Modify: `apps/web/src/app/signin/page.tsx` (Apple button when `providers.apple`), `apps/web/src/app/auth/callback/page.tsx` (honours a `next=/app-sign-in` return), `apps/web/src/lib/api.ts`
- Create: `apps/web/src/app/app-sign-in/page.tsx`, `apps/web/src/app/pair/page.tsx`
- Test: `apps/web/src/lib/app-sign-in.test.ts`

**Interfaces — Produces:** `/app-sign-in`: signed out → the sign-in page with `next=/app-sign-in`; signed in → shows "Signing you in to the Virvi app…", calls `POST /api/auth/app-handoff`, then `window.location = 'virvi://signed-in?code=<code>'`; also offers "Not you? Sign out" first. Pure helper `appSignInRedirect(code: string): string` in `apps/web/src/lib/app-sign-in.ts`. `/pair?code=`: signed-in page that shows the code's purpose and approves it (`visitor` → "Sign this headset in to your Virvi account"; `builder` → today's approve flow with kind choice); code entry field when no `code`.

- [ ] **Step 1:** Tests: `appSignInRedirect('abc')` → `'virvi://signed-in?code=abc'`; the code is URL-encoded; the callback keeps only same-origin `next` paths (`'/app-sign-in'` kept, `'https://evil.example'` dropped).
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS, plus `npx next build` succeeds. **Step 5:** Commit `feat(web): sign in with Apple, and sign in the Virvi app and headsets from virvi.io`.

### Task 11: Website — venue pin, event ARC, waiting counts

**Files:**
- Modify: `apps/web/src/components/beats/BeatForm.tsx` (in-person block ~214), `apps/web/src/app/(dashboard)/beats/[beatId]/page.tsx`, `apps/web/src/components/beats/CollectedBeats.tsx`, `apps/web/package.json` (`leaflet@1.9.4`)
- Create: `apps/web/src/components/beats/VenuePin.tsx` (client-only, dynamic import, OpenStreetMap tiles with attribution), `apps/web/src/lib/venue-pin.ts`
- Test: `apps/web/src/lib/venue-pin.test.ts`

**Interfaces — Produces:** `addressComplete(loc): boolean` (country plus street or city); `shouldAutoSuggest(prev, next, alreadySuggested): boolean` (true once, when the address first becomes complete and no pin is set); the form shows **Suggest from address**, the map with the draggable pin, a radius field (50–1000, default 150), the exact suggested/failed copy, and **Clear pin**. Host page: **Download ARC** (style select "Black on white" / "White on black", default black on white) with the exact print copy, for in-person paid BEATs; **Waiting for a wallet** count. Collected tab: waiting items with "Saved for you. Link a wallet and it'll be sent." and, for `wallet_has_it`, "That wallet already has this BEAT. Link another wallet to receive it."

- [ ] **Step 1:** Tests: `addressComplete` true for `{country:'FR', city:'Paris'}`, false for `{country:'FR'}`; `shouldAutoSuggest` true on the first completion, false after a pin exists or a suggestion already ran.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS, `npx next build` succeeds. **Step 5:** Commit `feat(web): BEAT venue pins on a map, event ARC downloads and waiting claims`.

### Task 12: Swift package — signed-in API, BEAT card model

**Files:**
- Modify: `packages/virvi-ar-swift/Sources/VirviARKit/Api/ArApi.swift`, `.../Api/ArFeed.swift`, `.../Visitor/VisitorCopy.swift`
- Create: `.../Api/AppSession.swift`, `.../Beats/AppBeatApi.swift`, `.../Beats/BeatCard.swift`
- Test: `packages/virvi-ar-swift/Tests/VirviARKitTests/Beats/BeatCardTests.swift`, `.../Api/AppSessionTests.swift`

**Interfaces — Produces:**
- `public protocol SessionStore: Sendable { func load() -> AppTokens?; func save(_ t: AppTokens?) }`, `public struct AppTokens: Codable, Equatable { accessToken, refreshToken: String; userName: String? }`.
- `public final class AppSession` — `var signedIn: Bool`, `func bearer() async -> String?` (refreshes once on 401 via `POST /api/auth/refresh`; a failed refresh signs out), `signIn(exchanging code: String) async -> Bool` (`/api/auth/handoff/exchange`), `signOut()`.
- `ArApi` gains an optional `session: AppSession?`; `feed` sends `Authorization` when signed in.
- `AppBeatApi(baseUrl:transport:session:attest:)` with `spaceBeat(spaceId)`, `arc(code)`, `track(beatId, via:)`, `checkIn(beatId, spaceId)`, `claim(beatId, wallet:location:)`, `stopTracking(beatId)`, `mine()`; `public protocol Attester { func assertion(for body: Data) async throws -> String }` (header value).
- `public enum BeatCardState: Equatable { case hidden, signInToEarn(name, minutes), track(name, minutes), counting(name, minutesLeft), claimable(name), chooseWallet(name, wallets), claiming, waitingForWallet(name), sent(name), outside(venue), poorFix, failed(message) }` and `public struct BeatCard { mutating func apply(_ card: AppBeatCard?, signedIn: Bool, nowMs: Int64) ; mutating func apply(error: AppBeatError) }`.
- `VisitorCopy` gains the exact BEAT strings from Global Constraints.

- [ ] **Step 1:** Tests: `BeatCard` maps a present claim with 3 of 5 minutes to `counting(minutesLeft: 2)`; 5/5 → `claimable`; 409 `choose_wallet` → `chooseWallet` with the list; `waiting` → `waitingForWallet` with the exact copy; 403 `outside` → `outside(venue)`; signed out → `signInToEarn`; `AppSession` refreshes once on 401 then retries, and signs out when refresh fails (fake transport); the feed request carries `Authorization: Bearer …` only when signed in.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS (iOS tests and visionOS build). **Step 5:** Commit `test(ar): BEAT card and signed-in API for the Virvi app` — then a second commit for the sources, `feat(ar): the Virvi app can sign in and show a space's BEAT`.

### Task 13: iPhone — rename, sign-in, Sign a headset in

**Files:**
- Modify: `apps/iphone/project.yml` (`CFBundleDisplayName: Virvi`, `PRODUCT_BUNDLE_IDENTIFIER: io.virvi.app`, tests `io.virvi.app.tests`, URL type scheme `virvi`), `apps/iphone/App/VirviAR.entitlements` (App Attest `com.apple.developer.devicecheck.appattest-environment`), `apps/iphone/App/VisitorMenu.swift`, `apps/iphone/App/VirviARApp.swift`
- Create: `apps/iphone/App/KeychainSessionStore.swift`, `apps/iphone/App/SignIn.swift` (`ASWebAuthenticationSession` on `<web>/app-sign-in`, callback scheme `virvi`), `apps/iphone/App/HeadsetSignIn.swift`
- Test: `apps/iphone/Tests/SignInTests.swift`

**Interfaces — Produces:** `func handoffCode(fromCallback url: URL) -> String?` (only `virvi://signed-in?code=` with a 43-char base64url code); menu shows **Sign in** or the user's name with **Sign a headset in** and **Sign out**; Sign a headset in: a code field → `GET /api/ar/pair/:code` then approve. The store listing and `README.md` say "Virvi".

- [ ] **Step 1:** Tests: `handoffCode` accepts the right URL, rejects another scheme, host or a short code; `KeychainSessionStore` round-trips and clears (simulator keychain).
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS (whole iPhone suite). **Step 5:** Commit `feat(ar): the iPhone app is now Virvi, and you can sign in to your Virvi account`.

### Task 14: iPhone — BEATs in AR spaces and in person

**Files:**
- Create: `apps/iphone/App/BeatCardView.swift`, `apps/iphone/App/AppAttester.swift` (`DCAppAttestService`; key generated and registered once per install, id in the Keychain), `apps/iphone/App/VenueLocation.swift` (`CLLocationManager`, when-in-use, one fix ≤ 10 s, `kCLLocationAccuracyBest`), `apps/iphone/App/MyBeats.swift`
- Modify: `apps/iphone/App/VisitorController.swift` (a shown space asks `spaceBeat`, check-ins every 30 s while shown; an event ARC lookup opens the BEAT card without an AR space), `apps/iphone/App/HintCard.swift`, `apps/iphone/App/Info.plist` (`NSLocationWhenInUseUsageDescription`: "Virvi checks you're at the event when you check in and claim a BEAT.")
- Test: `apps/iphone/Tests/BeatControllerTests.swift`

**Interfaces — Consumes:** Task 12's `AppBeatApi`, `BeatCard`, `Attester`. **Produces:** check-in timer only while `.shown`; an event ARC (`AppArc.beat`) sets the card without loading a space and never starts the AR feed; a local notification at check-in + minimum minutes ("Claim your {name} BEAT"), permission asked at the first check-in; **My BEATs** in the menu when signed in, listing `mine()`.

- [ ] **Step 1:** Tests (fake API, fake clock): no check-ins while the space isn't shown; one every 30 s while shown; an event ARC shows the card and makes no feed request; claim with two wallets presents the choice and sends the chosen one; claim outside shows the exact copy; the notification is scheduled for check-in + 5 min.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS. **Step 5:** Commit `feat(ar): earn BEATs in the Virvi app, in AR spaces or by scanning an event's ARC`.

### Task 15: Quest — visitor sign-in code and BEATs in AR spaces

**Files:**
- Modify: `apps/quest/app/src/main/java/io/virvi/ar/api/ArApi.kt`, `.../visitor/VisitorFlow.kt` (copy), the visitor UI host
- Create: `.../visitor/VisitorSignIn.kt`, `.../visitor/BeatCard.kt` (mirrors Task 12's state names and copy)
- Test: `apps/quest/app/src/test/java/io/virvi/ar/visitor/BeatCardTest.kt`, `.../VisitorSignInTest.kt`

**Interfaces — Produces:** visitor pairing (`purpose:'visitor'`) with the exact pairing copy and a 10-minute code; on claim, tokens stored encrypted (`EncryptedSharedPreferences`) and used as `Bearer` on the feed and `/api/app/*`. Quest BEAT requests send no App Attest header; the server accepts a signed-in visitor device instead: add `X-Virvi-Device: <deviceId>` and in Task 7's `requireAssertion` accept a valid visitor device as its own install key (`installKeyId = 'quest:' + deviceId`) — implement that server branch here with a test in `apps/server/test/beat-app-space.test.ts`.

- [ ] **Step 1:** Tests: `BeatCard` mirrors the Swift mapping cases above; the sign-in flow goes `showingCode → signedIn` on an approved claim and back to `signedOut` on expiry; server: a visitor device's claim uses `quest:<id>` and a second account on the same device gets 409 `this_device`.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS (Quest unit tests and the server file). **Step 5:** Commit `feat(ar): sign your Quest in to Virvi and earn BEATs in AR spaces`.

### Task 16: Docs and privacy

**Files:** `apps/docs/src/content/docs/dashboard/beats.md` (in person, event ARCs, venue pin, waiting claims, the Virvi app; replace "Ways to claim in person … are coming"), `apps/docs/src/content/docs/privacy.md` and the web privacy page (location at two moments and not kept; App Attest; waiting claims kept until sent, removed or account deleted; Sign in with Apple), `apps/iphone/README.md` and its store listing text (name Virvi), `apps/web` BEAT form copy that said in-person claiming is coming.

- [ ] **Step 1:** `grep -rn "are coming" apps/web/src apps/docs` finds none about claiming; `grep -rn "Virvi AR" apps/iphone apps/web/src apps/docs` finds only historical mentions.
- [ ] **Step 2:** Web tests and `npx next build` pass. **Step 3:** Commit `docs(beats): claiming in person and in AR spaces with the Virvi app`.
