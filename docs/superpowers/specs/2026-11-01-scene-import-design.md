# Scene Import: design

Date: 2026-11-01. Status: agreed with the owner in conversation; this document is the description to plan from.

## Intent

Someone already has a Decentraland scene (a Creator Hub project or an SDK7 code project) and wants to control it
from in-world with Virvi. Today that means installing `@virvixr/dcl` by hand, editing code, building and deploying
themselves. Scene Import does it for them: they upload their scene folder on virvi.io, Virvi installs itself into the
scene, builds it, and deploys it to wherever the scene already lives. They walk away with a live, Virvi-enabled
scene and a copy of exactly what went live, for their records.

Hyperfy is "theoretically" in scope later; this design is Decentraland only.

## Goals

1. **Upload an existing scene folder** (Creator Hub or SDK7) on virvi.io.
2. **Install Virvi into it automatically**: the `@virvixr/dcl` package, the `createVirvi()` call in the scene's main
   file, the HUD icon, and for Creator Hub projects the `VirviManager` script — what `npx @virvixr/dcl install`
   and the README's manual step do today.
3. **Build it on Virvi's side** and **deploy it to where the scene is already set up to go**, read from its
   `scene.json`: a Decentraland World (`worldConfiguration.name`) or Genesis City parcels (`scene.parcels` /
   `base`). The importer doesn't pick a destination; the scene already has one.
4. **Deploy to Genesis City parcels**, which Virvi has never done (it deploys to Worlds only today).
5. **Redeploy** the imported scene later from Virvi.
6. **Download the exact built files that went live** for any deploy (the bytes the Decentraland content server
   serves for that entity), for the creator's records.
7. **Virvi-free backup download**: a version of the scene with everything placed through Virvi (models, images,
   video screens, sounds, ad spaces as they render) baked in at its current exact positions, rotations, scales and
   settings, with the asset files bundled, and **no Virvi installed** — something the creator can deploy themselves
   if Virvi ever goes down.

## Non-goals

