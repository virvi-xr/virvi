# Design Studio in Decentraland, Part 2: the Scene — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Genesis City studio scene where each visitor chats with their own Virvi, watches it design, spins the renders on a hologram, finalizes through the one-time checkout link, and can put finished designs on a "Made with Virvi Design Studio" wall.

**Architecture:** Two repos. **vlm-v2** (branch `feature/dcl-studio-scene-2`) gets the wall of fame (columns on `studio_designs`, a public route, the opt-in, admin hide), a hand-off fix and, only if needed, PNG frames. **A new repo, `~/-VLM/virvi-studio-scene`** (owner's decision: its own repo), holds the SDK7 scene. It carries its own small client because `@virvixr/client` and `@virvixr/adapter-dcl` are private. The scene calls the existing `/api/studio/*` routes with the studio pass from Part 1 and polls for progress, because `virvi_studio` refuses scene passes. Logic lives in pure modules tested with vitest, and ECS/UI files stay thin.

**Tech Stack:** Fastify, drizzle, vitest and Next.js (vlm-v2); `@dcl/sdk` 7.30.1 with React-ECS, vitest and the Blender 4.4 CLI for the stand-in model (scene).

**Spec:** `docs/superpowers/specs/2026-11-04-dcl-design-studio-scene-design.md` (Part 2; Part 3's character contract is fixed here).

## Global Constraints

- **SDK versions:** `@dcl/sdk` `7.30.1` and `@dcl/js-runtime` `7.30.1`, exact (every Virvi scene pins these). `tsconfig` extends `@dcl/sdk/types/tsconfig.ecs7.json`, with `"jsx": "react"` and `"jsxFactory": "ReactEcs.createElement"`.
- **Budget:** one parcel. Soft limits about 10,000 triangles, 200 entities, 20 materials and 10 textures. Hard limit 15 MB. Height about 20 m.
- **Only server renders reach the scene.** No GLB, `.blend` or model file from the server is ever loaded. The only remote images are signed `/api/studio/render-frames/…` URLs and the wall's URLs.
- **Network:** API base from `scene.json` → `virvi.apiUrl`, default `https://virvi.io`. The website origin comes from `dashboardOriginFor(apiUrl)`, copied verbatim from vlm-v2 `packages/core/src/dashboard-url.ts`. Links open only through `openExternalUrl` from `~system/RestrictedActions`.
- **Studio pass:** from a signed `POST /api/auth/platform` with body `{ user: { displayName } }`. It lasts 15 min and has no refresh token. Re-sign every 10 min, and re-sign once (shared by concurrent requests) on a 401, then retry that request once. Never log tokens, hand-off codes or render URLs.
- **Polling:** `GET /api/studio/designs/:id` every 5 s while `activeJob` is set, a render is `queued`, or a checkout is open; every 30 s otherwise; and a full re-read at least every 45 min (render URLs expire after 1–2 h). The same 5/30 s cadence as the website, which uses 5 s with its room down.
- **Same rules as the website:** prompts are 1–4000 characters; the agent is the website's default, `'codex'`, never shown. Kinds and labels copy the website: `wearable` "Wearable", `emote` "Emote", `scene` "Building or furniture". Refusal copy is copied verbatim from the website's `refusalMessage` (vlm-v2 `apps/web/src/lib/studio.ts:221`) for the codes the scene can meet.
- **Checkout link:** `POST /api/auth/handoff` → `{ code, expiresAt }`. The link is `${origin}/auth/handoff/#code=${enc(code)}&next=${enc(next)}`, where `next` is `/studio/checkout/?design=<id>` (plus `&categories=a,b` when chosen) or `/studio/checkout/?topup=<packs>`. Build it with the copied `handoffUrlFor`, which encodes `next` whole.
- **Wall:** only designs with a `ready` entitlement can be shown. Opt-in, opt-out any time, the owner can hide.
- **Character contract** (Part 3 must match it):
  - File `models/virvi.glb`, about 0.76 m tall, origin at the feet, facing +Z.
  - Body animations: `idle`, `walk`, `run`, `wave`, `point`, `jump`, `sit`, `float`, `use_tech`, `sleep`.
  - Face: 12 quads named `face_<expression>`, children of the `head` bone, sharing one texture `models/virvi-faces.png` (a 4×3 atlas).
  - Face animations: `face_happy`, `face_excited`, `face_curious`, `face_wink`, `face_laughing`, `face_surprised`, `face_determined`, `face_thinking`, `face_silly`, `face_proud`, `face_sad`, `face_sleepy`. Each scales its quad to 1 and the other 11 to 0, and is played on its own layer alongside a body clip.
  - Bones: `root`, `hips`, `spine`, `chest`, `neck`, `head`, `ear.L`, `ear.R`, `upper_arm.L/R`, `forearm.L/R`, `hand.L/R`, `thigh.L/R`, `shin.L/R`, `foot.L/R`, `tail.1`, `tail.2`.
  - Separate prop `models/virvi-tablet.glb`.
- **Commits:** end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Run vlm-v2 under Node 22 (`source ~/.nvm/nvm.sh && nvm use 22`). Server tests use `TEST_DATABASE_URL=postgres://vlm:vlm_dev@localhost:5432/vlm_test_mana`.

## Review Focus

1. **The pass expires during a send:** a 401 re-signs and retries once. A prompt is never sent twice, because a 401 means it wasn't accepted (a test in Task 6).
2. **A visitor stays past render URL expiry:** URLs are refreshed by the 45-min re-read before they lapse (tests in Tasks 7 and 8).
3. **A visitor leaves and comes back mid-build or after it finished:** current state on the first read; the reveal plays once per new revision per visit (tests in Task 7).
4. **Not a studio pass** (a guest, a World, a wrong parcel, a realm that isn't official): each gets its own Virvi line, and no studio call is made (tests in Tasks 6 and 8).
5. **The studio is off or paused:** `404 not_found` on `/usage`, or `403 studio_paused`. Virvi says the studio is resting, and nothing throws (tests in Tasks 7 and 8).

---

## Phase A — vlm-v2 (worktree `.worktrees/dcl-studio-scene-2`)

### Task 1: Wall of fame data and routes

**Files:**
- Modify: `apps/server/src/db/schema.ts` (`studioDesigns`), `apps/server/entrypoint.sh` (fallback `ALTER TABLE … ADD COLUMN IF NOT EXISTS`, as Part 1 did)
- Create: `apps/server/src/studio/wall.ts`
- Modify: `apps/server/src/routes/studio.ts`, `apps/server/src/studio/designs.ts` (`designDetail`)
- Modify: `apps/server/test/scene-pass-guard.test.ts` (public list)
- Test: `apps/server/test/studio-wall.test.ts`

**Interfaces:**
- Produces:
  - Columns `wallShownAt timestamptz null`, `wallHiddenAt timestamptz null`, `wallMarketplaceUrl text null` on `studio_designs`.
  - `setWallChoice(design, { shown: boolean, marketplaceUrl?: string | null }, now: Date): Promise<{ ok: true; wall: WallState } | { ok: false; status: 400 | 409; code: 'not_finalized' | 'bad_marketplace_url' }>`.
  - `type WallState = { shown: boolean; hidden: boolean; marketplaceUrl: string | null }`.
  - `listWall({ limit, offset }, now): Promise<WallEntry[]>`.
  - `type WallEntry = { designId: string; name: string; kind: 'wearable' | 'emote' | 'scene'; creator: string; marketplaceUrl: string | null; shownAt: string; frames: string[] }`.
  - `creatorLabel(user, wallets: string[]): Promise<string>`.
  - `designDetail(...)` gains `wall: WallState`.

- [ ] **Step 1: Write the failing tests** in `studio-wall.test.ts`. Use `studio-routes.test.ts`'s setup, plus `entitle` and `addRevision` from `helpers/studio.ts`. Make a studio pass with `tokenFor(u, { kind: 'scene', via: 'studio', sceneId: null, locationId: null })`.
  - `PUT /api/studio/designs/:id/wall {shown:true}` on a design with no `ready` entitlement → `409 { code: 'not_finalized' }`.
  - The same after `entitle(...)` with a `ready` package → `200 { shown: true, hidden: false, marketplaceUrl: null }`. `GET /api/studio/designs/:id` has the same `wall`.
  - `marketplaceUrl: 'https://decentraland.org/marketplace/contracts/0xabc/items/1'` is kept. `'http://evil.example'`, `'javascript:x'` and a 301-character URL each → `400 { code: 'bad_marketplace_url' }`. `null` clears it.
  - The studio pass and an account token both work. Another user's design → `404`.
  - `GET /api/studio/wall` with no auth → `200 { entries: [...] }`. The entry has `designId`, `name`, `kind`, `creator`, `frames.length === 12`, and every frame URL starts with `${publicUrl}/api/studio/render-frames/`. It contains no `ownerId` and no email (assert both on the JSON string).
  - Ordered by `wallShownAt` desc; `?limit=2&offset=1` pages; `limit` is clamped to 1..24, default 12.
  - Left out: opted out (`shown:false`), hidden (`wallHiddenAt` set), and a design whose chosen render isn't `ready`.
  - Frames come from the newest `ready` entitlement's revision, not from a newer unpaid revision. Assert the token's revision id by decoding with `verifyRenderFrame`.
  - View per kind: `wearable` → `spin-male-default`; `emote` (category `emote`) → `emote-male-default`; `scene` → `orbit-scene`. Frames are 12, evenly spaced, `Math.floor(i * n / 12)`, where `n` is `frames` for spin views and 24 (the ring) for `orbit-scene`.
  - Creator: a wallet with a DCL name → the name without `.dcl.eth` (stub `getDclDirectory()`, as existing tests do). A wallet without one → `0x01d8…b38B` (first 6, `…`, last 4). No wallet → `'A Virvi creator'`.
  - The scene-pass guard still passes with `GET /api/studio/wall` listed as public.
- [ ] **Step 2: Run them.** `cd apps/server && TEST_DATABASE_URL=… npx vitest run test/studio-wall.test.ts`. Expected: FAIL (404 routes).
- [ ] **Step 3: Implement.**
  - **Columns** plus the `entrypoint.sh` fallback.
  - **`studio/wall.ts`:**
    - The URL rule is `^https://(market\.)?decentraland\.org/[^\s]{1,280}$`, at most 300 chars.
    - `listWall` mints URLs with `signRenderFrame` (`render-urls.ts:22`).
    - Creator names: `getDclDirectory().getOwnedNames(wallet)` with a 1-hour in-memory cache per wallet. A directory error falls back to the short wallet.
  - **Routes:**
    - `PUT /api/studio/designs/:id/wall` takes the `auth` preHandler set (studio pass allowed; not `work`, so it works while paused).
    - `GET /api/studio/wall` has `studioOn` only and `rateLimit { max: 60, timeWindow: '1 minute' }`.
- [ ] **Step 4: Run the tests.** Expected: PASS. Also run `scene-pass-guard.test.ts`, `studio-routes.test.ts` and `npx tsc --noEmit`.
- [ ] **Step 5: Commit** `feat(studio): a wall of fame for finalized designs their owners choose to show`.

### Task 2: Admin hide, website opt-in

**Files:**
- Modify: `apps/server/src/routes/admin-studio.ts`, `apps/server/src/studio/wall.ts`
- Modify: `apps/web/src/lib/api.ts`, `apps/web/src/lib/studio.ts` (types), `apps/web/src/app/(dashboard)/admin/studio/page.tsx`, `apps/web/src/app/(dashboard)/studio/[designId]/PaidRevisions.tsx`
- Create: `apps/web/src/lib/wall.ts`, `apps/web/src/lib/wall.test.ts`
- Test: `apps/server/test/studio-wall.test.ts` (extend)

**Interfaces:**
- Consumes (Task 1): `setWallChoice`, `listWall`, `WallState`.
- Produces:
  - `GET /api/admin/studio/wall` → `{ entries: (WallEntry & { hidden: boolean; ownerEmail: string | null })[] }`, every shown entry, hidden included.
  - `POST /api/admin/studio/wall/:designId/hide { hidden: boolean }` → `{ hidden }`.
  - Web: `api.studio.setWall(id, body)`, `api.admin.studioWall()`, `api.admin.hideWallEntry(id, hidden)`.
  - `wallToggleState(detail): { canShow: boolean; reason: string | null }` in `lib/wall.ts`. The reason copy is `'Finalize this design to show it on the wall.'`.

- [ ] **Step 1: Write the failing tests.**
  - Server: an admin lists entries, hidden ones included. Hiding removes the entry from `GET /api/studio/wall`, and unhiding restores it. A non-admin → 403. The studio pass → `403 studio_pass_not_allowed`. The owner choosing `shown:false` then `true` doesn't clear an admin hide.
  - Web `wall.test.ts`: `wallToggleState` gives `{ canShow: false, reason }` with no `ready` finalized entry, and `{ canShow: true, reason: null }` with one.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.**
  - The admin routes go under the existing `admin` guard.
  - Admin page: a "Wall of fame" section in the same style as "MANA payments that didn't match". Each row has the name, creator, owner email and a Hide/Show button, plus its error line (reuse `adminActionMessage`).
  - Design page: in `PaidRevisions.tsx`, a checkbox "Show on the Made with Virvi Design Studio wall" and an optional "Marketplace link" field (saved on blur). The 400 copy is `'Use a link to decentraland.org.'`.
- [ ] **Step 4: Run the tests.** Server `studio-wall.test.ts`, web `npx vitest run`, both `tsc`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(studio): hide wall entries from the admin page; show a design on the wall from its page`.

### Task 3: The checkout link wins over an existing session

**Files:**
- Modify: `apps/web/src/lib/handoff.ts` (`runHandoff`)
- Test: the existing `handoff` test file next to it

**Why:** today an existing account session skips the exchange (`handoff.ts:41-44`). A visitor whose browser is signed in to another account would land on a checkout for a design that isn't theirs (404).

- [ ] **Step 1: Write the failing tests.**
  - Stored account session + code that exchanges → `exchange` called, the new session saved, `go(next)`, `'signed-in'`.
  - Stored session + code that fails (non-200, or it throws) → keep the stored session, `go(next)`, `'signed-in'`.
  - No code + stored session → unchanged (`go(next)`, no exchange).
  - No session + failing code → `go(signinPath(next))`, `'fallback'`. That case is unchanged.
- [ ] **Step 2: Run them.** `cd apps/web && npx vitest run src/lib/handoff`. Expected: the first case fails.
- [ ] **Step 3: Implement.** When a code is present, try the exchange first. Only after it fails, fall back to an existing account session, and only then go to sign-in. Update the doc comment.
- [ ] **Step 4: Run the tests.** Expected: PASS. Also run web `tsc`.
- [ ] **Step 5: Commit** `fix(handoff): a checkout link signs in its own account even when the browser holds another session`.

---

## Phase B — the scene (new repo `~/-VLM/virvi-studio-scene`)

### Task 4: Scaffold, texture spike, stand-in Virvi

**Files:**
- Create: `package.json`, `package-lock.json`, `scene.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore` (`node_modules`, `bin`, `.dcl`, `dist`), `src/index.ts`, `src/config.ts`, `README.md`
- Create: `tools/standin.py` (Blender script), `models/virvi.glb`, `models/virvi-faces.png`, `models/virvi-tablet.glb`, `tools/spike/serve.mjs`, `src/spike.ts` (deleted at the end of the task)
- Test: `test/config.test.ts`, `test/standin.test.ts`

**Interfaces:**
- Produces:
  - `readConfig(info: { metadata?: string } | null): { apiUrl: string; webOrigin: string }`.
  - `dashboardOriginFor(apiUrl: string): string | null` in `src/lib/urls.ts`, copied verbatim.
  - The model files named in the character contract.
  - In the README, a **Spike result** line: `FRAME_FORMAT=webp` or `FRAME_FORMAT=png`.

- [ ] **Step 1: Scaffold.**
  - `git init`. Use `npm` (not pnpm), as Virvi's other scenes do.
  - Scripts: `start: sdk-commands start`, `build: sdk-commands build`, `deploy: sdk-commands deploy`, `test: vitest run`.
  - `scene.json`:
    - `parcels: ["0,0"]` and `base: "0,0"`. The parcel is a placeholder, since the location is unknown.
    - `display.title "Virvi Design Studio"`.
    - `spawnPoints` at the front edge (x 8, z 1), facing +Z.
    - `ecs7: true`, `runtimeVersion "7"`, and `virvi: { apiUrl: "https://virvi.io" }`.
- [ ] **Step 2: Write the failing tests.** `readConfig` with no metadata → `{ apiUrl: 'https://virvi.io', webOrigin: 'https://virvi.io' }`; with `virvi.apiUrl` `http://localhost:3001` → web origin `http://localhost:3000`; malformed JSON → defaults. The `dashboardOriginFor` cases come from vlm-v2's own tests for it.
- [ ] **Step 3: Implement** `src/config.ts` (`getSceneInformation` in `index.ts`, the pure parse in `config.ts`). Run `npm test`. Expected: PASS.
- [ ] **Step 4: Stand-in Virvi.** Write `tools/standin.py`, run with `/Applications/Blender.app/Contents/MacOS/Blender -b -P tools/standin.py`:
  - The model: a capsule body, a sphere head, two cone ears, a small emissive sphere as the tail orb, and the contract's bones.
  - Ten body actions: 1–2 s of simple, visibly different keyframes. Wave raises `upper_arm.R`. Jump moves `root`. Sleep tilts `head`. Run and walk swing the legs at different rates, and so on.
  - Twelve face quads and twelve `face_*` actions, as the contract says.
  - The face atlas `virvi-faces.png` is drawn by the script (512×384, 12 cells), each cell carrying the expression name and a simple face.
  - The tablet is a thin box.
  - Export GLB with animations and `export_animation_mode='ACTIONS'`.
  - `test/standin.test.ts` parses the GLB JSON chunk (`node:fs` plus a 20-line GLB header reader). It asserts all 22 animation names, all contract bone names, 12 `face_*` nodes, and fewer than 1,500 triangles.
- [ ] **Step 5: Spike: frame formats and spin.**
  - `tools/spike/serve.mjs` serves one webp and one png frame at extension-less paths, with the right content type and CORS `*`. Take the frames from `~/-VLM/pure-black-background-f82588d3.webp` (or any 36 numbered frames you render quickly in Blender).
  - `src/spike.ts` puts each on a plane. It then flips a 36-frame set on a third plane at 12 fps by swapping `Material.Texture.Common({ src })`.
  - Run `npm start` and open the web preview with Claude in Chrome. Record which formats show and whether the flip stutters after one loop (frames cached). Put the results in the README under **Spike result**.
  - If webp doesn't show, set `FRAME_FORMAT=png`. **Task 4b then runs.** Otherwise skip Task 4b.
  - Remove `src/spike.ts` and `tools/spike/`.
- [ ] **Step 6: Commit** `chore: scaffold the Virvi Design Studio scene with a stand-in Virvi`.

### Task 4b (only if the spike says `png`, in vlm-v2): PNG render frames

**Files:** Modify `apps/server/src/routes/studio.ts` (`render-frames`). Test `apps/server/test/studio-routes.test.ts` (or the render-frames test file).

- [ ] **Step 1: Write the failing test.** With `?fmt=png`, a valid token → `content-type: image/png`, and the body starts with the PNG magic. Without it → webp, unchanged. A bad token with `?fmt=png` → 403.
- [ ] **Step 2: Implement** `sharp(obj.body).png().toBuffer()` when `fmt === 'png'`. The token stays the authority, and `fmt` changes only the encoding.
- [ ] **Step 3: Run the tests.** Expected: PASS. Then commit `feat(studio): render frames as PNG for Decentraland`.
- The scene appends `?fmt=png` to every frame URL in Task 8 (`frameSrc(url)` in `src/studio/frames.ts`).

### Task 5: Layout greybox — **owner checkpoint**

**Files:** Create `src/scene/layout.ts` (entity builders) and `src/scene/positions.ts` (pure constants).

- [ ] **Step 1: Build the layout from primitives and the stand-in:**
  - Floor 16×16 and a low back wall.
  - An entrance arch at the front, with Virvi's spot at (8, 0, 3.5).
  - The pedestal at (8, 0, 8), with the hologram plane 1.6×1.6 m at a height of 1.6 m.
  - The wall of fame along the back (z 15.2): 3 frames of 2×2 m and the title "Made with Virvi Design Studio".
- [ ] **Step 2: Check it.** Run `npm start` and take screenshots with Claude in Chrome: from the spawn point, from above, and from the pedestal. Save them to `docs/layout/` and commit `feat: layout greybox`.
- [ ] **Step 3: STOP for the owner** (the spec requires their approval of the layout). Show the screenshots and ask them to open the scene in the Decentraland desktop explorer (`npm start -- --explorer-alpha`, per the README). Ask them to approve or change the layout, and to say whether the spin flip feels smooth. Apply any changes before Task 6.

### Task 6: Studio client

**Files:** Create `src/api/client.ts`, `src/api/types.ts`, `src/lib/urls.ts` (add `handoffUrlFor`, copied verbatim). Test `test/client.test.ts`.

**Interfaces:**
- Produces:
  - `type Fetcher = (url: string, init: { method: string; headers?: Record<string, string>; body?: string }) => Promise<{ status: number; json(): Promise<any> }>`.
  - `class StudioClient`:
    - `constructor(apiUrl: string, deps: { signed: Fetcher; plain: Fetcher; now: () => number; displayName: () => string })`
    - `signIn(): Promise<SignInResult>`, where `type SignInResult = 'studio' | 'guest' | 'not_studio'`. Guest is `verified:false`; not_studio is verified but `studio !== true`.
    - `get<T>(path)`, `post<T>(path, body?)`, `put<T>(path, body)` → `Promise<ApiResult<T>>`, where `type ApiResult<T> = { ok: true; status: number; body: T } | { ok: false; status: number; body: { code?: string; error?: string; resetsAt?: string; categories?: string[]; emote?: string } }`.
    - `renewIfDue(): Promise<void>` (re-sign when 10 min have passed).
    - `checkoutUrl(next: string): Promise<string | null>` (hand-off, then `handoffUrlFor`).
  - `src/api/types.ts`: `Usage`, `PublicDesign`, `DesignDetail`, `Message`, `Piece`, `FinalizeQuote`, `WallEntry`, matching the server shapes named in this plan's Phase A and the website's `lib/studio.ts:31-167`, trimmed to the fields the scene reads.
  - Typed helpers on the client: `usage()`, `designs()`, `design(id)`, `createDesign(kind, name?)`, `prompt(id, body)`, `renders(id, body)`, `setRenders(id, body)`, `emoteCheck(id, body)`, `clipping(id, body)`, `finalizeQuote(id)`, `finalizeRenders(id)`, `setWall(id, body)`, `wall(limit, offset)` (unauthenticated `plain`).
  - `createDesign` always sends `agent: 'codex'`.

- [ ] **Step 1: Write the failing tests**, with fakes for `signed`/`plain`:
  - `signIn` posts to `/api/auth/platform` through `signed` with body `{ user: { displayName } }` and returns `'studio'` for `{ studio: true, verified: true }`, `'guest'` for `verified: false`, and `'not_studio'` for `verified: true` without `studio`. Only `'studio'` stores a token.
  - Requests send `Authorization: Bearer <token>` through `plain`.
  - A 401 re-signs once and retries once. Two concurrent 401s share one sign-in (count `signed` calls = 2 in total, including the first sign-in). A second 401 after the retry is returned, not looped. A 401 response to `prompt` retried → exactly 2 prompt POSTs, never 3.
  - `renewIfDue` re-signs at 10 min and not at 9.
  - The client makes no studio calls before a `'studio'` sign-in; they resolve `{ ok: false, status: 0, body: { code: 'not_signed_in' } }`.
  - `checkoutUrl('/studio/checkout/?design=abc&categories=hat,mask')` → `https://virvi.io/auth/handoff/#code=…&next=%2Fstudio%2Fcheckout%2F%3Fdesign%3Dabc%26categories%3Dhat%2Cmask`. A failed hand-off → `null`.
  - A thrown fetch → `{ ok: false, status: 0, body: { code: 'network' } }`.
  - The token never appears in any value the client returns or passes to a logger (grep the test for `console` spies).
- [ ] **Step 2: Run** `npm test`. Expected: FAIL.
- [ ] **Step 3: Implement.** In `src/index.ts`, `signed` wraps `signedFetch` from `~system/SignedFetch`, and `plain` wraps global `fetch`. Keep the real status: don't copy `DclAdapter.signedRequest`'s status bug.
- [ ] **Step 4: Run** `npm test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: studio client with the studio pass`.

### Task 7: Studio state, moods and copy (pure)

**Files:** Create `src/studio/state.ts`, `src/studio/moods.ts`, `src/studio/copy.ts`, `src/studio/text.ts`. Test `test/state.test.ts`, `test/moods.test.ts`, `test/copy.test.ts`, `test/text.test.ts`.

**Interfaces:**
- Consumes (Task 6): `ApiResult`, `DesignDetail`, `Usage`, `SignInResult`.
- Produces:
  - `type Pose = 'idle' | 'walk' | 'run' | 'wave' | 'point' | 'jump' | 'sit' | 'float' | 'use_tech' | 'sleep'`.
  - `type Expression = 'happy' | 'excited' | 'curious' | 'wink' | 'laughing' | 'surprised' | 'determined' | 'thinking' | 'silly' | 'proud' | 'sad' | 'sleepy'`.
  - `type StudioView`, a discriminated union on `stage`:
    - `'signing_in' | 'guest' | 'not_studio' | 'resting' | 'unavailable'`
    - `'no_design'`
    - `'thinking'` (a queued or taken prompt job, before the `building` phase)
    - `'building'` (with `phase: string | null` and `progress: string[]`)
    - `'needs_input'` (the latest agent message has a `proposal`)
    - `'ready'`, `'failed'` (with `retry: 'resend' | 'continue' | 'fix_checks' | null`), `'finalized'`.
  - `viewOf(input: { signIn: SignInResult | null; usage: ApiResult<Usage> | null; detail: DesignDetail | null; progress: string[] }): StudioView`.
  - `pollDelayMs(view: StudioView, detail: DesignDetail | null, checkoutOpen: boolean): 5000 | 30000`.
  - `needsFullReread(lastFullAt: number, now: number): boolean` (45 min).
  - `class RevealTracker { shouldReveal(designId: string, revisionKey: string | null, view: StudioView): boolean }`.
  - `moodFor(view, waitedMs: number, justRevealed: boolean): { pose: Pose; face: Expression; line: string | null }`.
  - `refusalText(body: { code?: string; resetsAt?: string; categories?: string[]; emote?: string }, now: Date): { text: string; action?: 'topup' | 'fix' }`.
  - `plainText(markdown: string): string`.
  - `pageMessages(messages: Message[], page: number, size = 6): { items: Message[]; hasEarlier: boolean; hasLater: boolean }`.

- [ ] **Step 1: Write the failing tests.**
  - **`viewOf`:**
    - `guest` → `'guest'`; `not_studio` → `'not_studio'`.
    - `/usage` `404` → `'unavailable'`; `usage.paused` → `'resting'`.
    - `activeJob {type:'prompt', status:'queued'}` → `'thinking'`; status `'taken'` with a phase `building` event in `progress` → `'building'`.
    - `lastPrompt.outcome` maps as follows: `'needs_input'` → `'needs_input'`; `'error'`/`'timeout'` → `'failed', retry: 'resend'`; `'ceiling'`/`'turns'` → `retry: 'continue'`; a piece whose `revision.checker.pass === false` → `retry: 'fix_checks'`; `'ok'` → `'ready'`.
    - Every piece's `finalized` includes the current revision with `status:'ready'` → `'finalized'`.
  - **Phases:** the scene has no live events, so `viewOf` reads the phase from `activeJob` and `messages`. Assert `'building'` whenever `activeJob.status === 'taken'`.
  - **`pollDelayMs`:** 5000 with `activeJob`, with any render `status:'queued'` or `pending:true`, or with a checkout open; otherwise 30000.
  - **`needsFullReread`:** true at 45 min.
  - **`RevealTracker`:** true once for a new `revisionKey` (`<pieceCategory>:<revisionNumber>` joined) when the view is `'ready'`, then false. True again after a newer revision. On a fresh tracker (a new visit) with a `'ready'` view → true once ("on arrival").
  - **`moodFor`**, the spec's table row by row:
    - arrive / `no_design` → `wave`, `happy`
    - `thinking` → `idle`, `thinking` (the sheet's "Thinking" is an expression, with no pose of its own)
    - `needs_input` → `idle`, `thinking`
    - `building` → `use_tech`, `determined`
    - `building` with `waitedMs >= 180000` → `sleep`, `sleepy`
    - `ready` with `justRevealed` → `run`, then the caller sequences `point`. Assert `{ pose: 'point', face: 'proud' }` when `justRevealed` is false and the view is `ready`, and `{ pose: 'run', face: 'excited' }` when true.
    - `failed` → `idle`, `sad`
    - `finalized` → `jump`, `laughing`
    - `guest` → `wave`, `curious`
    - `not_studio` / `resting` / `unavailable` → `idle`, `curious`
  - **Lines (exact copy):**
    - `no_design`: `"Hi! I'm Virvi. Tell me what you'd like to make."`
    - `guest`: `'Hi! Sign in with a wallet and I can design something for you.'`
    - `not_studio`: `'My studio opens in Genesis City. Come find me there!'`
    - `resting`: `'The studio is taking a break. Come back soon.'`
    - `unavailable`: `"The studio isn't open right now."`
    - `thinking`: `'Let me think about that…'`
    - `needs_input`: `'I have a question for you. Take a look at the chat.'`
    - `building`: `"On it! I'm building your design."`
    - `ready`: `'Ta-da! Come see what I made.'`
    - `failed` + `resend`: `"That didn't work, and it didn't use a prompt. Want me to try again?"`
    - `failed` + `continue`: `'I ran out of time. Want me to keep going? It won't use a prompt.'`
    - `failed` + `fix_checks`: `"Something didn't pass the checker. I can fix it, and it won't use a prompt."`
    - `finalized`: `"It's yours! Download it on Virvi."`
  - **`refusalText`:** for `allowance`, `busy`, `open_design_limit`, `checks_failed`, `clipping_fix_limit`, `not_seen`, `cost_ceiling`, `payments_unavailable`, `rate_unavailable`, the text equals the website's string exactly. Copy them into the test from vlm-v2 `apps/web/src/lib/studio.ts:221-280`. `open_design_limit` has its trailing ", or upgrade." removed and adds no action, because the scene can't upgrade. **Ruling.** Unknown → `'Something went wrong. Try again in a moment.'`
  - **`plainText`:** removes `**`, `_`, `` ` ``, headings and link syntax (keeping link text), and collapses runs of blank lines.
  - **`pageMessages`:** page 0 is the newest 6, with `hasEarlier` set correctly at the boundaries.
- [ ] **Step 2: Run them.** Expected: FAIL. **Step 3: Implement.** **Step 4: Run them.** Expected: PASS.
- [ ] **Step 5: Commit** `feat: studio state, Virvi's moods and copy`.

### Task 8: Virvi, chat panel and hologram in the scene

**Files:**
- Create: `src/scene/virvi.ts` (Animator, face layer, speech TextShape, tablet prop, run-to-visitor Tween)
- Create: `src/ui/panel.tsx`, `src/ui/kinds.tsx`, `src/ui/proposal.tsx`
- Create: `src/scene/hologram.ts`, `src/studio/frames.ts`, `src/studio/views.ts`, `src/studio/loop.ts` (the poll loop as an engine system)
- Modify: `src/index.ts`
- Test: `test/frames.test.ts`, `test/views.test.ts`, `test/loop.test.ts`

**Interfaces:**
- Consumes (Tasks 6–7): `StudioClient`, `viewOf`, `pollDelayMs`, `needsFullReread`, `RevealTracker`, `moodFor`, `refusalText`, `plainText`, `pageMessages`.
- Produces:
  - `viewChoices(detail: DesignDetail, pieceCategory: string): ViewChoice[]`, where `type ViewChoice = { key: string; label: string; request: { route: 'renders' | 'set-renders'; body: object } | null; walkThrough?: true }`.
  - `frameIndexAfterDrag(current: number, frames: number, dragPx: number): number` (one frame per 20 px, wrapping).
  - `frameSrc(url: string): string` (adds `?fmt=png` only when `FRAME_FORMAT === 'png'`).
  - `class FrameCache`: `prefetchOrder(current, frames): number[]`, giving the next 6 frames in each direction.
  - `startStudioLoop(client, onUpdate: (state: LoopState) => void, clock)`, where `type LoopState = { view: StudioView; detail: DesignDetail | null; usage: Usage | null; designs: PublicDesign[]; activeDesignId: string | null }`.

- [ ] **Step 1: Write the failing tests.**
  - **`viewChoices`:**
    - Wearable piece → `Inspect` (`orbit-male`, `{ category, bodyShape: 'male', mode: 'orbit' }`), `On avatar` (`spin-male-default`), then the emotes `Idle, Wave, Dance, Clap, Walk, Run, Jump` (`spin-male-default-<emote>`, with body `emote`).
    - A wearable design with more than one piece → set views by `set-renders` with `{ bodyShape:'male', outfit:'default', emote }`.
    - An emote design → `emote-male-default` by `renders` (`category:'emote'`, no orbit), plus the set view with `emote: null`.
    - A scene design: `building` → `orbit-scene` plus `Walk through it` (`walkThrough: true`, `request: null`); `furniture_*` → `orbit-scene` plus `scale` (`mode:'scale'`).
  - **`frameIndexAfterDrag`:** wraps both ways (`(35, 36, 20)` → 0; `(0, 36, -20)` → 35).
  - **`frameSrc`:** both modes.
  - **`loop.test.ts`** (fake client and clock):
    - First tick: `signIn`, then `usage`, then `designs`, then `design(active)`. The active design is the newest non-archived one.
    - Next tick after `pollDelayMs`.
    - The 10-min `renewIfDue`.
    - A full re-read (`designs` plus `design`) at 45 min.
    - With `not_studio`, no studio calls at all.
    - A thrown error leaves the last state, retries after 30 s and never throws out of the system.
- [ ] **Step 2: Run them.** Expected: FAIL. **Step 3: Implement the pure modules.** Run the tests. Expected: PASS.
- [ ] **Step 4: Implement the ECS and UI files.**
  - **Virvi:**
    - `Animator` states are the 10 body clips plus 12 `face_*` clips. A body change stops the other body clips; a face change stops the other face clips. Both play at weight 1.
    - Speech: a billboard `TextShape` over its head shows `line` for 6 s.
    - Interaction: a pointer-down on Virvi, or the player coming within 3 m (checked each second against `engine.PlayerEntity`'s `Transform`), opens the panel.
    - Reveal: Virvi tweens (run) to 1.2 m in front of the player, then plays point/proud facing the hologram.
    - The tablet shows during `use_tech`.
  - **Panel** (React-ECS, right side, `virtualWidth 1920`):
    - A header with the design name, a switcher (open designs, newest first) and "New design".
    - "New design" opens the kind picker ("What do you want to make?" with the three website kinds).
    - Messages come from `pageMessages`, with Earlier/Later buttons. Agent text goes through `plainText`, cut to 600 chars with `…`.
    - A proposal shows its slots as tick-boxes (recommended ones pre-ticked). Sending passes `selectedSlots`.
    - `Input` holds up to 4000 chars, with a Send button that's disabled while busy.
    - The prompts line: `"<n> prompts left today"`. When the allowance runs out, a "Top up" button (see Task 9).
    - Refusals show `refusalText` in red under the input.
    - Retry buttons follow `view.retry`: Try again / Keep going / Fix it.
    - Close (X).
  - **Hologram:**
    - One plane with a PBR material swapping `Material.Texture.Common({ src: frameSrc(url) })`.
    - ◀ ▶ arrows step one frame, and holding them flips at 12 fps. A drag on the plane uses `frameIndexAfterDrag`.
    - View tabs and piece tabs are world buttons beside the plane. **Ruling:** world buttons, not panel UI, so the hologram works with the panel closed. Each visitor's scene draws only their own hologram.
    - Picking a view not yet rendered POSTs its request and shows `"Rendering…"` until ready.
    - On emote views: "Looks fine" (`emoteCheck`, `state:'fine'`) and "I see clipping" (`clipping`), with `refusalText` for `not_seen` / `clipping_fix_limit`.
    - "Walk through it" opens `${webOrigin}/studio/<id>`.
    - While building, the plane shows the last frame dimmed, with the progress lines on a TextShape under it.
- [ ] **Step 5: Check in preview.** Against a local vlm-v2 server: `STUDIO_SCENE_PARCEL=0,0` and the studio on, with a local preview realm. **The engineer checks that local preview gets the studio pass** (`auth.ts:245-249`, "unless this is local preview"), and `scene.json` `virvi.apiUrl` is set to `http://localhost:3001` for the run only. Then, with Claude in Chrome: sign in, start a design, send a prompt, watch the moods change, and spin the frames. Save screenshots to `docs/checks/`.
- [ ] **Step 6: Commit** `feat: Virvi, the chat panel and the hologram`.

### Task 9: Finalize, payment and wall opt-in from the scene

**Files:** Create `src/studio/checkout.ts`, `src/ui/finalize.tsx`. Modify `src/scene/hologram.ts`, `src/studio/loop.ts`. Test `test/checkout.test.ts`.

**Interfaces:**
- Consumes: `StudioClient.finalizeQuote`, `finalizeRenders`, `checkoutUrl`, `setWall`.
- Produces:
  - `priceLabel(quote: FinalizeQuote): string`. `dueCents` is formatted `$12.50`. A zero due with gifts or credit → `'Free with your credit'`. `blocked` → `null`.
  - `checkoutNext(designId: string, categories: string[] | null): string` (the website's `checkoutHref`, copied).
  - `topupNext(packs: number): string`.
  - `class CheckoutWatch`:
    - `open(designId, at)` sets `checkoutOpen` for 15 min, which keeps polling at 5 s.
    - `settled(detail) → boolean` is true when a piece's `finalized` gained a `ready` entry since `open`.

- [ ] **Step 1: Write the failing tests:** `priceLabel` cases; `checkoutNext` with and without categories (URL-encoded whole by `handoffUrlFor`, Task 6); `CheckoutWatch` timing out at 15 min; `settled` false on `packaging` and true on `ready`.
- [ ] **Step 2: Run them.** Expected: FAIL. **Step 3: Implement.** **Step 4: Run them.** Expected: PASS.
- [ ] **Step 5: Wire the scene.**
  - **Finalize button** on the hologram, showing `priceLabel`. Clicking it calls `finalizeRenders`, then `checkoutUrl(checkoutNext(id, null))`, then `openExternalUrl`.
  - A `null` URL → Virvi says `"I couldn't make your checkout link. Try again in a moment."`.
  - Opening starts `CheckoutWatch`.
  - **On `settled`:** the finalized mood, a "Download on Virvi" button (`${webOrigin}/studio/<id>`), and a "Show it on the wall" toggle (`setWall`; it shows `wall.hidden` as `'Hidden by Virvi'`).
  - **Top up** from the panel uses `topupNext(1)`.
- [ ] **Step 6: Check in preview.** Use the local server with the fake/test Stripe from vlm-v2's dev setup, or settle by hand with an admin grant. Screenshot to `docs/checks/`.
- [ ] **Step 7: Commit** `feat: finalize through the checkout link, download and wall opt-in`.

### Task 10: The wall of fame in the scene

**Files:** Create `src/studio/wall.ts`, `src/scene/wall.ts`. Test `test/wall.test.ts`.

**Interfaces:**
- Consumes: `StudioClient.wall(limit, offset)`, `WallEntry`.
- Produces: `class WallRotation`:
  - `constructor(slots = 3)`
  - `load(entries: WallEntry[])`
  - `visible(now: number): WallEntry[]` (rotates one slot every 8 s)
  - `needsRefetch(now): boolean` (every 30 min, under URL expiry)

- [ ] **Step 1: Write the failing tests:**
  - Fewer entries than slots → those only, no rotation.
  - Rotation order at 8 s steps.
  - Refetch at 30 min.
  - `load` with an empty list → an empty wall.
  - The creator label passes through.
- [ ] **Step 2: Run them.** Expected: FAIL. **Step 3: Implement.** **Step 4: Run them.** Expected: PASS.
- [ ] **Step 5: Wire the scene.**
  - **Frames:** the 3 frames on the back wall show `frames[0]` of each entry. A slow spin uses the 12 frames at 2 fps, only on the slot the player looks at (or the middle one). **Ruling: middle slot only**, to stay inside the texture budget.
  - **Labels:** the name and creator as a TextShape.
  - **Click:** clicking an entry shows it larger on the hologram (12-frame spin) with its name and creator, plus "See it on the Marketplace" when `marketplaceUrl` is set (open with `openExternalUrl`).
  - **Ruling:** there's no public website page for a wall entry. The spec's "offers its website page" becomes the Marketplace link. It costs a small public web page later if the owner wants one.
  - **Empty wall:** "Be the first on the wall!".
- [ ] **Step 6: Commit** `feat: the Made with Virvi Design Studio wall`.

### Task 11: Budget, README and final preview run

**Files:** Modify `README.md`. Create `tools/budget.mjs` and `test/budget.test.ts`.

- [ ] **Step 1: Write the failing test.** `tools/budget.mjs` reads `models/*.glb` (triangles, materials, textures) and the size of `bin/index.js` plus models plus images. It reports against the Global Constraints limits and exits 1 over the 15 MB hard limit. The test runs it on the repo: under 15 MB, under 10,000 triangles.
- [ ] **Step 2: Implement.** Run `npm run build && node tools/budget.mjs`. Expected: PASS, and the numbers printed.
- [ ] **Step 3: Write the README:**
  - What the scene is and the character contract.
  - Local development against a local vlm-v2 server.
  - The setting `STUDIO_SCENE_PARCEL` must equal `scene.json` `base`.
  - **Deploying to Genesis City:**
    1. Set `parcels`/`base` in `scene.json` to the real parcel, and set `STUDIO_SCENE_PARCEL` on Railway to the same `"x,y"`.
    2. `npm run build`.
    3. `npx sdk-commands deploy`, signing with the land owner's (or an authorized operator's) wallet.
    4. Visit the scene, sign in and check that Virvi greets you with a design prompt, not "My studio opens in Genesis City".
  - Swapping in the real Virvi (Part 3): replace `models/virvi.glb` and `models/virvi-faces.png`, then run `npm test` (the stand-in test checks the contract).
- [ ] **Step 4: Run through the whole thing in preview** against the local server: guest (sign-in prompt), studio pass, new design, prompt, build, reveal, spin, emote view and clipping, finalize link, settle, wall opt-in, the wall. Screenshots go to `docs/checks/`. Run `npm test` all green.
- [ ] **Step 5: Commit** `docs: deploying and swapping in the real Virvi`.
