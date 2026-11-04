# Scene Import, Plan 3 (the Virvi-free backup) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** From any Decentraland scene in Virvi, the creator can download a ready-to-deploy SDK7 project with no Virvi installed. Everything placed through Virvi is baked in as plain Decentraland code: models, images, video screens, sounds, and ad spaces as empty slots. Positions, rotations, scales and settings are exact, and the asset files are bundled where their licence allows. This works for imported scenes (their own scene plus the baked content) and for scenes Virvi built itself (the baked content alone).

**Architecture:** On request, the server:
- snapshots the scene's **live preset** through `serializePreset`;
- classifies every asset URL the preset uses as *bundle* (Virvi-hosted creator uploads, room sets, Studio pieces, MIT catalog packs), *reference* (catalog packs whose licence doesn't clearly allow redistribution) or *link* (outside URLs and live streams);
- generates one TypeScript module, `src/virvi-baked.ts`, that recreates the content with SDK7 components the way the Virvi runtime renders it;
- streams a zip.

**Which project the module goes into**
- **Imported scenes:** the creator's original upload, Virvi-free, plus one `bakeVirviContent()` call in `main()`.
  - Plan 1 only kept the zip after Virvi was installed. From now on the **original** upload is kept.
  - Older imports have Virvi's three edits reversed.
- **Virvi-built scenes:** the `dcl-runtime/` project template with the `virvi` block removed.

**Tech Stack:** Fastify + TypeScript + Drizzle + vitest (`apps/server`), fflate streaming zips (as `deployed-files.ts`), `@dcl/sdk` 7.30.1 (the `dcl-runtime/` version) as the generated code's target, Next.js + vitest (`apps/web`).

**Spec:** `docs/superpowers/specs/2026-11-01-scene-import-design.md`: Goal 7, plus the decisions "Ad spaces in the backup" and "Licensed assets in the backup".

## Rulings made while planning (the owner can overturn)

- **R1: Click events aren't baked.** Virvi stores them but its Decentraland runtime doesn't act on them today, so the backup reproduces what visitors see now. Baking them would be new behaviour. The README lists elements that carry a click event.
- **R2: Model collisions use the model's own meshes.** `GltfContainer` gets `visibleMeshesCollisionMask: CL_PHYSICS | CL_POINTER` when `withCollisions`. The live runtime adds a flat *plane* collider instead, which is a bug, logged as a follow-up. Copying that bug into a permanent backup would bake it in.
- **R3: Only the live preset is baked.** It's what visitors see. Other presets are listed in the README by name.
- **R4: Playback in the backup**
  - Video playlists keep playing in order, using a small system in the generated module.
  - A screen in ads mode bakes as its "off" image if it has one, otherwise a blank plane.
  - A screen that's live at download time bakes its live stream URL as a link, with a README warning that the stream may end.
  - A sound bakes with its loop/clip setting. A clip doesn't autoplay, as today.
- **R5: Size cap.** Bundled files are capped at **500 MB per backup**. Over the cap, the download is refused with `413 backup_too_big`, naming the largest files.
- **R6: Access.** The backup needs the same access as the "what went live" download (`deploymentForCaller(…, 'read')`, i.e. `scene.edit`).
- **R7: Original uploads are kept** for the newest deployed import of each scene, for as long as the scene exists. Other imports' originals follow the 30-day retention, as `source.zip` does today.

## Global Constraints

- **Stack:** server is Fastify / TypeScript / Drizzle / vitest. In the web, logic goes in `src/lib/*.ts` with `*.test.ts`.
- **Copy:** new copy uses Virvi names; `node scripts/check-no-vlm.mjs` reports 0 hits. The generated project must contain no `virvi` import, dependency or `createVirvi` call (the `virvi-baked.ts` file name and README wording are fine).
- **Billing:** billing code is off limits; the backup is on every plan.
- **Ad spaces:** baked as empty slots (plane at the ad shape's aspect, with the space's own `fallbackImageSrc` if set). The current advertiser's creative is never included.
- **Licensed assets:**
  - Bundled: creator uploads and MIT catalog items (with `ATTRIBUTION.md` carrying each MIT pack's `attribution` text).
  - Referenced, never bundled: `cc-by-nc-3.0` and `unstated` packs. The code points at the local path the file would have, and `MISSING-ASSETS.md` gives each one's source URL (pack `sourceUrl` + `catalog/tags/<source>.json` `file`).
- **Fetching:** asset fetches go through `defaultModelFetcher`-style guards: Virvi-hosted only, `assertPublicHttpUrl`, per-type size caps, failures reported in the README rather than aborting.
- **Tests and tools:** server tests with `TEST_DATABASE_URL=postgres://vlm:vlm_dev@localhost:5432/vlm_test_scene_import_3`. Node 22 PATH as in Plan 2.
- **Commits** end with the two trailer lines from Plan 2 and say `Refs LIV-24`.

## Review Focus

1. **A creator's `main()` that's `async`, exported as `export async function main`, or in `src/index.tsx`** must still get exactly one `bakeVirviContent()` call. → Task 4 test `adds the call to every main() form install-virvi accepts`.
2. **An imported scene whose creator code already used Virvi** (`virviAlreadyPresent`) can't be cleanly un-installed. The backup must still produce a project, with the README naming the files that still import `@virvixr/dcl`. → Task 1 test `reports the creator's own Virvi code it can't remove`.
3. **Two elements whose files share a basename** (`chair.glb` from two packs) must not overwrite each other in the zip. → Task 3 test `distinct files with the same name get distinct paths`.
4. **A preset with nothing placed** must still give a deployable project (the creator's scene, or an empty template). → Task 4 test `an empty live preset`.
5. **Transforms with non-default parents or negative scales** must bake exactly as stored. The parent is ignored, as the runtime does today. → Task 2 test `bakes transforms exactly as stored`.

---

### Task 1: Keep the original upload, and un-install Virvi when the original is gone

**Files:**
- Modify: `apps/server/src/routes/imports.ts` (store `imports/<id>/original.zip` before `installVirvi`).
- Modify: `apps/server/src/services/import/retention.ts` (R7).
- Modify: `apps/server/src/db/schema.ts` (`scene_imports.original_key text null`).
- Create: `apps/server/src/services/import/uninstall-virvi.ts`.
- Test: `apps/server/test/import-uninstall-virvi.test.ts`, `apps/server/test/import-retention.test.ts` (extend).

**Interfaces:**
- `originalKey(importId)` gives `imports/<id>/original.zip`.
- `uninstallVirvi(files: Map<string, Uint8Array>): { files; leftovers: string[] }`. It is the exact reverse of `installVirvi`'s three edits:
  - the `@virvixr/dcl` dependency;
  - the `import { createVirvi } from '@virvixr/dcl'` line and `void createVirvi()`;
  - `images/virvi/hud-v.png`.

  It also removes `assets/scene/Scripts/VirviManager.ts`, `models/virvi/.virvi-sync.json` and `models/virvi/` files no element uses. `leftovers` lists files that still import `@virvixr/dcl` (the creator's own Virvi code).
- `sceneSourceFor(sceneId): Promise<{ files; leftovers; origin: 'original' | 'uninstalled' | 'none' }>`. It uses the newest **deployed** import of the scene: `original.zip`, else `source.zip` un-installed, else `none`.

- [ ] **Step 1: Write failing tests:**
  - `installVirvi` then `uninstallVirvi` round-trips each fixture from `import-install-virvi.test.ts` byte-for-byte, for both SDK7 and Creator Hub;
  - `reports the creator's own Virvi code it can't remove`;
  - an upload stores `original.zip` equal to the uploaded bytes;
  - retention keeps the newest deployed import's original and deletes other originals after 30 days.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the new tests plus `test/import-*.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(import): keep the original upload; un-install Virvi from older imports (Refs LIV-24)`.

### Task 2: Snapshot the live preset and classify its assets

**Files:**
- Create: `apps/server/src/services/backup/snapshot.ts`.
- Test: `apps/server/test/backup-snapshot.test.ts`.

**Interfaces:**
- **Types:**

  ```ts
  type AssetUse = 'model' | 'texture' | 'video' | 'audio'
  type AssetPlan =
    | { kind: 'bundle'; url: string; path: string; use: AssetUse; attribution?: { pack: string; text: string } }
    | { kind: 'reference'; url: string; path: string; use: AssetUse; pack: string; license: string; sourceUrl: string }
    | { kind: 'link'; url: string; use: AssetUse }
  interface BakedItem {
    type: 'model' | 'image' | 'video' | 'sound' | 'ad_space'
    name: string
    position: Vec3; rotation: Vec3; scale: Vec3
    withCollisions: boolean
    props: Record<string, unknown>
    assets: Record<string, AssetPlan>
  }
  interface BackupSnapshot {
    sceneName: string
    presetName: string
    otherPresets: string[]
    items: BakedItem[]
    skipped: { name: string; type: string; why: string }[]
    withClickEvents: string[]
  }
  ```

- **`backupSnapshot(sceneId): Promise<BackupSnapshot>`:**
  - Reads the active preset through `serializePreset`. Disabled elements and instances are skipped; nft, widget and claim-point elements go in `skipped`: "not shown in Decentraland by Virvi today".
  - Classifies each URL:
    - exact match on `media_assets.publicUrl`, or a library item with `packId` null, or `room_sets.glbUrl` → bundle;
    - catalog item with an MIT pack → bundle with attribution;
    - other packs → reference;
    - anything else (not Virvi-hosted, or a live stream) → link. Models can't be links, since SDK7 loads models only from scene files; a non-Virvi model goes in `skipped`.
  - Paths: `models/<basename>.glb`, `images/…`, `videos/…`, `sounds/…`. On a basename clash, the second and later files get `-2`, `-3`, … before the extension.
- **Live state:** the snapshot applies `withLiveStatus` so a live screen's `liveSrc` is known (R4).

- [ ] **Step 1: Write failing tests** against a seeded scene (factories as in `deployed-files.test.ts`):
  - `bakes transforms exactly as stored` (including a negative scale, and a `parentInstanceId` ignored);
  - `only the live preset`;
  - `disabled elements and instances are left out`;
  - `classifies uploads, MIT, NC/unstated catalog items and outside URLs`;
  - `distinct files with the same name get distinct paths`;
  - `a non-Virvi model is skipped with a reason`;
  - `elements with click events are listed`.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(backup): snapshot the live preset and classify its assets (Refs LIV-24)`.

### Task 3: Generate the SDK7 module

**Files:**
- Create: `apps/server/src/services/backup/bake-code.ts`.
- Test: `apps/server/test/backup-bake-code.test.ts`.

**Interfaces:**
- **`bakeModule(snap: BackupSnapshot): string`:** the source of `src/virvi-baked.ts`, exporting `export function bakeVirviContent(): void`. Its imports come only from `@dcl/sdk/ecs` and `@dcl/sdk/math`. For each item, it mirrors `DclAdapter`:
  - **Transform:** `Transform.create(e, { position: Vector3.create(…), rotation: Quaternion.fromEulerDegrees(…), scale: Vector3.create(…) })`.
  - **model:** `GltfContainer.create(e, { src: '<path>', …(withCollisions ? { visibleMeshesCollisionMask: ColliderLayer.CL_PHYSICS | ColliderLayer.CL_POINTER } : {}) })` (R2).
  - **image:**
    - `MeshRenderer.setPlane(e, <the doubled UVs from DclAdapter>)`;
    - `Material.setPbrMaterial(e, { texture: Material.Texture.Common({ src }), emissiveTexture: same, emissiveIntensity: emission ?? 0, emissiveColor: Color4.White(), roughness: 1, metallic: 0, specularIntensity: 0, transparencyMode: isTransparent ? 2 : 0 })`;
    - `MeshCollider.setBox` when `withCollisions`.
  - **video:**
    - a plane, plus a separate player entity with `VideoPlayer.create(player, { src, playing: true, volume: volume/100, loop })` and `Material.Texture.Video({ videoPlayerEntity: player })`;
    - a playlist of 2 or more items registers one `engine.addSystem` that listens to `videoEventsSystem` / `VideoEvent` for end-of-video and advances, as `DclAdapter` lines 408–447 do;
    - IMAGE off-mode becomes an image plane, and ads mode follows R4.
  - **sound:** `AudioSource.create(e, { audioClipUrl, playing: loop, loop, volume: volume/100 })`.
  - **ad_space:** a plane with `scale.y = scale.x * HEIGHT_PER_WIDTH[shape]` (reuse the constant from `packages/core/src/ads/slot.ts`). It's textured with `fallbackImageSrc` when bundled or linked, otherwise a plain dark material.
- **Output:** deterministic (stable order, two-space indent). Every string goes through `JSON.stringify`, so names and URLs can't break out of literals.

- [ ] **Step 1: Write failing tests:**
  - one item of each type produces the expected component calls (assert substrings);
  - `strings are escaped` (a name containing `'); engine.removeEntity(` stays inside a literal);
  - `no Virvi imports in the output`;
  - `a playlist of one item loops without the advance system`;
  - `an ad space gets the shape's aspect and never an ad creative`;
  - the output compiles: run `tsc --noEmit` against `dcl-runtime/node_modules/@dcl/sdk` types on a fixture project written to a temp dir (skip with a clear message if `dcl-runtime/node_modules` is absent; Step 4 installs it once).
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** (after `cd dcl-runtime && npm ci` if needed). Expected: PASS, including the compile check.
- [ ] **Step 5: Commit** `feat(backup): generate the SDK7 module that recreates Virvi's content (Refs LIV-24)`.

### Task 4: Assemble the backup project

**Files:**
- Create: `apps/server/src/services/backup/project.ts`.
- Test: `apps/server/test/backup-project.test.ts`.

**Interfaces:**
- **`backupProject(sceneId, opts: { fetch?: ModelFetcher }): Promise<{ files: Map<string, Uint8Array>; problems: string[] }>`:**
  - **Imported** (`sceneSourceFor` origin ≠ `none`):
    - the creator's files;
    - `src/virvi-baked.ts`;
    - one `import { bakeVirviContent } from './virvi-baked'` plus `bakeVirviContent()` as the first statement of `main()`, using the same locator as `install-virvi.ts`'s `withCreateVirvi`;
    - the `virvi` key is dropped from `scene.json`.
  - **Virvi-built:**
    - `dcl-runtime/`'s `package.json`, `tsconfig.json` and `scene.json` (title from the scene; parcels, base and `worldConfiguration` from the scene's destination; no `virvi` block);
    - a generated `src/index.ts` whose `main()` calls `bakeVirviContent()`.
  - **Both:**
    - the bundled assets, fetched with per-type caps;
    - `README.md`: how to deploy (`npm install`, `npx @dcl/sdk-commands deploy` or Creator Hub), what was baked, R1/R3/R4 notes, `skipped`, `leftovers`, fetch problems;
    - `ATTRIBUTION.md` when any MIT item is bundled;
    - `MISSING-ASSETS.md` when anything is referenced.
- **`BackupError(413, 'backup_too_big', message)`** over 500 MB (R5).

- [ ] **Step 1: Write failing tests:**
  - `an imported scene keeps its own code and gains one call`;
  - `adds the call to every main() form install-virvi accepts`;
  - `a Virvi-built World gets the template with no virvi block`;
  - `an empty live preset`;
  - `a referenced asset is listed with its source URL and not bundled`;
  - `a failed asset fetch is reported, not fatal`;
  - `over 500 MB is refused`.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(backup): assemble a ready-to-deploy project without Virvi (Refs LIV-24)`.

### Task 5: The download route

**Files:**
- Modify: `apps/server/src/routes/deploy.ts` (or a new `routes/backup.ts` registered alongside it).
- Modify: `test/cross-account-walk.test.ts`.
- Test: `apps/server/test/backup-route.test.ts`.

**Interfaces:**
- `GET /api/scenes/:sceneId/backup.zip`:
  - access as R6; `Content-Type: application/zip`;
  - `Content-Disposition: attachment; filename="<filenameSafe(scene name)>-backup-<utcStamp>.zip"`; `Cache-Control: private, no-store`;
  - streamed with the `zipEntries` pattern from `deployed-files.ts`, which errors out rather than sending a truncated zip;
  - `404` for an unknown scene; `403` without access; `413 backup_too_big`;
  - `422 not_decentraland` for a scene with no Decentraland destination or import.

- [ ] **Step 1: Write failing tests:** the zip unzips to the project from Task 4; the headers; 403 for a viewer and a stranger; 404; 413; the route is added to the cross-account walk.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the new test plus `test/cross-account-walk.test.ts test/deployed-files.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(backup): download a Virvi-free backup of a scene (Refs LIV-24)`.

### Task 6: Web button, docs and checks

**Files:**
- Create: `apps/web/src/components/dcl/DownloadBackupButton.tsx`.
- Modify: `apps/web/src/lib/api.ts` (`downloadSceneBackup`).
- Create: `apps/web/src/lib/backup.ts` (+ `.test.ts`: `backupErrorMessage`).
- Modify: the import page and `WorldDestinationCard.tsx` (the button beside "Download what went live").
- Modify: docs (the import guide: "Your backup without Virvi").

- [ ] **Step 1: Write a failing lib test** for `backupErrorMessage` (too big names the files; `not_decentraland`; a network error).
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement** the button (blob download with the server's filename, as `DownloadLiveButton`), its placements and the docs.
- [ ] **Step 4: Run** web `pnpm typecheck && npx vitest run`, `node scripts/check-no-vlm.mjs`, and the full server suite in the background. Expected: all green, 0 hits.
- [ ] **Step 5: Manual check (once):**
  - Download the backup of a test scene.
  - Run `npm install && npx @dcl/sdk-commands build` in it.
  - Confirm with `npx @dcl/sdk-commands start` that the baked content shows where it does in-world.
  - Note the result in the ledger.
- [ ] **Step 6: Commit** `feat(web): Download backup (no Virvi) beside the live-files download (Refs LIV-24)`.

## Follow-ups (not in this plan)

- The live runtime's plane collider on models (R2) is a bug to fix in `DclAdapter.setCollider`; that needs a connector release.
- Click events in the live runtime (R1).