- Hyperfy import (later, maybe).
- Editing the creator's own code on Virvi, or keeping their source in sync with a repo.
- Returning a Virvi-modified copy of their source as the main download: the records download is the built files
  that went live (the owner's decision). Their own folder stays as it was; Virvi installs itself fresh on every
  import.
- Live streams or video URLs hosted outside Virvi are not bundled into the backup (they can't be); they stay as
  links.

## Anti-goals

- A build that can reach Virvi's secrets, database, deploy key or other users' data. The uploaded scene is a
  stranger's code and its `npm install` runs arbitrary scripts.
- Deploying somewhere the importer doesn't control, or anywhere other than where their `scene.json` says.
- Silently changing the creator's scene beyond installing Virvi.

## How it works (decided)

### The loop

1. The creator uploads the folder (or a zip of it) on virvi.io.
2. Virvi reads `scene.json`, shows where it will deploy (World name or parcels) and what it found (Creator Hub or
   SDK7, SDK version, whether Virvi is already installed), and checks the importer controls that location (below).
3. Virvi installs itself, builds the scene in an isolated build box, and deploys it.
4. The import links the scene to a Virvi scene with the importer as host, so the HUD works in-world straight away.
5. Later: changes made in-world through the HUD (moving items, placing assets) redeploy the way they do today,
   without a re-upload. Changes to the creator's own code mean uploading the folder again; Virvi installs itself
   again, rebuilds and redeploys.

### Building: Virvi builds it, isolated (owner's decision)

Virvi runs the build (`npm install` and the SDK's production build) itself, so the creator gets a deployed scene
without running anything locally. Because this runs the creator's code and install scripts, the build happens in a
throwaway, locked-down environment with no Virvi secrets, no access to Virvi's database or internal network, and
limits on CPU, memory, disk, time and output size. The build box returns only the built files and a build log.

A failed build shows the creator the build log so they can fix their scene.

### Deploying to Worlds

As today: the World owner (or a wallet with deploy rights) either signs the deploy in the browser, or Virvi uses the
standing deploy permission granted by the owner. That grant is off-chain: the owner's wallet signs requests to the
Decentraland Worlds content server (`PUT /world/{name}/permissions/deployment/{address}`), no transaction, no gas
(`apps/server/src/routes/dcl-destinations.ts`).

### Deploying to Genesis City (new; owner's decision: both options, browser signing the default)

- **Default: browser signing.** Each deploy is signed in the browser by the parcel owner or a wallet with deploy
  rights on those parcels (an operator / update operator / update manager of the LAND or estate). Free, one wallet
  pop-up per deploy. Virvi already has this flow for Worlds (`prepareSignedDeploy` → `POST /api/deploy/:id/signature`)
  and deploys to the catalyst instead of the Worlds server.
- **Optional: make Virvi an operator.** For hands-off redeploys, the owner can send a one-time on-chain transaction
  that gives Virvi's deploy wallet update-operator rights on the scene's parcels or estate (mainnet gas; undone by
  another transaction). With it, Virvi can redeploy Genesis City scenes without a pop-up, as it does for granted
  Worlds. Virvi must make the cost and how to undo it clear before the owner sends it.

### Downloads

- **What went live**: for each deploy, a zip of exactly the files in the deployed entity (fetched by content hash
  from where they were deployed, or kept from the deploy), named after the scene and deploy time.
- **Virvi-free backup**: on demand, a ready-to-deploy project with Virvi removed and Virvi's current content baked
  in as plain Decentraland code and assets. Works for imported scenes (their scene plus the baked content) and for
  scenes Virvi built itself (the baked content alone).

## Decisions after review

- **Access (owner's decision):** Scene Import is open to everyone, on every plan, with no plan limits. The wizard is
  too: scene counts are unlimited on every plan and the wizard's Hyperfy option is open to all (the free plan hosts
  one Hyperfy world), shipped separately on `fix/open-wizard-limits`.
- **Ad spaces in the backup (my call):** baked as an empty slot (or a plain placeholder), never the current
  advertiser's creative: a permanent copy without impression tracking would hand out a paid creative.
- **Licensed assets in the backup (my call):** bundle creator-uploaded files and openly licensed catalog assets with
  an attribution file; anything whose license doesn't clearly allow redistribution (the catalog's `cc-by-nc-3.0` and
  `unstated` packs, all Decentraland Builder packs) is referenced by its Decentraland source rather than bundled,
  until the Decentraland Foundation answers the permission question the owner is sending.
- **Re-upload and existing setups (my call):** re-uploading a scene that was already imported keeps the same Virvi
  scene and everything placed in-world. If the location already has an active Virvi setup under another Virvi scene,
  the import is refused unless the importer has full access to that Virvi scene (it then imports into it).
- **Genesis City operator key (my call):** the on-chain operator option grants a dedicated Genesis City deploy
  wallet, separate from the Worlds key (`VIRVI_DCL_DEPLOY_KEY`), so one leak can't reach both, and owners see that
  address before they send the transaction.
- **"What went live" downloads (my call):** guaranteed for deploys made from this feature on — Virvi keeps the
  deployed files at deploy time. Older deploys get a download only while their files are still served.

## Constraints

- Server: Fastify / TypeScript / Drizzle / vitest, as the rest of `apps/server`; web: Next.js `apps/web`.
- New copy uses Virvi names; `node scripts/check-no-vlm.mjs` must report 0 hits.
- Billing code is off limits (plan limits were opened separately, see Decisions after review).
- Existing World deploy paths (wizard, redeploys, sweep, grants) must keep working.
- Never print or log secrets; the build box gets none.

## Left to the builder

- Where the build box runs and how it is isolated. Options already in the stack: an ephemeral Fly Machine per build
  (the repo already drives Fly for hosted Hyperfy worlds in `apps/server/src/hyperfy/fly.ts`), or a separate
  service with no secrets. Pick, justify, and enforce the anti-goal above.
- Upload format details (folder picker and/or zip), what to drop from uploads (`node_modules`, `bin`, `.git`), and
  size limits.
- How Virvi installs itself into each project kind, reusing `packages/dcl/bin/virvi-dcl.mjs install` where possible;
  what happens when Virvi is already installed (keep, or upgrade to the current version).
- How control of a Genesis City location is checked (owner / operator / update manager) before deploying and before
  offering the operator option, and how the deploy is checked after (the deployed entity is live at those parcels).
- How the Virvi-free backup bakes each Virvi element type into SDK7 code and which SDK version it targets.
- Where built files, logs and downloads are stored and for how long.
- The UI: where import lives on the dashboard, progress while building, the log on failure.
