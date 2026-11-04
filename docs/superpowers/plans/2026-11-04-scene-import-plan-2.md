# Scene Import, Plan 2 (Genesis City parcels: browser signing, operator grant, Aetheria) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An imported scene whose `scene.json` has no `worldConfiguration` deploys to its Genesis City parcels. By default the parcel owner or a wallet with deploy rights signs each deploy in the browser. Optionally, the owner sends a one-time on-chain transaction that makes Virvi's dedicated Genesis City wallet an update operator, so Virvi can redeploy without a pop-up. Parcels in the Aetheria district never get the operator option.

**Architecture:** World destinations become *destinations* with a `kind` (`world` | `parcels`). The deployer keeps its one code path (assemble → sign → deploy → after-deploy → reconcile), but the content server it talks to comes from the destination:
- the Worlds server for `world`;
- a new `CatalystClient` (POST `{catalystUrl}/content/entities`) for `parcels`.

Who controls the parcels comes from the catalyst lambda `/lambdas/parcels/{x}/{y}/operators`, which already resolves estate owners (`getParcelRights`). Estate ids come from the land-manager subgraph. The operator grant is built on the server as `{to, data}` transactions (ethers `Interface`) and sent from the browser with `eth_sendTransaction`. It's confirmed by reading the rights back, never by trusting the client.

**Tech Stack:** Fastify + TypeScript + Drizzle + vitest (`apps/server`), Next.js + vitest (`apps/web`), ethers 6 (server only), raw EIP-1193 in the web (as `dcl-sign.ts`).

**Spec:** `docs/superpowers/specs/2026-11-01-scene-import-design.md`. This plan covers:
- Goals 3–4 for parcels and Goal 5 for parcel scenes;
- the "Genesis City operator key" decision;
- the Aetheria rule from LIV-24 ("never offer Virvi redeploy for a location managed by an Aetheria deed").

Plan 1 (Worlds) is live.

## Facts checked on 2026-11-04 (read-only calls)

**Who controls a parcel**
- `GET https://peer.decentraland.org/lambdas/parcels/108/105/operators` returns `{owner, operator, updateOperator, updateManagers[], approvedForAll[]}`.
- For a parcel inside an estate, `owner` is the **estate's** owner, not the EstateRegistry contract.
- Decentraland's access rule: a wallet may deploy to a parcel if it is the owner, operator, update operator or an update manager, or is approved for all.

**Estate ids**
- `POST https://subgraph.decentraland.org/land-manager` with `{ parcels(where:{x:"108",y:"105"}) { estate { id } } }` returns the estate id.

**Aetheria**
- The district is estate **2092**, owned by `0x2981aa7d75eaa42b248e304e378c7139868d4776`.
- Each parcel's `updateOperator` is set to its deed holder. Places shows "Aetheria …" at 108,105, 163,101–104, 120,120 and 140,90; all are in estate 2092.

**Registries (mainnet)**
- LANDRegistry is `0xf87e31492faf9a91b02ee0deaad50d51d56d5d4d`: `setUpdateOperator(uint256 assetId, address operator)` and `setManyUpdateOperator(uint256[] assetIds, address operator)`.
- EstateRegistry is `0x959e104e1a4db6317fa58f8295f586e1a978c297`: `setUpdateOperator(uint256 estateId, address operator)`.
- Only the owner, an operator or an approved-for-all wallet may call these; an update operator can't.
- LAND asset id = `(BigInt.asUintN(128, x) << 128n) | BigInt.asUintN(128, y)`.

## Global Constraints

- **Stack:** server is Fastify / TypeScript / Drizzle / vitest. In the web, logic goes in `src/lib/*.ts` with `*.test.ts`; `.tsx` isn't unit-tested.
- **Copy:** new copy uses Virvi names; `node scripts/check-no-vlm.mjs` reports 0 hits.
- **Billing:** billing code is off limits. Scene Import is on every plan, with no plan checks.
- **Worlds keep working:** every existing World path (wizard, imports, redeploys, sweep, grants) keeps working, and their tests stay green unchanged except for mechanical renames.
- **Secrets:** never print or log secrets. The build box gets none.
- **Separate keys:**
  - The Genesis City deploy key is `VIRVI_DCL_PARCEL_DEPLOY_KEY`, separate from `VIRVI_DCL_DEPLOY_KEY`.
  - When it's unset, the operator option is hidden (`grantAvailable: false`) and browser signing still works.
  - Claude never sets Railway secrets; the owner does.
