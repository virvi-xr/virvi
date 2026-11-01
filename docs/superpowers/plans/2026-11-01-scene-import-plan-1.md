# Scene Import, Plan 1 (upload → install → isolated build → World deploy → "what went live") Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A creator uploads a Decentraland SDK7 / Creator Hub scene folder on virvi.io; Virvi installs itself into it, builds it in an isolated build box, deploys it to the World named in its `scene.json`, links it to a Virvi scene with them as host, and offers the exact deployed files of any deploy as a download.

**Architecture:** The browser zips the folder (minus `node_modules`, `bin`, `.git`) and posts it raw. The server reads and validates the zip, edits it to install Virvi (`@virvixr/dcl` dependency, `void createVirvi()` in `main()`, HUD icon), stores it in a private store, and starts a one-shot Fly Machine from a separate, secret-free app whose egress is limited to the npm registry and Virvi's build endpoints. The box downloads the source with a per-build token, runs `npm install` and the SDK's production build, and uploads the deployable files and its log. The server then creates or updates the World's destination (`adopted: true`, so later HUD redeploys only add Virvi models), assembles the entity from the built files and deploys it through the existing sign / Virvi-signed paths. Every deploy (imports, wizard, redeploys) keeps its files content-addressed so "what went live" can be downloaded as a zip.

**Tech Stack:** Fastify + TypeScript + Drizzle + vitest (`apps/server`), Next.js static export + vitest (`apps/web`), `fflate` for zips (server and web), Fly Machines API (`apps/server/src/hyperfy/fly.ts`), a new `apps/scene-builder` image (Node 22, nftables + tinyproxy like `apps/studio-worker`).

**Spec:** `docs/superpowers/specs/2026-11-01-scene-import-design.md`. Plan 1 covers Goals 1, 2, 3 (Worlds), 5, 6 and the access / re-upload / downloads decisions. Plan 2 (Genesis City: browser signing and the operator grant, Goals 3–4 for parcels) and Plan 3 (the Virvi-free backup, Goal 7) follow; Plan 1 refuses a parcels scene with a clear "coming soon" error.

## Global Constraints

