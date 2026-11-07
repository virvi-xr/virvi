# Try Virvi without an account, phase 2: scenes, import, room scans, demos (LIV-91)

Source: Linear [LIV-91](https://linear.app/livication/issue/LIV-91) (the authority; where this file differs, the issue
wins). Phase 1 (`2026-11-05-trial-access-design.md`) is live: trial users are `users` rows with `is_trial`, `kind: 'trial'`
tokens reach only routes marked `config.trial`, `account_required` opens the web sign-up sheet that retries, conversion
keeps the row, sign-in merges, the sweep expires idle trials after 14 days, `TRIALS_ENABLED` switches it all. This
addendum covers phase 2 only. Phase 3 (preview in a Virvi-owned Decentraland World) is out of scope.

## What guests can and can't do

| Area | Guests can | Needs an account |
| -- | -- | -- |
| Scene builder (wizard) | Every step up to Deploy: Where, Size, Assets, Arrange, the 3D preview; browse the public catalog; start from their own room scan | Saving the scene (creating it), deploying to a World or Hyperfy, Virvi AR spaces |
| Import | Upload a Creator Hub or SDK7 zip (up to 25 MB, 2 per trial); Virvi checks it, adds Virvi and builds it; see the import page (name, place, thumbnail, build log); open its Virvi scene and edit its Virvi layer (rename, presets, models, images, video, sound by URL) | Deploying it, downloading the backup or live files, zips over 25 MB, a third import |
| Room scans | Pair a personal headset with the usual `/pair` code; scan without building in a space; scans go to the trial (up to 5); pick one in the wizard and preview the generated room | Shared headsets; deploying the result; making a library asset from a scan |
| Demos | Analytics (a sample scene's heatmap, visitors, sessions), Events (a sample schedule), Giveaways (a sample set-up): all with sample data; changes stay in the browser and are never sent anywhere | Anything real: their own analytics, publishing events, real giveaways and claims, streaming |
| Media, assets | Browse public assets | Media uploads, larger uploads, making assets public |
| Settings, billing, orgs, roles, collaborators, AR spaces, streams, ad spaces | — | Everything |

Every blocked action opens the phase-1 sign-up sheet in place with what it unlocks; after an in-page sign-up the call is
retried (Google and Discord: "press it again", as in phase 1).

## Data model

- **Wizard drafts stay in the browser.** The wizard has no server draft today: the scene is created by "Create and
  deploy" (`POST /api/wizard/scenes`). For a guest that call is the "save", so it needs an account. While a trial
  session is active the wizard state is kept in `localStorage` (`virvi.wizard.draft`, 14-day life) so a reload or a
  Google/Discord round trip keeps the layout; it is cleared once the scene is created. *My call* (see decisions).
- **Imports make trial-held scenes.** An import already creates a Virvi scene; a guest's import creates one owned by the
  trial. "Saving" it is conversion: the row is the trial's, so signing up keeps it and signing in moves it. No extra
  "unsaved" flag: a scene whose owner `is_trial` is unsaved by definition.
- **Guest imports are sandboxed.** A guest can't prove they own the World or parcels, so their import must not touch
  anyone's real place. New column `scene_imports.sandbox boolean not null default false`, true for trial uploads.
  Sandbox imports are left out of the per-place lock, `import_in_progress`, superseding, `latestImportFor` and the
  build-done auto-deploy. When the converted account deploys one, it is first claimed for its place (the same lock,
  busy check and supersede as an upload, then `sandbox = false`) and the normal deploy re-checks World ownership or
  parcel control with the account's wallets.
- **Room scans and headsets** keep their normal owner (`room_scans.user_id`, `ar_devices.user_id` = the trial). A
  headset a trial approved mints no AR passes (it lists no spaces or scenes); it can only upload scans through a new
  headset-secret route. After conversion it is an ordinary personal headset.
- **Scene access for trials is owner-only.** A trial's actor carries `trial: true`; `getSceneAccess` gives it full
  owner access on scenes it owns and nothing else (no admin, collaborator, role or grant paths). Only the routes on the
  trial allowlist ever see it.
- **Quotas** (config, defaults): `TRIAL_IMPORTS` 2 per trial ever (an atomic counter on `users.trial_imports`, failed
  ones count); `TRIAL_IMPORT_MAX_BYTES` 26214400 per zip (accounts: 100 MB); `TRIAL_ROOM_SCANS` 5 held at once. Studio
  limits from phase 1 are unchanged. Merged scenes may take an account past its plan's scene limit: limits stop new
  scenes, not moved ones.
- **Expiry.** The phase-1 sweep deletes the trial user, and scenes (with presets, elements, instances), imports, room
  scans and headsets cascade. The sweep also stops the build machine of a building trial import, deletes
  `imports/<id>/` files and scene thumbnail files. Demo state in the browser is dropped when the trial ends there
  (`trial_ended`, sign-out); a wizard draft survives conversion (it is what the new account saves) and goes on sign-out
  or once its scene is created.
- **Merge** (sign-in from a trial) also moves scenes, imports, room scans and headsets, in the phase-1 transaction.

## Deploying creates the account from the wallet

- Where step, guest: no wallet connect (that would convert early). A "Decentraland World" choice reads "Decentraland
  World — you'll connect the wallet that owns it when you deploy." It sets `dclLater`; Size and the budget then behave
  as for a World.
- Deploy step, guest with `dclLater`: "Connect your wallet to deploy. This also creates your Virvi account." The button
  runs phase 1's `loginWithWallet('deploy')` (SIWE via `/api/auth/wallet/verify` with the trial bearer): a new wallet
  converts the trial in place, a known wallet merges it. Then the step lists that wallet's Worlds; with exactly one
  World and no scene on it, it is picked and the deploy starts; otherwise the person picks (and confirms a replace).
  The deploy then runs as today (`startSignSession` asks for its own signature: "Check your wallet: sign once to create
  your account, then once more to deploy.").
- A wallet that owns no Decentraland NAME: the account exists; the step says "This wallet doesn't own a Decentraland
  NAME. Your account is ready: connect the wallet that owns your World, or pick Hyperfy or Virvi AR instead."
- Guest with only Hyperfy or Virvi AR: "Create and deploy" meets `account_required` on `POST /api/wizard/scenes`; the
  sheet says "Create a free account to save *Name*. Your layout is kept." and the run continues after sign-up.
- Import page, guest: Deploy shows the same wallet line and flow, then deploys the claimed import.
- Calls made with the old trial token after conversion get `401 trial_ended`, which phase 1's `apiFetch` already swaps
  to the stored account session.

## Getting in

- `/try/scene` (public): a short intro and "Start building". Start passes the invisible Turnstile and creates the trial
  (`POST /api/auth/trial` with `entry: 'scene'`, recorded on the `started` funnel row), then opens `/scenes/new`. A
  trial or account goes straight there.
- Landing page: a second link "Build a scene — no account needed" next to phase 1's.
- Trial shell: Scenes (the list shows trial-held scenes, New scene, Import), Design Studio, and Analytics, Events and
  Giveaways open their demos with a "Demo" badge. Everything else stays locked as in phase 1. Scene pages hide
  account-only tabs (roles, collaborators, destinations, Hyperfy, streams, showings, schedules, AR) behind a lock.

## Demo views

Client-only. The real pages (`analytics/Dashboard`, `events`, `giveaways`) render under `/demo/*` inside a
`DemoApiProvider` that overlays `useApi()` with an in-browser implementation seeded from fixtures: a 2×2-parcel sample
World `virvi-sample.dcl.eth` with 7 days of deterministic visits (summary, timeseries, heatmap cells, sessions), three
sample events on the sample scene, one giveaway with items and sample claims. Creates, edits and deletes change the
in-browser store (`virvi.demo.<trialId>`). Any `useApi()` method the overlay doesn't implement rejects with
`account_required` (`demo:<method>`) instead of calling the server, so nothing leaves the browser. A banner reads
"Demo with sample data. Changes stay in this browser and are never sent anywhere."

## Safety

- New routes stay closed by default; every route this phase opens is listed in the trial-guard test and walked by the
  cross-account walk with a trial that owns nothing (403 or 404, B's data unchanged).
- Guest imports can't hold, block, supersede or deploy to a place they don't own (sandbox, above); a build that
  finishes never auto-deploys a sandbox import.
- A trial-approved headset can't mint passes; shared headsets need an account.
- Trial scene edits refuse element types other than model, image, video and sound, and room-set placement
  (`account_required`, `element_type`, `room_set`). Nothing a trial makes is deployed or public.
- Turnstile still runs once, when the trial is created.

## Owner decisions needed (defaults are my calls)

1. Wizard drafts live in the browser only; the scene is created (saved) at sign-up or deploy. Alternative: a server
   draft row per trial.
2. Guest room scans need a Quest app update (scan without a space, new headset upload route). Until it ships, guests
   can pair but not scan. Alternative without an app update: give each trial a hidden scene and AR space (rejected:
   opens the whole AR builder to guests).
3. Guest imports build on Virvi's build machines (2 per trial, 25 MB each); no extra daily cap beyond the existing build
   concurrency limit.
4. Turnstile (invisible) runs at "Start building" on `/try/scene`, since a trial row is needed for any server call.
   The issue says the wizard needs no check; invisible mode keeps it without a puzzle.
5. Guest editing of imported scenes is the core only (rename, presets, model/image/video/sound elements); no media
   uploads, thumbnails, streams or AR spaces in phase 2. The streaming demo is deferred.
6. A wallet with no Decentraland NAME at deploy still creates the account.