- **Where it deploys:** only to the parcels in the scene's `scene.json`, and only when a verified wallet of the importer controls **every** parcel.
- **Tests and tools:**
  - Server tests: `export TEST_DATABASE_URL=postgres://vlm:vlm_dev@localhost:5432/vlm_test_scene_import_2` before every `npx vitest run` in `apps/server`.
  - Node: `export PATH=~/.nvm/versions/node/v22.23.3/bin:$PATH`. Schema through `drizzle-kit push`.
- **Commits** end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` and `Claude-Session: https://claude.ai/code/session_018ds2NZXw5KLxDpVm9B3ABD`, and say `Refs LIV-24`.

## Review Focus

1. **A wallet that controls some parcels but not all** must be refused at upload (`403 not_parcel_controller`, naming the first parcel it doesn't control), and again at signing. → Task 4 test `refuses an importer who controls only some parcels`, and Task 5 test `a signature from a wallet that lost a parcel is refused`.
2. **Parcels whose live scene was deployed outside Virvi** must be replaced by the import, as Worlds are (`adopted`). → Task 5 test `an import replaces a parcel scene deployed outside Virvi`.
3. **An operator grant the owner revokes on-chain later** must turn the next Virvi deploy into a clear "sign in the browser" state, not a loop of failures. → Task 6 test `a revoked grant falls back to browser signing`.
4. **Aetheria parcels** must never get the operator option, from the API or the UI. → Task 6 test `refuses the operator grant for Aetheria parcels`; Task 7 lib test.
5. **Two uploads for overlapping parcels** (same base, or different bases sharing a parcel) must not race. → Task 4 test `refuses a second import for overlapping parcels mid-import`.

---

### Task 1: Destinations and imports get a location kind

**Files:**
- Modify: `apps/server/src/db/schema.ts`.
- Modify: `packages/shared/src/scene-import.ts`.
- Modify: `apps/server/src/services/import/imports.ts`.
- Test: `apps/server/test/import-location.test.ts`.

**Interfaces:**
- **Schema:**
  - New enum `dcl_destination_kind = 'world' | 'parcels'`.
  - `dcl_world_destinations.kind` (notNull, default `'world'`).
  - `world_name` becomes nullable (it stays unique; Postgres treats nulls as distinct).
  - A partial unique index `dcl_destinations_parcels_base` on `(base) WHERE kind = 'parcels'`.
  - `scene_imports.world_name` becomes nullable.
  - New `scene_imports.location_kind` (`dcl_destination_kind`, default `'world'`), `scene_imports.base text null` and `scene_imports.parcels text[] not null default '{}'`.
- **Shared:** `type ImportLocation = { kind: 'world'; world: string } | { kind: 'parcels'; base: string; parcels: string[] }`. `SceneImportView` gains `location: ImportLocation`; `worldName` stays and is null for parcels.
- **`imports.ts`:**
  - `locationKeyOf(loc: ImportLocation): string` gives `world:<name>` or `gc:<base>`.
  - The advisory lock and `latestImportFor` take an `ImportLocation`.
  - Parcel locations lock **every parcel**: one `pg_advisory_xact_lock(hashtext('scene-import:gc:' || p))` per parcel, in sorted order, so overlapping footprints serialise.
  - `BLOCKING` for parcels means any import in a blocking status whose `parcels && $parcels`.

- [ ] **Step 1: Write failing tests:**
  - `importView` reports `location` for World and parcel rows;
  - `locationKeyOf` gives both key forms;
  - `createImport` for parcels `['0,0','0,1']` while another import over `['0,1','0,2']` is `building` → `ImportError(409,'import_in_progress')`;
  - the same parcels after the other import `failed` → allowed.
- [ ] **Step 2: Run** `npx vitest run test/import-location.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the schema, the shared type and the `imports.ts` changes. Every existing World query keeps filtering on `worldName`.
- [ ] **Step 4: Run** the new test plus `test/import-*.test.ts test/world-deployer.test.ts test/dcl-destination-routes.test.ts`, then `npx tsc --noEmit -p .` in `apps/server` and `packages/shared`. Expected: PASS, no type errors.
- [ ] **Step 5: Commit** `feat(import): destinations and imports know World vs parcels (Refs LIV-24)`.

### Task 2: Catalyst client and a per-destination content server

**Files:**
- Create: `apps/server/src/services/dcl/catalyst-client.ts`.
- Create: `apps/server/test/helpers/fake-catalyst.ts`.
- Modify: `apps/server/src/services/dcl/world-deployer.ts` (only the client lookups).
- Modify: `apps/server/package.json` (move `@dcl/crypto` to `dependencies`; it's imported at runtime by `entity.ts`).
- Test: `apps/server/test/catalyst-client.test.ts`.

**Interfaces:**
- **`ContentServer` interface:**
  - `liveEntities(dest): Promise<LiveEntity[]>`
  - `deploy({entityId, authChain, files})`
  - `hasContent(hash)`, `getContent(hash)`, `contentSize(hash)`

  `WorldsClient` already has the last four; adapt it with `worldsContentServer(client)`, where `liveEntities` = `getWorldEntities(dest.worldName)`.
- **`HttpCatalystClient(base = config.catalystUrl)`:**
  - `liveEntities` POSTs `/content/entities/active {pointers: dest.parcels}` and returns the unique entities.
  - `deploy` sends the same multipart form as `HttpWorldsClient.deploy`, to `/content/entities`. 200 counts as success; any other status throws `CatalystError(status, body)`.
  - Contents come from `/content/contents/{hash}` (HEAD for size).
- **Singletons:** `getCatalystClient()`/`setCatalystClient()`, and `contentServerFor(dest: Destination): ContentServer` (Worlds for `kind:'world'`, catalyst for `'parcels'`).
- **Fake:** `FakeCatalystClient` mirrors `FakeWorldsClient`: `entities` keyed by pointer, `deployed[]`, `failNext`, `down`.

- [ ] **Step 1: Write failing tests** with `vi.stubGlobal('fetch')`, as `worlds-client.test.ts` does:
  - `deploy` posts multipart to `<catalyst>/content/entities` with every file part;
  - a 400 body reaches `CatalystError.body`;
  - `liveEntities` posts the parcels and de-duplicates an entity covering several parcels;
  - `contentServerFor` picks by kind.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.** Replace the `getWorldsClient()` calls in `world-deployer.ts` that act on a destination (`liveBaseFor`, `liveAt`, the deploy in `runVirviDeploy` and `submitSignedDeploy`, and content reads for kept files) with `contentServerFor(dest)`. Ownership and stats calls stay World-only.
- [ ] **Step 4: Run** the new test plus `test/world-deployer.test.ts test/import-deploy.test.ts test/redeploy-sweep.test.ts test/deployed-files.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(dcl): catalyst client; the deployer picks its content server per destination (Refs LIV-24)`.

### Task 3: Who controls a set of parcels

**Files:**
- Create: `apps/server/src/services/dcl/parcel-control.ts`.
- Modify: `apps/server/src/analytics/dcl-directory.ts` (add `getParcelEstates(parcels)` through the land-manager subgraph; uncached).
- Modify: `test/helpers/fake-dcl.ts` (an `estates` map).
- Test: `apps/server/test/parcel-control.test.ts`.

**Interfaces:**
- **Constants:**
  - `AETHERIA_OWNERS: ReadonlySet<string> = new Set(['0x2981aa7d75eaa42b248e304e378c7139868d4776'])`
  - `AETHERIA_ESTATES = new Set(['2092'])`
- **`parcelControl(wallets: string[], parcels: string[], dir = getDclDirectory()): Promise<ParcelControl>`**

  ```ts
  interface ParcelControl {
    wallet: string | null          // first of `wallets` that may deploy to every parcel
    missing: string | null         // first parcel none of the wallets may deploy to
    canGrant: boolean              // `wallet` is owner/operator/approvedForAll of every parcel (an update operator can't grant)
    aetheria: boolean              // any parcel's owner is in AETHERIA_OWNERS
    rightsOf: Map<string, ParcelRights>
  }
  ```

  It reads fresh rights (bypassing the TTL cache: add `{ fresh: true }` to `getParcelRights`). A directory outage throws `DirectoryUnavailableError`; callers turn that into `503 catalyst_unreachable`.
- **`grantedTo(address, rightsOf): boolean`:** `address` is `updateOperator`, an update manager, operator or approved-for-all on every parcel.

- [ ] **Step 1: Write failing tests** with a fake directory:
  - the owner controls all and can grant;
  - an update operator controls but can't grant;
  - a wallet missing one parcel gets `missing` set to that parcel;
  - Aetheria (owner `0x2981…`) gives `aetheria: true`;
  - `grantedTo` is true only when every parcel has it;
  - the directory being down throws.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(dcl): parcel control, estates and the Aetheria check (Refs LIV-24)`.

### Task 4: Uploading a parcel scene

**Files:**
- Modify: `apps/server/src/routes/imports.ts`.
- Modify: `apps/server/src/services/import/imports.ts`.
- Modify: `apps/server/src/setup/setups.ts` (`linkLocation`).
- Modify: `apps/web/src/lib/import.ts` (drop the `parcels_not_yet` message; add new codes).
- Test: `apps/server/test/import-routes.test.ts` (extend), `apps/web/src/lib/import.test.ts`.

**Interfaces:**
- **Upload:**
  - `PARCELS_NOT_YET` and the `parcels_not_yet` refusal go away.
  - For `location.kind === 'parcels'`: `parcelControl(verifiedWalletsOf(user), parcels)` must give a `wallet`. Otherwise `403 not_parcel_controller` with the message `None of your verified wallets can deploy to parcel <missing>.`
- **`sceneFor`:** looks the location up by kind:
  - a `parcels` destination whose `parcels && $parcels`, giving `parcels_in_use`;
  - else an active setup on an `analyticsScenes` location of kind `parcels` overlapping the parcels, giving `parcels_set_up_elsewhere`;
  - else the last import there, as today.

  The rules and full-access checks are the same as for Worlds.
- **`linkLocation`:** `linkWorldLocation` becomes `linkLocation(input: { location: ImportLocation; … })`. For parcels it upserts `analyticsScenes` `{kind:'parcels', locationKey:'gc:'+base, baseParcel, parcels}`. `linkWorldLocation` stays as a thin wrapper for existing callers.

- [ ] **Step 1: Write failing tests:**
  - `imports a parcel scene for the parcels' owner` (201, `location.kind:'parcels'`, build started);
  - `refuses an importer who controls only some parcels` (403 `not_parcel_controller` naming the parcel);
  - `refuses a second import for overlapping parcels mid-import` (409);
  - `parcels connected to another Virvi scene the importer can't manage` (409 `parcels_in_use`);
  - `the catalyst being down` (503 `catalyst_unreachable`);
  - web: `importErrorMessage` maps the new codes.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `test/import-routes.test.ts test/import-location.test.ts test/setup-routes.test.ts` and web `npx vitest run src/lib/import.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(import): upload Genesis City parcel scenes (Refs LIV-24)`.

### Task 5: Deploying to parcels with browser signing

**Files:**
- Modify: `apps/server/src/services/import/import-deploy.ts`.
- Modify: `apps/server/src/services/dcl/world-deployer.ts`.
- Modify: `apps/server/src/services/dcl/entity.ts`.
- Modify: `apps/server/src/routes/dcl-destinations.ts` (`GET /api/dcl/destinations/:id` reports `kind`, `parcels` and `signers`).
- Test: `apps/server/test/import-deploy-parcels.test.ts`.

**Interfaces:**
- **`entity.ts`:** `SceneMetadata.worldConfiguration` becomes optional. `buildEntity` pointers are `dest.parcels` for parcels (the World's parcels for Worlds, as today).
- **`import-deploy.ts`:** `begin()` for a parcel import:
  - re-reads the built scene.json (parcels/base must match, or `place_changed`);
  - upserts a `kind:'parcels'` destination on `base` (`mode:'sign'`, `adopted:true`, `pendingImportId`), with `ownerWallet` = the controlling wallet `parcelControl` found;
  - then takes the same `startVirviDeploy` / `prepareSignedDeploy` fork.
- **`world-deployer.ts`:**
  - `assembleFor` accepts metadata without `worldConfiguration` when `dest.kind === 'parcels'`, and refuses one *with* it (`place_changed`).
  - `storageProblem` is World-only.
  - Parcels use Decentraland's scene size limit: verify the current per-parcel limit in `@dcl/content-validator`'s scene size check during this task and pin it in `PARCEL_MAX_BYTES_PER_PARCEL` with a citing comment.
  - `submitSignedDeploy` for parcels verifies the chain against **its own signer**: `verifyChain(chain, entityId, signer)` where `signer = chain[0].payload`. It then re-checks `parcelControl([signer], dest.parcels).wallet === signer`, or throws `403 not_parcel_controller`.
  - `afterWorldDeploy` becomes `afterDeploy` and calls `linkLocation`.
  - `reconcileStaleDeployments` uses `contentServerFor`.
- **Route:** `GET /api/dcl/destinations/:id` adds `kind`, `parcels`, and `signers: string[]` (the importer's verified wallets that control every parcel; any of them may sign).

- [ ] **Step 1: Write failing tests** (fake catalyst plus fake directory, `chainFor` as in `import-deploy.test.ts`):
  - `deploys a parcel import signed by the owner` (catalyst `deployed[0]` pointers = parcels; the import ends `deployed`; analytics location `gc:<base>` is linked to the scene);
  - `an update operator may sign`;
  - `a signature from a wallet that lost a parcel is refused` (rights change between prepare and submit → 403);
  - `an import replaces a parcel scene deployed outside Virvi`;
  - `a built scene.json that gained worldConfiguration is refused` (`place_changed`);
  - `over the parcel size limit is refused before deploying`.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the new test plus every `test/import-*.test.ts test/world-deployer.test.ts test/redeploy-sweep.test.ts test/dcl-destination-routes.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(import): deploy imported scenes to Genesis City parcels with browser signing (Refs LIV-24)`.

### Task 6: The optional operator grant (Virvi's Genesis City wallet)

**Files:**
- Modify: `apps/server/src/config.ts` (`virviDclParcelDeployKey` from `VIRVI_DCL_PARCEL_DEPLOY_KEY`, validated like `validDeployKey`).
- Modify: `apps/server/src/services/dcl/entity.ts` (`virviParcelSigner()`).
- Create: `apps/server/src/services/dcl/parcel-grant.ts`.
- Modify: `apps/server/src/routes/dcl-destinations.ts`.
- Modify: `test/cross-account-walk.test.ts` (new `:id` routes).
- Test: `apps/server/test/parcel-grant.test.ts`.

**Interfaces:**
- **`grantTransactions(parcels, estates: Map<parcel, estateId|null>, operator: string | null): {to: string; data: string; label: string}[]`:**
  - one `setManyUpdateOperator(assetIds, operator)` on LANDRegistry for the parcels outside an estate;
  - one `setUpdateOperator(estateId, operator)` on EstateRegistry per distinct estate;
  - `operator: null` encodes the zero address, which revokes.
  - Encoding uses ethers `Interface`. Asset ids follow the rule in "Facts checked".
- **Routes** (all need `requireOwner`-style access: the destination's scene with full access):
  - `GET /api/dcl/destinations/:id/parcel-grant` returns:
    - `{ available, aetheria, canGrant, granted, operator, transactions, costNote }`;
    - `available: false` when the key is unset;
    - `transactions` only when `available && canGrant && !aetheria`;
    - `costNote` is the fixed copy: "This is an Ethereum mainnet transaction: you pay its gas fee once. Undo it any time with a second transaction from here (also paid in gas)."
  - `POST /api/dcl/destinations/:id/parcel-grant/check` reads rights fresh. When `grantedTo(virviParcelAddress)` it sets `mode:'virvi'` and `grantedAt`, and returns `{granted:true}`. Otherwise it returns `{granted:false, missing}`. A refusal with `409 aetheria_managed` when Aetheria.
  - `GET /api/dcl/destinations/:id/parcel-grant/revoke` returns the revoke transactions, and `POST …/revoke/check` clears `mode`/`grantedAt` once the rights are gone.
- **`runVirviDeploy`:** uses `virviParcelSigner()` for parcels. A catalyst 4xx about permissions (or `grantedTo` false on a fresh read before signing) sets `mode:'sign'`, clears `grantedAt`, and fails the deployment with `grant_revoked`: "Virvi is no longer an operator on these parcels. Sign this deploy in the browser, or set Virvi up again."
- **`deployImport` auto-deploy:** works for granted parcel destinations as for Worlds.

- [ ] **Step 1: Write failing tests:**
  - `grantTransactions` encodes asset ids for negative coordinates (−9,−9 gives `0xffff…fff7ffff…fff7`) and one estate call per estate;
  - the GET returns transactions for the owner and none for an update operator (`canGrant:false`);
  - `refuses the operator grant for Aetheria parcels` (GET `aetheria:true` with no transactions; check gives 409);
  - check flips to virvi when the fake rights name Virvi's address;
  - `a revoked grant falls back to browser signing`;
  - the key unset gives `available:false`;
  - cross-account walk cases.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the new test plus `test/cross-account-walk.test.ts test/import-deploy-parcels.test.ts test/config.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(dcl): optional on-chain operator grant for Genesis City parcels (Refs LIV-24)`.

### Task 7: Web: parcel imports, signing and the grant card

**Files:**
- Modify: `apps/web/src/lib/import.ts`.
- Modify: `apps/web/src/app/(dashboard)/import/page.tsx`.
- Modify: `apps/web/src/components/dcl/useWorldSigning.ts` (accepts `signers: string[]`; any one may sign).
- Create: `apps/web/src/lib/parcel-grant.ts` (+ `.test.ts`).
- Create: `apps/web/src/components/dcl/ParcelGrantCard.tsx`.
- Modify: `apps/web/src/lib/api.ts`.

**Interfaces:**
- **`placeLabel(loc: ImportLocation): string`:** `my.dcl.eth`, `Genesis City 10,20` for one parcel, or `Genesis City 10,20 (4 parcels)`. `jumpInUrl` for parcels is `https://decentraland.org/play/?position=<base>`.
- **`importLines`:** takes the location instead of the World name. Its copy says "the wallet that owns or operates these parcels" for parcels.
- **`parcel-grant.ts`:**
  - `grantView(g): { show: boolean; reason: string | null }`:
    - hidden when `!available`;
    - `aetheria` gives "Aetheria parcels are managed by their deed. Sign each deploy with the deed holder's wallet.";
    - `!canGrant` gives "Only the parcels' owner can make Virvi an operator.";
  - `sendTransactions(wallet, txs): Promise<string[]>` uses `eth_sendTransaction` from the connected account, one at a time, and returns the hashes.
- **The card:** shows the Virvi Genesis City address, `costNote`, a "Make Virvi an operator" button, then "Check again" (calls `/check`) while the transaction confirms, and "Remove Virvi as operator" when granted.

- [ ] **Step 1: Write failing lib tests:** `placeLabel` for each form; `grantView` for each case (including Aetheria); `sendTransactions` sends each transaction in order with `from` set, and stops at the first rejection.
- [ ] **Step 2: Run** `npx vitest run src/lib/import.test.ts src/lib/parcel-grant.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the libs, the page changes and the card. Signing uses `signers` from the destination.
- [ ] **Step 4: Run** `pnpm typecheck && npx vitest run` in `apps/web`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(web): import Genesis City scenes, sign with an owner or operator, optional operator grant (Refs LIV-24)`.

### Task 8: Docs and checks

**Files:** `apps/docs/src/content/docs/` (the import guide and the REST reference), `README` of `packages/dcl` if it mentions Worlds-only import.

- [ ] **Step 1:** Document the parcel import, who can sign, the operator option (cost and undo), and the Aetheria note. Add the new routes to the REST reference.
- [ ] **Step 2:** Run `node scripts/check-no-vlm.mjs` (expected 0), the full server suite (in the background, ~8 min), and web `pnpm typecheck && npx vitest run`. Expected: all green.
- [ ] **Step 3: Commit** `docs: Scene Import to Genesis City parcels (Refs LIV-24)`.

## Rollout (owner)

**Before the deploy**
- Generate a fresh wallet for Genesis City deploys. Set `VIRVI_DCL_PARCEL_DEPLOY_KEY` on Railway: `… | railway variable set VIRVI_DCL_PARCEL_DEPLOY_KEY --stdin -s virvi-server --skip-deploys`.
- Without it, browser signing works and the operator option stays hidden.

**Schema:** run `drizzle-kit push` with the deploy. World rows default to `kind 'world'`.

**After the deploy:** test with one owned parcel: import, sign, then check the scene in-world.
