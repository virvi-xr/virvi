# @virvixr/dcl

[Virvi](https://virvi.io) for Decentraland SDK7 scenes: visitor analytics,
the in-world management HUD, and live scene content managed from the Virvi dashboard.

Version 2 is a rewrite. It is not compatible with the 0.x (SDK6-era) API.

```sh
npm install @virvixr/dcl
npx @virvixr/dcl install
```

`npx @virvixr/dcl install` copies the HUD's launcher icon into your scene (`images/virvi/hud-v.png`); deploy
it with the scene. `npx @virvixr/dcl sync` also keeps it up to date.

## From code

```ts
import { createVirvi } from '@virvixr/dcl'

export async function main() {
  const virvi = await createVirvi()
  virvi.track('scene_loaded') // optional custom analytics event
}
```

`createVirvi()` starts analytics straight away, with no account or scene ID needed. Scene owners
get the management HUD (top right) and can claim the scene's analytics on virvi.io later.

Analytics only (no HUD, no live content):

```ts
import { startVirviAnalytics } from '@virvixr/dcl'

export function main() {
  startVirviAnalytics()
}
```

## Setting up your scene

Deploy, then walk into your scene with the wallet that owns, operates or deployed it. The Virvi HUD
(top right) shows **Set up Virvi here**: one press makes you the scene's host — no account or email
needed. Open **Roles** in the HUD (or the scene's Roles tab on virvi.io) to make others co-hosts,
editors or viewers by wallet address.

## Images and 3D models

- Upload images (PNG, JPG, WebP, GIF up to 10 MB) on virvi.io (Images & Video) and GLB models (up to 50 MB)
  on virvi.io (3D Models), or upload and place them from the in-world HUD (Models → Place). Models uploaded
  in-world go in the scene owner's 3D Models, private.
- Images appear live for everyone.
- Decentraland only loads 3D models that are deployed with your scene. By default Virvi deploys them
  to your World for you (set it up at virvi.io/deploy); if you publish yourself, the HUD's Publish
  button opens the publish page. After that, moving, scaling and showing/hiding models is live.
- `npx @virvixr/dcl sync` is optional, if you want the files locally: run it in your scene folder and it
  downloads your Virvi models into `models/virvi/`, then deploy as usual. The HUD tells you when models
  need a sync.
- `npx @virvixr/dcl sync --dry-run` shows what would change; `--server <url>` for self-hosted Virvi.

## Creator Hub

1. In a terminal in your scene folder, run `npm install @virvixr/dcl`.
2. Run `npx @virvixr/dcl install`. It copies the VirviManager script to `assets/scene/Scripts/VirviManager.ts`
   and the HUD's launcher icon to `images/virvi/hud-v.png` (an edited VirviManager.ts is left alone
   unless you pass `--force`).
3. In Creator Hub, add an entity (e.g. "Virvi Manager"), add a **Script** component, and pick
   `VirviManager.ts`.
4. Fill in the fields, or leave them as they are:

| Field | Default | Meaning |
|-------|---------|---------|
| sceneId | (blank) | Virvi scene ID. Blank: set the scene up from the in-world HUD |
| env | `prod` | `prod`, `staging` or `dev` (anything else means `prod`) |
| serverUrl | (blank) | Only for self-hosted Virvi servers |
| enableHud | on | In-world management HUD for scene owners |
| enableAnalytics | on | Visitor analytics |
| showBeacon | off | Show the Virvi Manager entity's mesh (handy for finding it) |

## Requirements

@virvixr/dcl needs `@dcl/sdk` 7.26 or newer: the HUD scales with the SDK's virtual canvas (reliable from 7.26), so it
isn't tiny on high-DPI screens. The HUD is added alongside your scene's own UI (`addUiRenderer`); if your
main UI sets its own virtual size, that size is used for both.
