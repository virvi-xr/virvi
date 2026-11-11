# Try Virvi without an account, phase 2 (LIV-91) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A guest opens `/try/scene`, lays out a scene in the wizard, imports a zip, scans a room with a paired Quest and plays with demo analytics, events and giveaways, all without an account; deploying connects their wallet and creates the account in the same flow.

**Architecture:** Phase 1's trial rows, `kind: 'trial'` tokens and `config.trial` allowlist carry over. A trial actor gets owner-only scene access, so a small set of scene, wizard, import, room-scan and pairing routes open to it. Guest imports are `sandbox` rows that never touch the real place until a converted account deploys them. Wizard drafts and demo state stay in the browser; the Deploy step runs phase 1's wallet sign-in (convert or merge) before the deploy. The Quest uploads scans with its headset secret when no space is being built.

**Tech Stack:** Fastify 5 + Drizzle (Postgres) server, Next.js web app, Vitest, Kotlin (Quest app, JUnit).

**Spec:** `docs/superpowers/specs/2026-11-07-trial-phase2-design.md` (addendum to `2026-11-05-trial-access-design.md`; Linear LIV-91 is the authority).

## Global Constraints

- Config, with defaults: `TRIAL_IMPORTS` 2 (per trial, ever, failed included), `TRIAL_IMPORT_MAX_BYTES` 26214400, `TRIAL_ROOM_SCANS` 5 (held at once). Phase 1 values unchanged.
- Refusals for trials: `403 { error: 'account_required', action }`; actions this phase adds: `more_imports`, `import_larger`, `more_scans`, `shared_headset`, `element_type`, `room_set`, `demo:<method>`. Non-allowlisted routes keep phase 1's `'<METHOD> <route url>'`.
- Trial element types: `model`, `image`, `video`, `sound` only.
- Copy, verbatim: deploy line "Connect your wallet to deploy. This also creates your Virvi account."; wallet prompt "Check your wallet: sign once to create your account, then once more to deploy."; Where choice "Decentraland World — you'll connect the wallet that owns it when you deploy."; save sheet "Create a free account to save *<name>*. Your layout is kept."; no-NAME line "This wallet doesn't own a Decentraland NAME. Your account is ready: connect the wallet that owns your World, or pick Hyperfy or Virvi AR instead."; demo banner "Demo with sample data. Changes stay in this browser and are never sent anywhere."; landing link "Build a scene — no account needed"; Quest scan cap "Your trial holds 5 room scans. Create a free account on virvi.io to keep more."
- Browser keys: `virvi.wizard.draft` (14-day life), `virvi.demo.<trialId>`.
- Sample World for demos: `virvi-sample.dcl.eth`, 2×2 parcels.
- Every route opened here is added to `ALLOWED` in `test/trial-guard.test.ts` and walked in `test/cross-account-walk.test.ts` (non-param ones join that test's `own` set).
- Server tests use a per-worktree `TEST_DATABASE_URL`. Breaking changes are fine (no users yet); no compat shims.

## Rulings made while planning

- R1 The wizard's "save" is `POST /api/wizard/scenes`; it stays account-only. Drafts are browser-only. Cost if wrong: a server draft table.
- R2 Turnstile runs at `/try/scene`'s Start, the only trial creation point; no new checks elsewhere.
- R3 Sandbox imports are excluded from the place lock, supersede and auto-deploy, and are claimed for their place only when an account deploys them.
- R4 A trial-approved headset mints no passes; the Quest's new secret-auth upload is how a trial scans. Accounts may use it too.
- R5 After wallet conversion mid-deploy, calls holding the old trial token rely on phase 1's `401 trial_ended` swap; no new token plumbing in `runWizard`.

## Review Focus

1. A guest imports a zip naming another account's World that has a built import awaiting signature and a Virvi grant: the owner's import stays as it was, the guest's build finishing deploys nothing, and the owner can still upload (Task 3).
2. Two guest uploads at once with one import left: exactly one is accepted (Task 3).
3. A trial-approved headset asks for a pass for a scene the trial owns (an import's scene): refused, and it lists no spaces or scenes (Task 4).
4. Signing in at Deploy with a wallet that already has an account: the trial's scenes, imports, scans and headsets move, the trial row goes, and the deploy carries on as the account (Task 6, Task 8).
5. A trial expiring while its import builds: the build machine is stopped and `imports/<id>/` deleted; a converted account with the same history is untouched (Task 6).

---

### Task 1: Owner-only scene access for trials, and the scene core routes

**Files:**
- Modify: `apps/server/src/auth/actor.ts`, `apps/server/src/auth/permissions.ts` (`getSceneAccess`), `apps/server/src/routes/scenes.ts`
- Test: `apps/server/test/trial-scenes.test.ts`, `apps/server/test/trial-guard.test.ts`, `apps/server/test/cross-account-walk.test.ts`

**Interfaces:**
- Produces:
  - `Actor.trial?: true`; `actorFromClaims` for `kind: 'trial'` returns `{ userId: id, role: 'creator', wallet: null, verified: false, trial: true }` (phase 1 returned `ANONYMOUS`).
  - `getSceneAccess(actor, sceneId)`: for `actor.trial`, `full('owner')` when `scene.ownerId === actor.userId`, else `NONE`, checked before the admin, collaborator, role and grant paths.
  - `trial: true` on: `GET /api/scenes`, `GET /api/scenes/:sceneId`, `PUT /api/scenes/:sceneId`, `DELETE /api/scenes/:sceneId`, `POST /api/scenes/:sceneId/presets`, `PATCH /api/presets/:presetId`, `DELETE /api/presets/:presetId`, `POST /api/presets/:presetId/activate`, `POST /api/presets/:presetId/elements`, `PUT /api/elements/:elementId`, `POST /api/elements/:elementId/live`, `DELETE /api/elements/:elementId`, `POST /api/elements/:elementId/instances`, `PUT /api/instances/:instanceId`, `DELETE /api/instances/:instanceId`, `DELETE /api/elements/:elementId/instances`.
  - `GET /api/scenes` for a trial: its owned scenes only (no collaborations or roles).
  - Element create/update by a trial: `type` outside the trial element types → `403 account_required` / `element_type`; a body that places a room set (the `prepareRoomSetForPlacement` path) → `room_set`.

- [ ] **Step 1: Write the failing tests** in `trial-scenes.test.ts` (trial made as in `trial-guard.test.ts`'s `makeTrial`; its scene via `insertSceneWithDefaultPreset`):
  - `a trial reads, renames and edits its own scene`: GET 200; PUT `{ name: 'Mine' }` 200; create preset 201; create a `model` element 201; add, move, delete an instance 2xx.
  - `a trial lists only its own scenes`: B owns a scene and adds the trial as `sceneCollaborators` editor → list is exactly the trial's scene ids.
  - `a trial gets nothing on another account's scene`: GET B's scene → 403 or 404.
  - `trial elements are model, image, video or sound`: `ad_space`, `widget`, `custom`, `nft` → 403 `element_type`; PUT changing a model to `ad_space` → 403 `element_type`.
  - `a trial can't place a room set`: element body with a room set → 403 `room_set`.
  - `a trial's actor never reaches admin`: a trial row with `role: 'admin'` forced in the DB still gets 404/403 on B's scene.
  - In `trial-guard.test.ts` add the 16 routes to `ALLOWED`; in `cross-account-walk.test.ts` add `GET /api/scenes` to `own`.
- [ ] **Step 2: Run** `npx vitest run test/trial-scenes.test.ts test/trial-guard.test.ts` — Expected: FAIL (account_required on the scene routes).
- [ ] **Step 3: Implement** as in Interfaces. Leave every other scene route closed.
- [ ] **Step 4: Run** `npx vitest run test/trial-scenes.test.ts test/trial-guard.test.ts test/cross-account-walk.test.ts test/scene-routes.test.ts test/permissions.test.ts && npx tsc --noEmit -p .` — Expected: PASS, no type errors.
- [ ] **Step 5: Commit** `feat(trial): guests edit their own scenes' Virvi layer; owner-only access (Refs LIV-91)`.

### Task 2: Wizard, catalog and room-scan reads for trials; `/try/scene` trial entry

**Files:**
- Modify: `apps/server/src/routes/wizard.ts`, `apps/server/src/routes/room-scans.ts`, `apps/server/src/routes/room-sets.ts`, `apps/server/src/routes/hyperfy-worlds.ts`, `apps/server/src/routes/assets.ts`, `apps/server/src/routes/trial.ts`
- Test: `apps/server/test/trial-wizard.test.ts`, `trial-guard.test.ts`, `cross-account-walk.test.ts`

**Interfaces:**
- Produces:
  - `trial: true` on `GET /api/wizard/catalog`, `GET /api/wizard/options`, `GET /api/room-scans`, `GET /api/room-scans/:id`, `DELETE /api/room-scans/:id`, `GET /api/room-scans/:id/preview.glb`, `GET /api/hyperfy/slots`, `GET /api/assets`, `GET /api/assets/:id`, `GET /api/assets/categories`. `POST /api/wizard/scenes` stays closed (the save).
  - `GET /api/wizard/options` for a trial: `{ ..., scenes: { used: <trial's scenes>, limit: null }, trial: true }`.
  - `POST /api/auth/trial` takes optional `entry: 'studio' | 'scene'` (anything else ignored); the `started` funnel row's `action` is it.

- [ ] **Step 1: Write the failing tests**:
  - `a trial loads the wizard`: catalog 200 with themes; options 200 with `trial: true`, `scenes.limit: null`.
  - `a trial's save is account_required`: `POST /api/wizard/scenes` with a valid body → 403, `action: 'POST /api/wizard/scenes'`.
  - `a trial sees only its own room scans and previews them`: one scan each for trial and B; list = trial's; preview of its own → 200 `model/gltf-binary`; B's → 404.
  - `a trial's asset browse shows public assets only`: B's private asset absent from `GET /api/assets?mine=1` and `GET /api/assets/:id` → 404.
  - `the trial start records its entry`: `entry: 'scene'` → `trial_events` row `started` / `scene`.
  - Guard and walk lists updated (non-param routes to `own`).
- [ ] **Step 2: Run** `npx vitest run test/trial-wizard.test.ts test/trial-guard.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npx vitest run test/trial-wizard.test.ts test/trial-guard.test.ts test/cross-account-walk.test.ts test/wizard-routes.test.ts test/room-scans.test.ts test/trial-session.test.ts` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(trial): guests use the scene wizard up to Deploy (Refs LIV-91)`.

### Task 3: Sandbox imports for trials

**Files:**
- Modify: `apps/server/src/db/schema.ts` (`scene_imports.sandbox`, `users.trial_imports`) + `apps/server/entrypoint.sh` fallback, `apps/server/src/config.ts`, `apps/server/src/routes/imports.ts`, `apps/server/src/services/import/imports.ts`, `apps/server/src/services/import/import-deploy.ts`
- Test: `apps/server/test/trial-imports.test.ts`, `trial-guard.test.ts`, `cross-account-walk.test.ts`, `entrypoint-fallback-imports.test.ts`

**Interfaces:**
- Produces:
  - Columns: `scene_imports.sandbox boolean not null default false`; `users.trial_imports integer not null default 0`.
  - `reserveTrialImport(userId: string): Promise<boolean>`: `update users set trial_imports = trial_imports + 1 where id = $1 and is_trial and trial_imports < TRIAL_IMPORTS returning id`.
  - `createImport(input & { sandbox?: boolean })`: sandbox skips `lockLocation`, the busy check and supersede, always creates a new scene, and inserts `sandbox: true`. `latestImportFor`, the busy check and supersede filter `sandbox = false`.
  - `claimSandboxImport(row: SceneImportRow): Promise<SceneImportRow>`: in one transaction `lockLocation`, the busy check (409 `import_in_progress`), supersede of others, `sandbox = false`; a no-op for `sandbox = false`.
  - `POST /api/imports/:id/deploy` (account) calls `claimSandboxImport` before `startImportDeploy`. `deployImport` (build done) returns early for `sandbox`.
  - `trial: true` on `POST /api/imports`, `GET /api/imports`, `GET /api/imports/:id`, `GET /api/imports/:id/log`. Deploy and the backup/download routes stay closed.
  - Trial upload rules: `content-length` over `TRIAL_IMPORT_MAX_BYTES` → `403 account_required` / `import_larger` before the body is read (onRequest, after `authenticate`), and the read buffer is checked again; no `ownerFor`/`requireParcelController` (the parcel format check stays, extracted as `checkParcels(location)`); `sceneFor` not called (new scene from `sceneName`); `reserveTrialImport` after `readSceneZip` succeeds, `false` → `more_imports`.

- [ ] **Step 1: Write the failing tests** (fake build runner as in `import-routes.test.ts`):
  - `a guest imports a World it doesn't own`: 201; the row has `sandbox: true`, a new scene owned by the trial; build started.
  - `a guest import never touches the place`: B has a built import awaiting signature for `b.dcl.eth` and a granted destination; the trial uploads for `b.dcl.eth` → B's import status unchanged, destination's `pendingImportId` unchanged; B uploads again while the trial's builds → 201 (no `import_in_progress`).
  - `a finished guest build never auto-deploys`: `deployImport(trialImportId)` with a granted destination → import still `built`, no `scene_deployments` row.
  - `two guest imports, then a third is account_required`: 2 × 201, the 3rd → 403 `more_imports`.
  - `two at once with one left: one accepted`: `trial_imports = 1`, two uploads via `Promise.all` → one 201, one 403 `more_imports`.
  - `a zip over 25 MB is account_required for a guest`: `content-length: 26214401` → 403 `import_larger`; an account's same zip passes the gate.
  - `deploying a converted guest's import claims its place`: convert the trial (`convertTrial`), give it a wallet that owns the World (fake Worlds helper), deploy → `sandbox: false`, B's built import superseded; a wallet that doesn't own it → 403 `not_world_owner` and `sandbox` stays true.
  - `a guest's deploy is account_required`: `POST /api/imports/:id/deploy` with the trial token → 403.
  - Entrypoint fallback test lists both new columns.
- [ ] **Step 2: Run** `npx vitest run test/trial-imports.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** as in Interfaces; config values from Global Constraints.
- [ ] **Step 4: Run** `npx vitest run test/trial-imports.test.ts test/import-*.test.ts test/trial-guard.test.ts test/cross-account-walk.test.ts test/entrypoint-fallback*.test.ts` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(trial): guests import scenes into a sandbox that never touches the real place (Refs LIV-91)`.

### Task 4: Headsets for trials, and scan upload with the headset secret

**Files:**
- Modify: `apps/server/src/routes/ar-devices.ts`, `apps/server/src/ar/devices.ts`, `apps/server/src/routes/room-scans.ts`, `apps/server/src/config.ts`
- Test: `apps/server/test/trial-headsets.test.ts`, `ar-devices.test.ts`, `trial-guard.test.ts`, `cross-account-walk.test.ts`, `test/helpers/public-routes.ts`

**Interfaces:**
- Produces:
  - `trial: true` on `GET /api/ar/pair/:code`, `POST /api/ar/pair/:code/approve`, `GET /api/ar/devices`, `DELETE /api/ar/devices/:id`. `accountOnly` lets a trial through on these; approve for a trial: `kind: 'shared'` → `403 account_required` / `shared_headset`, `personal` approves with the trial as approver (no `verified` check for trials).
  - `approverOf` / `mintForScene`: an approver with `isTrial` → `'no_access'`; `listDeviceSpaces` and `listDeviceScenes` → `[]` for a trial approver.
  - `saveRoomScan(userId: string, name: unknown, layout: unknown): Promise<{ status: 201; scan } | { status: 400 | 403; body }>` extracted from `POST /api/ar/room-scans`; for a trial owner holding `TRIAL_ROOM_SCANS` scans → 403 `account_required` / `more_scans`.
  - `POST /api/ar/devices/:id/room-scans { secret, name, layout }` (public, headset secret): `bodyLimit: ROOM_SCAN_BODY_LIMIT`, rate limit `{ max: 30, timeWindow: '1 minute' }`; live personal device only (`personal_only` 403, `bad_secret` 401, `device_revoked` 401); saves to the approver; listed in `public-routes.ts` ("the headset secret is the auth") and walked in `CASES` with a guessed secret.

- [ ] **Step 1: Write the failing tests**:
  - `a trial approves its own headset as personal`: start, approve with the trial token → `approved`, `ar_devices.user_id` = trial.
  - `a trial can't approve a shared headset` → 403 `shared_headset`.
  - `a trial's headset mints no pass and lists nothing`: the trial owns an import scene; `mintArPassForScene` for it → `no_access`; spaces and scenes lists `[]`.
  - `a headset uploads a scan with its secret`: claimed personal device → 201, row owned by the approver; wrong secret → 401; shared device → 403 `personal_only`.
  - `a trial holds 5 scans`: 5 × 201, 6th → 403 `more_scans`; delete one → next 201.
  - `an account's headset still uploads through a pass` (existing route unchanged).
  - Guard, walk and public-route lists updated.
- [ ] **Step 2: Run** `npx vitest run test/trial-headsets.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npx vitest run test/trial-headsets.test.ts test/ar-devices.test.ts test/room-scans.test.ts test/trial-guard.test.ts test/cross-account-walk.test.ts` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(trial): guests pair a personal headset; headsets upload scans with their secret (Refs LIV-91)`.

### Task 5: Quest scans without a space

**Files:**
- Modify: `apps/quest/app/src/main/java/io/virvi/ar/roomscan/RoomScanApi.kt`, `.../roomscan/RoomScanFlow.kt`, `.../builder/DeviceAuth.kt`, `.../builder/BuilderPanels.kt` (`BuilderPromptPanel`), `.../MainActivity.kt`
- Test: `apps/quest/app/src/test/java/io/virvi/ar/roomscan/RoomScanApiTest.kt`, `RoomScanFlowTest.kt`

**Interfaces:**
- Consumes: Task 4's `POST /api/ar/devices/:id/room-scans`.
- Produces:
  - `DeviceAuth.credential(): DeviceCredential?` (`data class DeviceCredential(val deviceId: String, val secret: String)`, `toString` hides the secret), null unless paired.
  - `RoomScanApi.uploadWithDevice(name: String, layout: JsonObject): BuilderCall<RoomScanUpload>`; refusal mapping adds `403 account_required` + `more_scans` → `Refused(RoomScanCopy.TRIAL_SCAN_LIMIT)` and `403 personal_only` → `Refused(RoomScanCopy.SHARED_DEVICE)`.
  - `RoomScanFlow(upload, uploadWithDevice, spaceId, …)`: `upload()` uses the pass path when `spaceId()` is non-null, else `uploadWithDevice`.
  - `BuilderPromptPanel` shows **Scan this room** (opens the flow) for a personal headset, including when it has no spaces.
  - `RoomScanCopy.TRIAL_SCAN_LIMIT` = the Global Constraints line.

- [ ] **Step 1: Write the failing tests**: `uploads with the device secret` (path `/api/ar/devices/<id>/room-scans`, body has `secret`, `name`, `layout`; 201 → `Uploaded`); `maps the trial scan limit` (403 `{ error: 'account_required', action: 'more_scans' }` → `Refused(TRIAL_SCAN_LIMIT)`); `flow without a space uses the device upload` (fake `spaceId = { null }` → `uploadWithDevice` called once, pass upload never); `flow in a space keeps the pass upload`.
- [ ] **Step 2: Run** `cd apps/quest && ./gradlew :app:testDebugUnitTest` — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `./gradlew :app:testDebugUnitTest :app:assembleDebug` — Expected: PASS, APK builds.
- [ ] **Step 5: Commit** `feat(quest): scan a room without building in a space (Refs LIV-91)`.

### Task 6: Merge and expiry cover scenes, imports, scans and headsets

**Files:**
- Create: `apps/server/src/auth/trial-data.ts`
- Modify: `apps/server/src/auth/trial-convert.ts` (`mergeTrial`), `apps/server/src/auth/trial-sweep.ts` (`expireTrial`)
- Test: `apps/server/test/trial-convert.test.ts`, `apps/server/test/trial-sweep.test.ts`

**Interfaces:**
- Consumes: Tasks 1, 3, 4 data.
- Produces:
  - `moveTrialSceneData(tx: Tx, fromUserId: string, toUserId: string): Promise<void>`: `scenes.owner_id`, `scene_imports.user_id`, `room_scans.user_id`, `room_sets.user_id`, `ar_devices.user_id`, `scene_library.added_by` move; scenes keep `org_id` null. Called by `mergeTrial` after `moveStudioData`, same transaction.
  - `trialLeftovers(userId: string): Promise<{ importIds: string[]; buildingMachines: string[]; thumbnailKeys: string[] }>`, read before the delete; `releaseTrialLeftovers(l)`: `getBuildRunner()?.stop(id)` for each machine (errors logged), `deleteImportFiles(importIds)`, `deleteThumbnailFile(key)` each. `expireTrial` reads leftovers before its guarded delete and releases them only when the delete removed the row.

- [ ] **Step 1: Write the failing tests**:
  - `signing in from a trial moves its scenes, imports, scans and headsets`: trial with an import scene, a scan and an approved headset → `mergeTrial(trial, account)` → all owned by the account; trial row gone.
  - `wallet sign-in from a trial at Deploy merges into the wallet's account` (through `POST /api/auth/wallet/verify` with the trial bearer, as phase 1's wallet tests sign): same assertions.
  - `email sign-up keeps them on the same id` (no move needed): import scene still owned by `trialId`, `is_trial` false.
  - `expiring a trial stops its build and deletes its files`: trial idle 15 days with a `building` import (`machine_id: 'm1'`) and a scene thumbnail → runner `stop('m1')`, `deletePrefix('imports/<id>/')`, thumbnail deleted; rows gone.
  - `a converted account is never swept` (with imports and an old `trial_last_active_at`): nothing stopped or deleted.
- [ ] **Step 2: Run** `npx vitest run test/trial-convert.test.ts test/trial-sweep.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npx vitest run test/trial-*.test.ts test/studio-merge.test.ts` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(trial): sign-in moves a trial's scenes, imports, scans and headsets; expiry cleans their files and builds (Refs LIV-91)`.

### Task 7: `/try/scene`, the trial shell and the wizard for guests

**Files:**
- Create: `apps/web/src/app/try/scene/page.tsx`, `apps/web/src/lib/wizard/draft.ts`
- Modify: `apps/web/src/lib/session.ts` (`trialAllows`), `apps/web/src/app/(dashboard)/layout.tsx` (nav), `apps/web/src/lib/auth.tsx` (`startTrial(token, entry?)`), `apps/web/src/lib/wizard/state.ts`, `apps/web/src/components/wizard/steps/WhereStep.tsx`, `apps/web/src/app/(dashboard)/scenes/new/page.tsx`, `apps/web/src/lib/api.ts` (`bootstrapWizardScene(data, ctx?)`), `apps/web/src/lib/trial.ts` (`blockedCopy`, `ACTION_LABELS`), `apps/web/src/app/_landing/Doors.tsx`
- Test: `apps/web/src/lib/session.test.ts`, `src/lib/wizard/state.test.ts`, `src/lib/wizard/draft.test.ts`, `src/lib/trial.test.ts`

**Interfaces:**
- Consumes: Task 2 routes.
- Produces:
  - `trialAllows(pathname)`: true for `/studio*`, `/scenes`, `/scenes/new`, `/scenes/<id>`, `/import`, `/demo/*`.
  - Layout for a trial: Scenes unlocked; Analytics, Events, Giveaways link to `/demo/analytics`, `/demo/events`, `/demo/giveaways` with a "Demo" badge; the rest locked as in phase 1.
  - `WizardState.dclLater: boolean` (initial false); action `{ type: 'setDclLater'; on: boolean }` (on clears `destinations.dcl`; `setDcl` with a World clears `dclLater`); `canAdvance('where')` accepts `dclLater`; Size needs a plot and the hard budget applies when `dcl || dclLater`.
  - `lib/wizard/draft.ts`: `DRAFT_KEY = 'virvi.wizard.draft'`, `saveDraft(state: WizardState, now: number): void`, `loadDraft(now: number): WizardState | null` (null when missing, unparsable, of another version, or older than 14 days), `clearDraft(): void`; all storage calls in try/catch. The page saves on each change while `user.trial`, loads on mount for any session, clears when `memory.sceneId` is set and on sign-out (never on `trial_ended`: conversion must keep it).
  - WhereStep for a trial: no names lookup or wallet connect; the "Decentraland World" choice (copy in Global Constraints) toggles `dclLater`; with no scans the picker says "Pair your Quest to scan a room: open Virvi AR on the headset, then enter its code" with a code field → `/pair/headset/<code>`.
  - `blockedCopy` entries: `POST /api/wizard/scenes` (save copy, `emphasis` = `ctx.sceneName`), `POST /api/imports/:id/deploy`, `GET /api/scenes/:sceneId/backup.zip`, `more_imports`, `import_larger`, `more_scans`, `shared_headset`, `element_type`, `room_set`, and any `demo:` action ("Create a free account to use this with your own scenes."). `BlockedCtx.sceneName?: string`.
  - `/try/scene`: Turnstile + "Start building" → `beginTrial` with `entry: 'scene'` → `/scenes/new`; a trial or account goes straight there. Landing link per Global Constraints.

- [ ] **Step 1: Write the failing tests**: `trialAllows` for each allowed path, and `/settings`, `/deploy`, `/scenes-x` false; `dclLater advances Where and needs a plot on Size`; `picking a World clears dclLater`; `loadDraft returns the saved state`, `drops a 15-day-old draft`, `drops another version`, `survives storage that throws`; `blockedCopy('POST /api/wizard/scenes', { sceneName: 'Ramen Bar' })` → title `Create a free account to save Ramen Bar. Your layout is kept.`, `emphasis: 'Ramen Bar'`.
- [ ] **Step 2: Run** `cd apps/web && npx vitest run src/lib/session.test.ts src/lib/wizard src/lib/trial.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `pnpm typecheck && npx vitest run` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(web): try the scene builder at /try/scene with no account (Refs LIV-91)`.

### Task 8: Deploying creates the account from the wallet

**Files:**
- Create: `apps/web/src/lib/wizard/trial-deploy.ts`
- Modify: `apps/web/src/components/wizard/steps/DeployStep.tsx`, `apps/web/src/app/(dashboard)/import/page.tsx`
- Test: `apps/web/src/lib/wizard/trial-deploy.test.ts`

**Interfaces:**
- Consumes: phase 1 `loginWithWallet(fromAction?: string): Promise<string>`; Task 7 `dclLater`; Task 3 claim on deploy.
- Produces:
  - `connectForDeploy(deps: { loginWithWallet: (a: string) => Promise<string>; names: (token: string) => Promise<{ wallets: Array<{ address: string; names: DclWorld[] }> }> }): Promise<{ wallets: Array<{ address: string; names: DclWorld[] }> }>`: calls `loginWithWallet('deploy')` once, then `names` with the returned token.
  - `autoPickWorld(wallets): { world: DclWorld; wallet: string } | null`: the only World across the wallets when it has no scene, else null.
  - `noWorldMessage(wallets): string | null`: the no-NAME line when no wallet has a World.
  - DeployStep, trial with `dclLater`: shows the deploy line and a "Connect your wallet" button; after `connectForDeploy`, `autoPickWorld` → `setDcl` and `start()`; otherwise a World list (as WhereStep's) with the replace confirm, then the normal button. While the wallet is asked: the wallet prompt line. Trial without `dclLater`: the normal button; `bootstrapWizardScene` gets `{ sceneName }` for the sheet.
  - Import page, trial: Deploy shows the deploy line; `loginWithWallet('deploy')` then `deploySceneImport` as the account; Download buttons open the sheet.

- [ ] **Step 1: Write the failing tests**: `connects once, then lists the new account's Worlds` (fake deps: `loginWithWallet` called with `'deploy'`, `names` called with its token); `a wallet sign-in that fails stops before listing` (rejects with the wallet's error; `names` not called); `autoPickWorld` picks a lone empty World, returns null for two Worlds or one with a scene; `noWorldMessage` gives the exact line for wallets with no names, null otherwise.
- [ ] **Step 2: Run** `npx vitest run src/lib/wizard/trial-deploy.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `pnpm typecheck && npx vitest run && pnpm build` — Expected: PASS, build succeeds.
- [ ] **Step 5: Commit** `feat(web): deploying connects the wallet and creates the Virvi account (Refs LIV-91)`.

### Task 9: Imports, scenes and headset pairing pages for guests

**Files:**
- Create: `apps/web/src/lib/trial-scene.ts`
- Modify: `apps/web/src/app/(dashboard)/scenes/page.tsx`, `apps/web/src/app/(dashboard)/scenes/[sceneId]/client.tsx`, `apps/web/src/app/(dashboard)/import/page.tsx`, `apps/web/src/app/pair/headset/[code]/client.tsx`
- Test: `apps/web/src/lib/trial-scene.test.ts`

**Interfaces:**
- Consumes: Tasks 1, 3, 4 routes; Task 7 copy.
- Produces:
  - `TRIAL_SCENE_TABS: readonly string[]` and `sceneTabLocked(tab: string, trial: boolean): boolean`: for a trial only the scene's name, presets and elements tabs are open; locked tabs show a lock and open the sheet (`nav:` action with the tab's label) and their data is never fetched.
  - `pairChoices(trial: boolean)`: `['personal']` for a trial, `['personal', 'shared']` otherwise. The pair page accepts a trial session (no sign-in redirect).
  - `importLimitNote(trial: boolean): string | null`: "Guests can import 2 scenes of up to 25 MB. Create a free account for more." for a trial.
  - Scenes list for a trial: its scenes with "Held for your trial — create an account to keep it", plus New scene and Import; no calls to account-only routes.

- [ ] **Step 1: Write the failing tests**: `sceneTabLocked` open for name/presets/elements, locked for roles, collaborators, destinations, hyperfy, streams, showings, schedules, ar; never locked for an account; `pairChoices(true)` is `['personal']`; `importLimitNote(true)` exact line, `importLimitNote(false)` null.
- [ ] **Step 2: Run** `npx vitest run src/lib/trial-scene.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `pnpm typecheck && npx vitest run && pnpm build` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(web): guests import, open their scenes and pair a headset (Refs LIV-91)`.

### Task 10: Demo views, and the docs

**Files:**
- Create: `apps/web/src/lib/demo/fixtures.ts`, `apps/web/src/lib/demo/store.ts`, `apps/web/src/components/DemoApi.tsx`, `apps/web/src/app/(dashboard)/demo/analytics/page.tsx`, `.../demo/events/page.tsx`, `.../demo/giveaways/page.tsx`
- Modify: `apps/web/src/lib/api.ts` (`useApi` overlay), `apps/docs/src/content/docs/getting-started/try-without-an-account.md`, `apps/docs/src/content/docs/self-hosting/environment-variables.md`
- Test: `apps/web/src/lib/demo/store.test.ts`

**Interfaces:**
- Produces:
  - `demoFixtures(now: number): DemoData`: the sample World (Global Constraints), 7 days of visits from a fixed seed (same `now` → same data), heatmap cells inside its parcels, 3 events on the sample scene, 1 giveaway with 3 items and 5 claims.
  - `createDemoApi(opts: { trialId: string; now: () => number; storage?: Storage }): DemoApi`: the `useApi()` methods the three pages call (`getAnalyticsLocations`, the Dashboard's summary, timeseries, heatmap, sessions and live reads, `getEvents`, `getEvent`, `createEvent`, `updateEvent`, `deleteEvent`, `linkSceneToEvent`, `unlinkSceneFromEvent`, `linkGiveawayToEvent`, `unlinkGiveawayFromEvent`, `getScenes`, `getGiveaways`, `getGiveaway`, `createGiveaway`, `updateGiveaway`, `deleteGiveaway`, `addGiveawayItem`, `deleteGiveawayItem`, `getGiveawayClaims`), with the same return shapes; writes persist under `virvi.demo.<trialId>`.
  - `<DemoApiProvider>`: `useApi()` inside it returns the real api with every method replaced by the demo one or, if it has none, a function rejecting `{ status: 403, body: { error: 'account_required', action: 'demo:<name>' } }` (which opens the sheet). The banner per Global Constraints.
  - Demo pages render the existing `Dashboard`, Events and Giveaways components inside the provider. Demo storage is removed on `trial_ended` and sign-out.

- [ ] **Step 1: Write the failing tests**: `fixtures are deterministic` (two calls with the same `now` deep-equal); `heatmap cells lie inside the sample parcels`; `creating an event persists and lists` (new `createDemoApi` on the same storage sees it); `a method the demo lacks rejects account_required with demo:<name>`; `the demo never calls fetch` (`vi.stubGlobal('fetch', spy)` through a full events and giveaways round → spy not called).
- [ ] **Step 2: Run** `npx vitest run src/lib/demo` — Expected: FAIL.
- [ ] **Step 3: Implement**; the docs page gains what guests can do in scenes, import, room scans and demos, the deploy-creates-account flow and the new `TRIAL_*` variables.
- [ ] **Step 4: Run** `pnpm typecheck && npx vitest run && pnpm build && pnpm --filter @virvixr/docs build` — Expected: PASS, both build.
- [ ] **Step 5: Commit** `feat(web): demo analytics, events and giveaways for guests; docs (Refs LIV-91)`.
