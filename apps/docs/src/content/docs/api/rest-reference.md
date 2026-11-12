---
title: REST API Reference
description: The main Virvi REST endpoints with method, path and auth, plus where the server's live OpenAPI document is.
---

## Basics

- **Base URL:** `https://virvi.io` for hosted Virvi, or your server's `PUBLIC_URL`. Paths below are complete: every API route starts with `/api/`, except the platform hooks (`/hook/...`).
- **Auth:** "Yes" means send `Authorization: Bearer <token>`, where the token is an access token or an [API key](/docs/api/authentication/#api-keys). "No" means public.
- **Bodies:** JSON (`Content-Type: application/json`) unless noted.
- **Errors:** `{ "error": "…" }`, sometimes with `message`. Other accounts' resources usually answer `404`.
- **Rate limit:** `RATE_LIMIT_MAX` requests per minute per IP across `/api/` (300 by default).
- **Request IDs:** every response has an `x-request-id` header. Quote it when reporting a problem.

## OpenAPI

Every server publishes its own route list:

| URL | What |
|---|---|
| `<base>/api/docs` | Swagger UI |
| `<base>/api/docs/json` | OpenAPI 3 document (JSON) |
| `<base>/api/docs/yaml` | The same, as YAML |

It lists every route the server has, with its method and path, and bearer-token security. Most routes don't declare request or response schemas, so use this page for bodies and the OpenAPI document for the complete list.

This page covers the routes most integrations need. Admin and internal routes are left out.

## Health and instance

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/health` | No | `200` with `{ status, mode, version, timestamp, checks, uptime }`; `503` when Postgres doesn't answer |
| GET | `/api/instance` | No | `{ mode, version, ... }` plus branding on self-hosted installs |

## Scenes, presets and elements

A scene has presets; the live preset's elements (images, video screens, models, sounds, widgets, ad spaces) have instances (placed copies).

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/scenes` | Yes | `{ scenes }`: scenes you own or have a role in |
| POST | `/api/scenes` | Yes | Create a scene: `{ name, description? }` |
| GET | `/api/scenes/:sceneId` | Yes | `{ scene }` with its presets, elements and instances |
| PUT | `/api/scenes/:sceneId` | Yes | Update the scene |
| DELETE | `/api/scenes/:sceneId` | Yes | Delete the scene (restorable for 30 days: `POST /api/scenes/:sceneId/restore`; `GET /api/scenes/deleted` lists them) |
| PUT | `/api/scenes/:sceneId/thumbnail` | Yes | Set the scene's thumbnail: `{ fileData }` (base64). A 16:9 PNG, JPEG or WebP (checked by its bytes), at most 2 MB and at least 960 × 540 px; larger images are scaled to 1920 × 1080 and WebP is stored as JPEG (PNG with transparency). Counts towards the scene owner's storage; replacing deletes the old file. Needs edit access (host, co-host or editor). The scene's `thumbnailSource` becomes `upload` (an imported scene's own is `import`, and isn't deployed by Virvi). Returns `{ scene }`. Errors: `400 wrong_shape` / `too_small` / `missing_file`, `413 too_large`, `415 unsupported_type`, `403 storage_limit_reached`, `403`, `404` |
| DELETE | `/api/scenes/:sceneId/thumbnail` | Yes | Remove the scene's thumbnail and its file. Returns `{ scene }` |
| POST | `/api/scenes/:sceneId/presets` | Yes | Create a preset: `{ name, fromPresetId? }` (blank, or a copy) |
| PATCH | `/api/presets/:presetId` | Yes | Rename a preset: `{ name }` |
| DELETE | `/api/presets/:presetId` | Yes | Delete a preset (`409` if it's live, the only one, a venue default, or used by a booking or schedule) |
| POST | `/api/presets/:presetId/activate` | Yes | Make a preset live for everyone in the scene. Returns `{ activePresetId }`. Hosts, co-hosts and editors |
| GET/POST | `/api/scenes/:sceneId/preset-schedules` | Yes | List or add scheduled presets. Pass `eventId` (an event linked to the scene) to follow that event's start and end; the times then move when the event is edited, pause if it loses them, and the schedule goes when the scene is unlinked. The list includes `status`: why the live preset is live (`none`, `booking`, `schedule` or `manual`) and the next scheduled switch, plus `week`: every enabled run starting from a day ago to 8 days ahead |
| PATCH/DELETE | `/api/preset-schedules/:scheduleId` | Yes | Edit, pause (`{ enabled: false }`) or delete a schedule |
| POST | `/api/presets/:presetId/elements` | Yes | Create an element: `{ type, name, enabled?, customId?, customRendering?, clickEvent?, properties? }` |
| PUT | `/api/elements/:elementId` | Yes | Update an element (same fields). `{ "enabled": false }` hides it |
| DELETE | `/api/elements/:elementId` | Yes | Delete an element and its instances |
| POST | `/api/elements/:elementId/live` | Yes | Video screens: `{ "enabled": true }` or `false` turns the live stream on or off |
| POST | `/api/elements/:elementId/instances` | Yes | Place an instance |
| PUT | `/api/instances/:instanceId` | Yes | Update an instance (position, rotation, scale, ...) |
| DELETE | `/api/instances/:instanceId` | Yes | Remove an instance |
| GET/POST | `/api/elements/:elementId/showings` | Yes | A video screen's [scheduled showings](/docs/dashboard/scheduled-showings/) |
| GET | `/api/scenes/:sceneId/backup.zip` | Yes | A ready-to-deploy Decentraland project of the scene, without Virvi, as a zip (the live preset only; filename in `Content-Disposition`). Needs edit access; an imported scene's own code is included only for its importer and full-access members. Optional `?destination=<id>` (one of the scene's destinations) places a scene built in Virvi there. Errors: `404` (also `destination_not_found`), `403`, `413 backup_too_big` (over 500 MB; the message names the largest files), `422 not_decentraland` (no import and no Decentraland destination), `429 backup_busy`, `504 backup_timeout` |

Changes made through these routes reach players in the scene in real time.

## Roles and collaborators

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/scenes/:sceneId/roles` | Yes | Wallet roles in the scene (host, co-host, editor, viewer) |
| POST | `/api/scenes/:sceneId/roles` | Yes | Give a wallet a role |
| DELETE | `/api/scenes/:sceneId/roles/:wallet` | Yes | Remove a wallet's role |
| POST | `/api/scenes/:sceneId/transfer-host` | Yes | Hand the host role to a co-host |
| GET/POST | `/api/scenes/:sceneId/collaborators` | Yes | List or invite account collaborators: `{ email, role }` |
| PUT/DELETE | `/api/scenes/:sceneId/collaborators/:userId` | Yes | Change or remove one |

## Media and 3D models

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/media` | Yes | Your images and video |
| POST | `/api/media/upload` | Yes | Upload an image or video |
| DELETE | `/api/media/:assetId` | Yes | Delete one |
| GET | `/api/assets` | No | Browse or search 3D models (the asset library) |
| GET | `/api/assets/:id` | No | One model |
| GET | `/api/assets/categories` | No | Categories |
| POST | `/api/assets` | Yes | Upload a GLB. Always private until you share it |
| PUT | `/api/assets/:id` | Yes | Update its details (not `isPublic` or `license`: use share) |
| DELETE | `/api/assets/:id` | Yes | Delete it. One that another account's scene uses stays for that scene |
| POST | `/api/assets/:id/share` | Yes | Share your model: `{ license, rightsConfirmed: true, credit? }` |
| POST | `/api/assets/:id/unshare` | Yes | Make it private again; scenes that have it keep it |
| POST | `/api/assets/:id/report` | Yes | Report a shared model: `{ reason, details? }` |
| GET | `/api/catalog/packs` | No | The free [catalog packs](/docs/dashboard/catalog-packs/) |
| GET | `/api/scenes/:sceneId/library` | Yes | The scene's shared library |
| POST | `/api/scenes/:sceneId/library` | Yes | Add one of your files to it |
| POST | `/api/scenes/:sceneId/library/upload` | Yes | Upload straight into it |
| PATCH/DELETE | `/api/scenes/:sceneId/library/:id` | Yes | Rename or remove an item (the file isn't deleted) |

`GET /api/assets` lists public assets, plus your own private ones when you send a token. To narrow it:

- `scope=public` lists public assets only, even when you're signed in.
- `scope=community` lists only models people shared, without Virvi's catalog.
- `mine=all`, `mine=studio` or `mine=uploads` lists only your own assets: all of them, only Design Studio pieces, or only the rest. A signed-out request gets an empty list.

Each asset has `mine` (it's yours). `uploadedBy` is only included on your own; other people's carry their credit in `author`.

`license` for `share` is one of `cc0-1.0`, `cc-by-4.0`, `cc-by-sa-4.0`, `cc-by-nd-4.0`, `cc-by-nc-4.0`, `cc-by-nc-sa-4.0`, `cc-by-nc-nd-4.0` or `virvi-only`. A report's `reason` is one of `copyright`, `offensive`, `private_info`, `broken`, `spam` or `other`.


## Decentraland deploys

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/scenes/:sceneId/dcl/destinations` | Yes | The scene's destinations (Worlds and parcels) |
| POST | `/api/dcl/destinations` | Yes | Connect a World to a scene |
| DELETE | `/api/dcl/destinations/:id` | Yes | Disconnect it (nothing changes in Decentraland) |
| POST | `/api/dcl/destinations/:id/deploy` | Yes | Deploy now: Virvi signs if it may, otherwise returns what to sign |
| POST | `/api/deploy/:id/signature` | Yes | The owner's signature for a prepared deploy |
| POST | `/api/dcl/destinations/:id/rebase` | Yes | Accept what is live in Decentraland now |
| GET | `/api/deploy/:id` | Yes | A deployment's status |
| GET | `/api/deploy/:id/files.zip` | Yes | The files a World deployment put live |
| GET | `/api/deploy/scene/:sceneId` | Yes | The scene's deployments |
| POST | `/api/deploy/:id/cancel` | Yes | Cancel a pending or building deployment |
| GET | `/api/deploy/platforms` | Yes | Platforms this server can deploy to |
| GET | `/api/dcl/names` | Yes | Your wallets' Decentraland names and Worlds |

Deploying needs full access to the scene (host or co-host).

### Destinations

Where a scene deploys to: a World or a set of Genesis City parcels. Parcel destinations deploy only after you sign, or after Virvi has been made an operator on every parcel.

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/dcl/destinations/:id` | Yes | Destination detail: `kind` (`world` or `parcels`), `parcels`, `signers` (your wallets that can deploy), pending models and the last deployment |
| GET | `/api/dcl/destinations/:id/parcel-grant` | Yes | Parcels: whether Virvi can be made an operator, whether it already is on-chain (`granted`) and deploys (`active`), the wallet to send from (`from`) and the transactions to send |
| POST | `/api/dcl/destinations/:id/parcel-grant/check` | Yes | Parcels: read the rights fresh; Virvi deploys once it is an operator |
| GET | `/api/dcl/destinations/:id/parcel-grant/revoke` | Yes | Parcels: the transactions that remove Virvi as operator |
| POST | `/api/dcl/destinations/:id/parcel-grant/revoke/check` | Yes | Parcels: back to browser signing once Virvi is no longer an operator |

Parcel routes need full access to the scene. Aetheria parcels report `aetheria: true` and return no grant transactions; when Decentraland can't say, `aetheria` is `null` and no transactions are returned. World destinations answer the parcel-grant routes with `409 not_parcels`; use their `grant` and `revoke` routes instead.

The World permission routes (`GET`, `POST` and `DELETE /api/dcl/destinations/:id/grant`, `POST /api/dcl/destinations/:id/revoke`) answer parcels destinations with `409 not_a_world`. `PATCH /api/dcl/destinations/:id` with `mode: "virvi"` on parcels needs the on-chain grant first: `409 not_granted` until Virvi is an operator on every parcel, `409 aetheria_managed` on Aetheria land. `mode: "sign"` is always allowed and free.


## Scene import

See [Scene Import](/docs/dashboard/scene-import/).

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/api/imports` | Yes | Upload a scene zip as the raw request body. Checked, Virvi installed, stored, build started |
| GET | `/api/imports` | Yes | Your last 10 imports; `?sceneId=` for a scene's |
| GET | `/api/imports/:id` | Yes | One import |
| GET | `/api/imports/:id/log` | Yes | Its build log, as text |
| POST | `/api/imports/:id/deploy` | Yes | Deploy it |

Self-hosted servers refuse imports unless `SCENE_BUILD_RUNNER` is set (see [Environment Variables](/docs/self-hosting/environment-variables/#scene-import)).

## Hyperfy

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/hyperfy/app.hyp` | No | The Virvi app for Hyperfy |
| GET | `/api/hyperfy/worlds` | Yes | Your connected and hosted worlds; `?sceneId=` for one scene's |
| POST | `/api/hyperfy/worlds` | Yes | Connect a world (`kind: "self"`) or create a hosted one: `{ sceneId, name, kind?, endsAt? }`. Returns the world key once |
| POST | `/api/hyperfy/worlds/:id/rotate-key` | Yes | Replace the world key |
| DELETE | `/api/hyperfy/worlds/:id` | Yes | Disconnect or destroy |
| GET | `/api/hyperfy/feed` | World key as `Bearer` | What the Hyperfy app reads |

## Events and giveaways

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET/POST | `/api/events` | Yes | List or create events |
| GET/PUT/DELETE | `/api/events/:eventId` | Yes | One event |
| POST | `/api/events/:eventId/link-scene` | Yes | Link a scene |
| DELETE | `/api/events/:eventId/unlink-scene/:sceneId` | Yes | Unlink it |
| GET/POST | `/api/giveaways` | Yes | List or create giveaways |
| GET/PUT/DELETE | `/api/giveaways/:giveawayId` | Yes | One giveaway |
| POST | `/api/giveaways/:giveawayId/items` | Yes | Add an item |
| GET | `/api/giveaways/:giveawayId/claims` | Yes | Its claims |

## Command Center

See [Command Center](/docs/dashboard/command-center/).

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/command-center/:eventId/status` | Yes | The event's linked scenes with their latest deployment. Event owner or instance admin |
| POST | `/api/command-center/:eventId/broadcast` | Yes | `{ action, targetScenes? }`: sends `action` to the platform hooks of every linked scene you have full access to |

## Streaming

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/api/streaming/provision` | Yes | Create a stream key: `{ name, sceneId? }`. `403` unless streaming is on |
| GET | `/api/streaming` | Yes | Your stream servers |
| GET | `/api/streaming/:id` | Yes | One |
| DELETE | `/api/streaming/:id` | Yes | Delete it |
| GET | `/api/streaming/:id/sessions` | Yes | Its sessions |
| POST | `/api/streaming/authorize`, `/api/streaming/webhook`; GET `/api/streaming/live-keys` | Key | For the media server only, with `X-Webhook-Key: <STREAMING_WEBHOOK_KEY>` |

## Companion upload

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/api/upload-tokens` | Yes | Create an upload code |
| GET | `/api/upload/:code` | Code | Check a code |
| GET | `/api/upload/:code/qr.png` | Code | A QR code for it |
| POST | `/api/upload/:code/start`, then `/api/upload/:code/:assetId` | Code | Announce a file, then send its bytes. Models go in the scene owner's 3D Models (private), images and video in Images & Video |

## API keys

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/api/keys` | Yes (account, not a key) | Create a key; returned once |
| GET | `/api/keys` | Yes | List your keys |
| DELETE | `/api/keys/:keyId` | Yes | Delete a key |

## Organizations

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET/POST | `/api/orgs` | Yes | Your organizations; create one |
| PUT | `/api/orgs/:orgId` | Yes | Update one |
| GET | `/api/orgs/:orgId/members` | Yes | Members |
| POST | `/api/orgs/:orgId/invites` | Yes | Invite by email |
| POST | `/api/orgs/accept-invite` | Yes | Accept an invite |
| PUT | `/api/orgs/:orgId/active` | Yes | Make it your active organization |
| DELETE | `/api/orgs/:orgId/members/:userId` | Yes | Remove a member |

## Billing (hosted Virvi)

Only when billing is on (`STRIPE_SECRET_KEY` set, or cloud mode).

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/api/billing/checkout` | Yes | Start a Stripe Checkout session for a plan: `{ "tier": "creator" \| "pro" \| "studio" }`. 503 `plan_unavailable` when the plan's price isn't set |
| GET | `/api/billing/plans` | Yes | Each plan's limits (unlimited is `null`), price and whether it can be bought |
| POST | `/api/billing/portal` | Yes | Open the Stripe customer portal |
| GET | `/api/billing/subscription` | Yes | Your plan and limits |
| GET | `/api/billing/usage` | Yes | Usage against the limits |
| POST | `/api/billing/webhook` | Stripe signature | Stripe webhooks |

## Platform hooks

For platforms that can only make HTTP calls (for example Second Life). No sign-in: a hook names its `sceneId`.

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/hook/register` | No | `{ sceneId, callbackUrl, platform, elementId?, elementType?, mode?, region?, metadata? }`. Registers (or refreshes) a callback and returns the current config |
| GET | `/hook/config?sceneId=&elementId=&elementType=` | No | One element's compact config |
| GET | `/hook/scene?sceneId=` | No | The whole scene's config |
| GET | `/api/hooks` | Yes | Hooks on scenes you fully control |
| DELETE | `/api/hooks/:hookId` | Yes | Remove one (full access to its scene) |

Virvi POSTs JSON to each `callbackUrl` when the scene changes, with an `action` of `config_update`, `preset_change`, `video_status` or `cross_world_update` (from the Command Center). It waits up to 5 seconds.

- A callback that hasn't re-registered for 5 minutes is removed. Call `/hook/register` again every few minutes.
- After 3 failed deliveries in a row, a callback is removed.

Hooks return the same scene content a visitor sees in-world. Rules for `callbackUrl`:

- It must resolve to a public address. Loopback, private and link-local addresses are refused with `400 callback_url_not_allowed`, at registration and again on each callback.
- A scene can hold at most 20 hooks; one more returns `429 too_many_callbacks`.
- Stream keys are never sent to hooks.

Hooks are listed with `GET /api/hooks` and removed with `DELETE /api/hooks/:hookId` by anyone with full access to the scene.