- Server: Fastify / TypeScript / Drizzle / vitest; web: Next.js `apps/web` (logic in `src/lib/*.ts` with `*.test.ts`; `.tsx` isn't unit-tested).
- New copy uses Virvi names; `node scripts/check-no-vlm.mjs` must report 0 hits.
- Billing code is off limits. Scene Import is open to every plan: no `requireFeature`, no plan checks.
- Existing World deploy paths (wizard, redeploys, sweep, grants) keep working; their tests stay green.
- Never print or log secrets. The build box gets no Virvi secret: only its own per-build token and two URLs.
- Anti-goals: no build reaching Virvi's secrets, DB, deploy key or other users' data; no deploy anywhere but the `scene.json` World the importer owns; no change to the creator's scene beyond installing Virvi.
- Server tests run against a per-worktree database: `export TEST_DATABASE_URL=postgres://vlm:vlm_dev@localhost:5432/vlm_test_scene_import` before every `npx vitest run` in `apps/server` (global setup drops and recreates the database it points at).
- Node: `export PATH=~/.nvm/versions/node/v22.23.3/bin:$PATH`. Schema changes apply through `drizzle-kit push` (no migration files).
- Every commit ends with the two trailer lines `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>` and `Claude-Session: https://claude.ai/code/session_018ds2NZXw5KLxDpVm9B3ABD`.

## Review Focus

1. **A zip of the folder itself** (everything under one top-level directory, as macOS "Compress" makes) must import like a zip of its contents. → Task 2 test `strips a single top-level folder`.
2. **Hostile paths in the upload** (`../`, absolute paths, symlink entries, `__MACOSX/`) must be refused or dropped, never written outside the scene. → Task 2 test `refuses paths that escape the scene`.
3. **A build box that dies, hangs or never reports** must end as `failed` with a plain message after 15 minutes, and its machine must be destroyed. → Task 5 test `a build silent for 15 minutes fails and its machine goes`.
4. **A second upload for the same World while one is building or deploying** must be refused, not race. → Task 6 test `refuses a second import for a World mid-import`.
5. **A World whose live scene was deployed outside Virvi** (Creator Hub, CLI) must be replaced by the import, not stopped at `needs_review`. → Task 7 test `an import replaces a scene deployed outside Virvi`.

---

### Task 1: Import table, private store and shared types

**Files:**
- Modify: `apps/server/src/db/schema.ts` (new enum + table, `dclWorldDestinations.pendingImportId`)
- Create: `apps/server/src/storage/private-store.ts`
- Modify: `apps/server/src/studio/store.ts` (re-export the generalised store; keep `getStudioStore`/`setStudioStore` working)
- Modify: `apps/server/src/config.ts` (`sceneImportS3Uri`)
- Create: `packages/shared/src/scene-import.ts`; Modify: `packages/shared/src/index.ts`
- Test: `apps/server/test/private-store.test.ts`

**Interfaces:**
- Produces (schema): enum `scene_import_status` = `'uploaded' | 'building' | 'built' | 'deploying' | 'awaiting_signature' | 'deployed' | 'failed'`; table `scene_imports` (`sceneImports`): `id uuid pk`, `user_id → users`, `scene_id → scenes (cascade)`, `world_name text`, `kind text ('creator-hub'|'sdk7')`, `status`, `error_code text null`, `error_message text null`, `source_key text`, `built_key_prefix text null`, `log_key text null`, `build_token_hash text null`, `machine_id text null`, `destination_id → dcl_world_destinations (set null)`, `deployment_id → scene_deployments (set null)`, `created_at`, `updated_at`, `built_at null`, `finished_at null`; index on `(world_name, status)`. Column `dcl_world_destinations.pending_import_id uuid null → scene_imports (set null)`.
- Produces (store): `interface PrivateStore { put(key, body: Buffer, contentType): Promise<void>; get(key): Promise<{ body: Buffer; contentType: string } | null>; putStream(key, body: Readable, length: number, contentType): Promise<void>; getStream(key): Promise<Readable | null>; deletePrefix(prefix): Promise<number> }`; `privateStoreFromUri(uri: string): PrivateStore` (`s3://…r2…` → R2, `file://` → local dir), `memoryPrivateStore(): PrivateStore & { keys(): string[] }`; `getImportStore(): PrivateStore` (from `config.sceneImportS3Uri`, env `SCENE_IMPORT_S3_URI`; falls back to `file://<LOCAL_STORAGE_PATH>/private` outside cloud mode) and `setImportStore(s: PrivateStore | null)`.
- Produces (shared): `type SceneImportStatus`, `interface SceneImportView { id; sceneId; worldName; kind; status; errorCode: string | null; errorMessage: string | null; deploymentId: string | null; destinationId: string | null; logTail: string | null; createdAt: string }`, `const SCENE_IMPORT_MAX_BYTES = 100 * 1024 * 1024`.

- [ ] **Step 1: Write the failing store test** `apps/server/test/private-store.test.ts`: `memoryPrivateStore` round-trips `put`/`get` and `putStream`/`getStream`; `deletePrefix('imports/a/')` removes only that prefix and returns the count; `privateStoreFromUri('file://<tmpdir>')` does the same on disk and refuses a key containing `..` (throws).
- [ ] **Step 2: Run it** — `cd apps/server && npx vitest run test/private-store.test.ts` — Expected: FAIL (module not found).
- [ ] **Step 3: Implement** `private-store.ts` by generalising `StudioStore`'s R2 / local / memory implementations (move the code, have `studio/store.ts` build its store with `privateStoreFromUri(config.studioS3Uri)` so studio behaviour is unchanged). Add the schema, config key and shared types.
- [ ] **Step 4: Run** the new test plus `test/studio-store.test.ts test/studio-uploads.test.ts` — Expected: PASS. Then `npx tsc --noEmit -p .` in `apps/server` and `packages/shared` — Expected: no errors.
- [ ] **Step 5: Commit** `feat(import): scene_imports table, private store, shared import types`.

### Task 2: Reading an uploaded scene zip

**Files:**
- Create: `apps/server/src/services/import/scene-zip.ts`
- Modify: `apps/server/package.json` (add `fflate` ^0.8.2)
- Test: `apps/server/test/import-scene-zip.test.ts`

**Interfaces:**
- Produces: `class ImportError extends Error { status: number; code: string }`; `interface SceneFolder { files: Map<string, Uint8Array>; sceneJson: Record<string, unknown>; kind: 'creator-hub' | 'sdk7'; location: { kind: 'world'; world: string; parcels: string[]; base: string } | { kind: 'parcels'; parcels: string[]; base: string } }`; `function readSceneZip(zip: Uint8Array): SceneFolder` (throws `ImportError`).
- Rules (pinned): paths use `/`, are relative, never contain `..` segments, absolute roots or drive letters → `ImportError(422, 'unsafe_path')`; entries under `__MACOSX/`, `.DS_Store`, `node_modules/`, `bin/`, `.git/` are dropped; if every entry shares one top-level folder and `scene.json` is not at the root, that folder is stripped; `scene.json` missing → `(422,'no_scene_json')`; unparsable → `(422,'bad_scene_json')`; `main` must be present and `runtimeVersion === '7'` or `ecs7 === true` → else `(422,'not_sdk7')`; more than 2000 files → `(413,'too_many_files')`; unzipped total > 300 MB → `(413,'too_big')`; not a zip → `(400,'not_a_zip')`. `kind` is `'creator-hub'` when `assets/scene/main.composite` exists, else `'sdk7'`. World name = `worldConfiguration.name` lower-cased, must end in `.eth` (else `(422,'bad_world_name')`); `parcels`/`base` from `scene.parcels`/`scene.base`.

- [ ] **Step 1: Write failing tests** (build zips in-test with `fflate.zipSync`): `reads a Creator Hub scene` (kind `creator-hub`, world `my.dcl.eth`, parcels/base from scene.json); `reads an SDK7 code scene` (kind `sdk7`); `strips a single top-level folder`; `drops node_modules, bin, .git and __MACOSX`; `refuses paths that escape the scene` (`../x`, `/etc/passwd` → `unsafe_path`); `refuses a zip without scene.json`, `with bad JSON`, `that isn't SDK7`, `that isn't a zip`; `a parcels scene reads as kind parcels` (no `worldConfiguration`); `too many files` → 413.
- [ ] **Step 2: Run** `npx vitest run test/import-scene-zip.test.ts` — Expected: FAIL (module not found).
- [ ] **Step 3: Implement** `readSceneZip` with `fflate.unzipSync` and the rules above.
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** `feat(import): read and validate an uploaded scene zip`.

### Task 3: Installing Virvi into the scene

**Files:**
- Create: `apps/server/src/services/import/install-virvi.ts`
- Test: `apps/server/test/import-install-virvi.test.ts`

**Interfaces:**
- Consumes: `SceneFolder` (Task 2); the HUD icon bytes from `runtimeFiles()` in `apps/server/src/services/dcl/runtime.ts` (`images/virvi/hud-v.png`).
- Produces: `const VIRVI_DCL_RANGE = '^2.4.0'`; `async function installVirvi(folder: SceneFolder): Promise<{ files: Map<string, Uint8Array>; changed: string[] }>` (throws `ImportError(422,'no_main')`).
- Rules (pinned): `package.json` → `dependencies['@virvixr/dcl'] = VIRVI_DCL_RANGE` (added, or raised when lower; JSON re-serialised with 2-space indent and a trailing newline); the main source file is `src/index.ts` (or `src/index.tsx`, `src/index.js`); its exported `main` function (`export function main(`, `export async function main(`, or `export const main = (`…`) =>`) gets `void createVirvi()` as the first statement of its body and `import { createVirvi } from '@virvixr/dcl'` at the top, unless the file already imports `createVirvi` (then unchanged); no `main` found → `no_main`; `images/virvi/hud-v.png` is written; `scene.json` is not edited; `changed` lists edited paths. Creator Hub projects get the same `src/index.ts` edit (no `main.composite` or `VirviManager.ts` changes, so Virvi starts once).

- [ ] **Step 1: Write failing tests**: `adds the dependency, the createVirvi call and the HUD icon`; `raises an older @virvixr/dcl`; `is idempotent` (second run changes nothing); `handles async and arrow main`; `a Creator Hub scene gets the same edit and no composite change`; `no main is no_main`; `leaves scene.json byte-for-byte`.
- [ ] **Step 2: Run** `npx vitest run test/import-install-virvi.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** with text edits (locate `main`'s opening `{` with a regex per form; no TypeScript parser dependency).
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** `feat(import): install Virvi into an uploaded scene`.

### Task 4: The scene-builder image

**Files:**
- Create: `apps/scene-builder/Dockerfile`, `apps/scene-builder/entrypoint.sh`, `apps/scene-builder/allowlist.txt`, `apps/scene-builder/tinyproxy.conf`, `apps/scene-builder/build.mjs`, `apps/scene-builder/lib.mjs`, `apps/scene-builder/package.json`, `apps/scene-builder/README.md`
- Test: `apps/scene-builder/test/lib.test.mjs` (`node --test`)

**Interfaces:**
- Consumes (env, nothing else): `BUILD_SOURCE_URL`, `BUILD_RESULT_URL`, `BUILD_FAILED_URL`, `BUILD_TOKEN` (sent as `Authorization: Bearer`), `VIRVI_API_HOST` (added to the allowlist at start).
- Produces (wire contract with Task 5): `GET BUILD_SOURCE_URL` → the source zip; on success `POST BUILD_RESULT_URL` with `Content-Type: application/zip` body = zip of the deployable files (paths relative to the scene root) and header `X-Build-Log: <base64 of the last 64 KB of the log>`; on failure `POST BUILD_FAILED_URL` with `Content-Type: text/plain` body = the last 64 KB of the log. Exit code 0 / 1.
- Produces (lib.mjs): `deployableFiles(root: string, dclignore: string | null): string[]` — every file under `root` except the SDK's default ignores (`node_modules`, `src`, `.git`, `*.ts` sources, `tsconfig.json`, `package-lock.json`, `.dclignore` itself, `README*`) and `.dclignore` patterns (gitignore syntax via the `ignore` package); always includes `scene.json` and the `main` file.

- [ ] **Step 1: Write failing tests** for `deployableFiles`: defaults drop `node_modules`, `src`, `tsconfig.json`; a `.dclignore` with `*.blend` and `docs/` drops those; `scene.json` and `bin/index.js` always stay.
- [ ] **Step 2: Run** `cd apps/scene-builder && node --test test/` — Expected: FAIL.
- [ ] **Step 3: Implement** `lib.mjs`, then `build.mjs`: download source → unzip into `/work/scene` → `npm install --no-audit --no-fund` (5-minute limit) → `npx sdk-commands build --production` (10-minute limit; `npm run build` when `package.json` has a `build` script and no `@dcl/sdk-commands`) → `deployableFiles` → zip → POST result; any error → POST failed with the log tail. `entrypoint.sh` and `tinyproxy.conf` follow `apps/studio-worker` (nftables output drop except loopback tinyproxy; `allowlist.txt` = `registry.npmjs.org`, `registry.yarnpkg.com`; `VIRVI_API_HOST` appended), run `build.mjs` as an unprivileged user. `Dockerfile`: `node:22-bookworm-slim` + nftables + tinyproxy. README: what the box can reach, how to build and push the image, `SCENE_BUILD_IMAGE`.
- [ ] **Step 4: Run** `node --test test/` — Expected: PASS. `docker build apps/scene-builder` if Docker is available (report if not).
- [ ] **Step 5: Commit** `feat(import): scene-builder image for isolated scene builds`.

### Task 5: Build runner, build endpoints and the build sweep

**Files:**
- Modify: `apps/server/src/hyperfy/fly.ts` (`createBuildMachine`)
- Create: `apps/server/src/services/import/build-runner.ts`, `apps/server/src/routes/import-build.ts`, `apps/server/src/services/import/build-sweep.ts`
- Modify: `apps/server/src/config.ts` (`SCENE_BUILD_RUNNER` = `'fly' | 'local' | 'off'`, `SCENE_BUILD_IMAGE`, `SCENE_BUILD_FLY_APP` default `virvi-scene-builds`, `SCENE_BUILD_FLY_TOKEN`), `apps/server/src/app.ts` (register routes), `apps/server/src/index.ts` (start sweep)
- Test: `apps/server/test/import-build.test.ts`, `apps/server/test/hyperfy-fly.test.ts` (add case)

**Interfaces:**
- Consumes: `sceneImports`, `getImportStore` (Task 1).
- Produces: `FlyApi.createBuildMachine(app: string, spec: { name: string; image: string; env: Record<string,string>; cpus: number; memoryMb: number }): Promise<{ id: string }>` (config `restart: { policy: 'no' }`, `auto_destroy: true`, `guest: { cpu_kind: 'performance', cpus, memory_mb }`, no services); `interface BuildRunner { start(importId: string, env: Record<string,string>): Promise<{ machineId: string }>; stop(machineId: string): Promise<void> }`; `getBuildRunner()` / `setBuildRunner(r: BuildRunner | null)`; `async function startBuild(importId: string): Promise<void>` (mints a 32-byte token, stores only its SHA-256 in `build_token_hash`, status `building`, starts the machine with `cpus: 2, memoryMb: 4096`); `onBuildDone: (importId: string) => Promise<void>` hook set by Task 7 (`setOnBuildDone`).
- Routes (bearer = the build token; `rateLimit: false`; not under scene pass): `GET /api/imports/build/:id/source` (streams `source_key`; 401 wrong/used token; 409 unless `building`), `POST /api/imports/build/:id/result` (raw `application/zip` ≤ 200 MB: unzip, store each file at `imports/<id>/built/<path>`, log from `X-Build-Log` at `imports/<id>/build.log`, status `built`, `built_at`, token cleared, then `onBuildDone(id)`), `POST /api/imports/build/:id/failed` (log stored, status `failed`, `error_code 'build_failed'`, `error_message 'The scene didn't build. The build log says why.'`, token cleared).
- Sweep: `sweepBuilds(now: Date)` fails `building` rows older than 15 minutes (`error_code 'build_timeout'`, message `The build took longer than 15 minutes and was stopped.`) and calls `runner.stop(machine_id)`; `startBuildSweep(ms = 60_000)`.
- `local` runner (dev only; refused when `config.mode === 'cloud'`) runs `apps/scene-builder/build.mjs` in a temp dir with the same env; `off` makes `POST /api/imports` answer 503 `builds_unavailable`.

- [ ] **Step 1: Write failing tests**: Fly `createBuildMachine` posts the pinned config (fake fetch, as `hyperfy-fly.test.ts`); `startBuild` stores only the token hash and passes no Virvi secret in `env` (assert keys are exactly `BUILD_SOURCE_URL, BUILD_RESULT_URL, BUILD_FAILED_URL, BUILD_TOKEN, VIRVI_API_HOST`); `source needs the build token` (401 without, 200 with); `result stores the built files and calls onBuildDone`; `failed stores the log and fails the import`; `a used token can't post twice`; `a build silent for 15 minutes fails and its machine goes`.
- [ ] **Step 2: Run** `npx vitest run test/import-build.test.ts test/hyperfy-fly.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** the above; register the raw-body parsers in a scoped plugin like `routes/studio.ts` (`removeAllContentTypeParsers`, `addContentTypeParser`). Add the new routes to `test/scene-pass-guard.test.ts`'s expectations if it lists unauthenticated routes.
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** `feat(import): build runner, build endpoints and timeout sweep`.

### Task 6: Import routes

**Files:**
- Create: `apps/server/src/routes/imports.ts`, `apps/server/src/services/import/imports.ts`
- Modify: `apps/server/src/routes/dcl-destinations.ts` (export `ownerFor`), `apps/server/src/app.ts`
- Test: `apps/server/test/import-routes.test.ts`

**Interfaces:**
- Consumes: `readSceneZip`, `ImportError` (Task 2), `installVirvi` (Task 3), `startBuild` (Task 5), `ownerFor(userId, world)` (exported), `getActiveSetup`, `getSceneAccess`/`isFullAccess`, `getImportStore`.
- Produces: `POST /api/imports` (auth; raw `application/zip` body ≤ `SCENE_IMPORT_MAX_BYTES`) → 201 `{ import: SceneImportView }`; `GET /api/imports/:id` → `{ import: SceneImportView }` (only its user, or full access on its scene); `GET /api/imports/:id/log` → `text/plain` full log; `GET /api/imports?sceneId=` → last 10 for a scene. `function importView(row, logTail): SceneImportView`.
- Rules (pinned): parcels scene → 422 `parcels_not_yet` with `Genesis City imports are coming soon. For now, import a scene whose scene.json names a World.`; the importer's verified wallet must own the World (`ownerFor` → 403 `not_world_owner`); which Virvi scene: (a) a destination already exists for the World → its scene, which needs the importer's full access else 409 `world_in_use`; (b) else an active setup at `world:<name>` → its Virvi scene, which needs full access else 409 `world_set_up_elsewhere`; (c) else a new scene named after `scene.json` `display.title` (or the World name) with a `Default` preset (as `POST /api/wizard/scenes` does), owned by the importer; an import for the same World in `uploaded|building|built|deploying|awaiting_signature` → 409 `import_in_progress`; the installed source is stored at `imports/<id>/source.zip`; then `startBuild(id)`.

- [ ] **Step 1: Write failing tests** (fake worlds client owners, `setBuildRunner` fake, `setImportStore(memoryPrivateStore())`): `imports a World scene: new Virvi scene, source stored with Virvi installed, build started`; `a re-upload keeps the World's Virvi scene`; `refuses a World the importer doesn't own`; `refuses a World set up under someone else's Virvi scene`, `allows it with full access`; `refuses a second import for a World mid-import`; `a parcels scene is parcels_not_yet`; `bad zips map to their ImportError`; `GET is the importer's only`; `the log route returns the stored log`.
- [ ] **Step 2: Run** `npx vitest run test/import-routes.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — Expected: PASS; also `test/dcl-destination-routes.test.ts` (the `ownerFor` export) — Expected: PASS.
- [ ] **Step 5: Commit** `feat(import): upload route, ownership and re-upload rules`.

### Task 7: Deploying an imported build

**Files:**
- Modify: `apps/server/src/services/dcl/assemble.ts` (`assembleImported`), `apps/server/src/services/dcl/world-deployer.ts` (imported branch, stored-file source kind, import limits), `apps/server/src/services/import/imports.ts` (`deployImport`, wired as `onBuildDone`)
- Test: `apps/server/test/import-deploy.test.ts`

**Interfaces:**
- Consumes: built files at `imports/<id>/built/<path>` (Task 5); `buildEntity`, `startVirviDeploy`, `prepareSignedDeploy`, `submitSignedDeploy`, `afterWorldDeploy`.
- Produces: `async function assembleImported(input: { files: Map<string, Uint8Array>; metadata: SceneMetadata; timestamp: number }): Promise<Assembled>` (`pointers = metadata.scene.parcels`, `existing: []`, `changed: true`, `refused: []`, `added: []`, `deployedFiles` = sorted lower-cased paths); `NewFileSource` gains `{ file: string; hash: string; storageKey: string }`, read back by `rebuildNewFiles` from `getImportStore()`; `async function deployImport(importId: string): Promise<void>`.
- Rules (pinned): `deployImport` upserts the World's destination (`world_name` unique): base/parcels from the built `scene.json`, `adopted: true`, `pending_import_id = importId`, `owner_wallet` from `ownerFor`, `mode` kept (new destinations `'sign'`); `assembleFor` takes the imported branch when `dest.pendingImportId` is set — it reads the built files, skips `liveBaseFor`'s `needs_review` check (an import replaces whatever is live) but records the live entity id as `baseEntityId`; before deploying, the files are checked against `dclBudget(parcels.length).files`, `DCL_MAX_FILE_BYTES` and `getWalletStats` space → `ImportError(413,'scene_too_big' | 'file_too_big' | 'world_storage_full')` with a sentence naming the limit; `mode 'virvi'` with a grant → `startVirviDeploy`, import `deploying`; otherwise → `prepareSignedDeploy`, import `awaiting_signature` (the web signs through the existing `POST /api/deploy/:id/signature`); `afterWorldDeploy` clears `pending_import_id` and the import becomes `deployed` (or `failed` with the deployment's `errorMessage`). Later HUD redeploys use the existing adopted path unchanged.

- [ ] **Step 1: Write failing tests**: `assembleImported builds an entity over exactly the built files`; `a granted World deploys the import Virvi-signed and links the World to the Virvi scene`; `an ungranted World waits for the owner's signature, then deploys` (sign with `createUnsafeIdentity`, as `dcl-destination-routes.test.ts`); `an import replaces a scene deployed outside Virvi`; `a scene over the World's file budget fails with scene_too_big`; `after an import, a HUD-placed model redeploys only models/virvi files` (existing adopted path); `a failed upload fails the import with the deploy's message`.
- [ ] **Step 2: Run** `npx vitest run test/import-deploy.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the new file plus `test/world-deployer.test.ts test/dcl-assemble.test.ts test/redeploy-sweep.test.ts test/dcl-destination-routes.test.ts` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(import): deploy imported builds to the World`.

### Task 8: Keeping and downloading what went live

**Files:**
- Modify: `apps/server/src/services/dcl/world-deployer.ts` (`afterWorldDeploy` keeps files; `assetBundle.content`)
- Create: `apps/server/src/services/dcl/deployed-files.ts`
- Modify: `apps/server/src/routes/deploy.ts` (download route)
- Test: `apps/server/test/deployed-files.test.ts`

**Interfaces:**
- Consumes: the bytes handed to `getWorldsClient().deploy` (`files: Map<hash, bytes>`), `deploymentForCaller(request, id, 'read')`.
- Produces: `async function keepDeployedFiles(content: ContentRef[], files: Map<string, Uint8Array>): Promise<void>` (writes each new hash to `deployed/<hash>` in `getImportStore()`, skipping hashes already stored); `assetBundle.content: ContentRef[]` on every deployed `scene_deployments` row; `GET /api/deploy/:id/files.zip` → `application/zip`, `Content-Disposition: attachment; filename="<world>-<YYYYMMDD-HHmm>.zip"`, built by streaming each `content` entry from `deployed/<hash>`, else from `{worldsUrl}/contents/<hash>`; any file missing from both → 409 `files_gone` (`Some of this deploy's files are no longer stored anywhere, so it can't be downloaded.`); a deployment without `content` (older rows) falls back to the live entity's content when its id equals `catalystEntityId`, else `files_gone`.

- [ ] **Step 1: Write failing tests**: `a Virvi-signed deploy keeps its files and lists its content`; `the download zips exactly the deployed files under their paths`; `files no longer stored come from the Worlds server`; `a file gone everywhere is files_gone`; `only people who can read the deployment can download it`.
- [ ] **Step 2: Run** `npx vitest run test/deployed-files.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** with `fflate.Zip` streaming into the reply.
- [ ] **Step 4: Run** it plus `test/world-deployer.test.ts` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(deploy): keep every deploy's files and download what went live`.

### Task 9: The Import page

**Files:**
- Create: `apps/web/src/app/(dashboard)/import/page.tsx`, `apps/web/src/lib/import-zip.ts`, `apps/web/src/lib/import.ts`
- Modify: `apps/web/src/lib/api.ts` (`uploadSceneImport`, `getSceneImport`, `getSceneImportLog`, `downloadDeployFiles`), `apps/web/src/app/(dashboard)/layout.tsx` (nav item "Import" after "Scenes"), `apps/web/src/components/dcl/WorldDestinationCard.tsx` ("Download what went live" on the last deploy), `apps/web/package.json` (`fflate` ^0.8.2)
- Test: `apps/web/src/lib/import-zip.test.ts`, `apps/web/src/lib/import.test.ts`

**Interfaces:**
- Consumes: `SceneImportView` (Task 1), the routes from Tasks 6–8, `useWorldSigning` / `submitDeploySignature` for `awaiting_signature`.
- Produces: `zipSceneFiles(files: { path: string; bytes: Uint8Array }[]): Uint8Array` (drops `node_modules/`, `bin/`, `.git/`, `.DS_Store`; keeps relative paths from a folder picker's `webkitRelativePath`); `importPhase(v: SceneImportView): 'uploading' | 'building' | 'deploying' | 'sign' | 'live' | 'failed'`; `importErrorMessage(code: string): string` (one sentence per `ImportError` code from Tasks 2, 5, 6, 7); `watchImport(id, { api, sleep, cancelled }, on)` polling `GET /api/imports/:id` every 2 s, as `watchDeployment`.
- Page: pick a folder (`<input webkitdirectory>`) or a `.zip` → zip in the browser → upload → show the World it will deploy to and the phases; on `sign` show "Sign the deploy" (wallet) using the import's `deploymentId`; on `live` show "Jump in" (`jumpInUrl(world)`) and "Download what went live"; on `failed` show the message and the build log (`GET /api/imports/:id/log`) in a scrollable `<pre>`.

- [ ] **Step 1: Write failing tests**: `zipSceneFiles drops node_modules, bin and .git and keeps paths`; `importPhase maps every status`; `importErrorMessage has a sentence for every code` (list the codes); `watchImport stops at deployed and at failed`.
- [ ] **Step 2: Run** `cd apps/web && npx vitest run src/lib/import-zip.test.ts src/lib/import.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** the libs, api functions, page, nav item and the card's download button.
- [ ] **Step 4: Run** the web suite `npx vitest run` and `npx tsc --noEmit` in `apps/web` — Expected: PASS / no errors.
- [ ] **Step 5: Commit** `feat(web): Import page, build log and what-went-live downloads`.

### Task 10: Rollout notes and full verification

**Files:**
- Modify: `apps/server/.env.example` (or the repo's env docs) with `SCENE_IMPORT_S3_URI`, `SCENE_BUILD_RUNNER`, `SCENE_BUILD_IMAGE`, `SCENE_BUILD_FLY_APP`, `SCENE_BUILD_FLY_TOKEN`
- Create: `docs/scene-import-rollout.md` — the owner-run steps: create the Fly app `virvi-scene-builds` in its own org with a token scoped to it, build and push `apps/scene-builder`, set the env vars on `virvi-server`, create the private R2 bucket; nothing here is done by the implementer.

- [ ] **Step 1:** Write the env docs and the rollout note.
- [ ] **Step 2:** Run everything: `apps/server` `npx vitest run` (with the per-worktree `TEST_DATABASE_URL`), `npx tsc --noEmit -p .`; `apps/web` `npx vitest run` and `npx tsc --noEmit`; `apps/scene-builder` `node --test test/`; `node scripts/check-no-vlm.mjs`. Expected: all green, 0 hits. Report any failure by name.
- [ ] **Step 3: Commit** `docs(import): rollout steps and env`.
