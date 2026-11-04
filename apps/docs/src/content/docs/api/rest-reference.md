---
title: REST API Reference
description: Complete list of Virvi API endpoints
---

All endpoints are prefixed with `/api` except the platform hooks (`/hook/*`). Authenticated endpoints require `Authorization: Bearer <token>`, where the token is an access token or an [API key](/api/authentication#api-keys).

Requests for another account's scenes, deployments, events, giveaways, streams or wallets are refused with `403` or `404`.

## Auth

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/auth/register` | No | Register new user |
| POST | `/auth/login` | No | Login |
| POST | `/auth/refresh` | No | Refresh access token |
| POST | `/auth/platform` | No | Platform auth (DCL signed fetch, etc.) |

## Scenes

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/scenes` | Yes | List user's scenes |
| POST | `/scenes` | Yes | Create scene |
| GET | `/scenes/:id` | Yes | Get scene with presets + elements |
| PUT | `/elements/:id` | Yes | Update element |
| POST | `/scenes/:sceneId/presets` | Yes | Create a preset: `{ name, fromPresetId? }` (blank, or a copy) |
| PATCH | `/presets/:presetId` | Yes | Rename a preset: `{ name }` |
| DELETE | `/presets/:presetId` | Yes | Delete a preset (409 if it's live, the only one, a venue default, or used by a booking or schedule) |
| POST | `/presets/:presetId/activate` | Yes | Make a preset live for everyone in the scene |
| GET/POST | `/scenes/:sceneId/preset-schedules` | Yes | List or add scheduled presets |
| PATCH/DELETE | `/preset-schedules/:scheduleId` | Yes | Edit, pause (`{ enabled: false }`) or delete a schedule |
| POST | `/presets/:presetId/elements` | Yes | Create element |
| POST | `/elements/:id/instances` | Yes | Create instance |
| PUT | `/instances/:id` | Yes | Update instance |

## Assets

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/assets` | No | Browse/search asset library |
| GET | `/assets/:id` | No | Get single asset |
| POST | `/assets` | Yes | Upload new asset |
| PUT | `/assets/:id` | Yes | Update asset metadata |
| DELETE | `/assets/:id` | Yes | Delete asset |
| GET | `/assets/categories` | No | List categories |

## Deployment

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/deploy` | Yes | Start deployment |
| GET | `/deploy/:id` | Yes | Get deployment status |
| GET | `/deploy/scene/:sceneId` | Yes | List scene deployments |
| POST | `/deploy/:id/cancel` | Yes | Cancel deployment |
| POST | `/deploy/:id/redeploy` | Yes | Redeploy |
| POST | `/deploy/hyperfy/provision` | Yes | Provision Hyperfy world |
| POST | `/deploy/hyperfy/:id/destroy` | Yes | Destroy Hyperfy instance |
| GET | `/deploy/hyperfy/:id/status` | Yes | Instance live status |

Deploying needs full access to the scene (host or co-host). A deploy signs only with one of your own deployment wallets: a `walletId` that belongs to another account returns `404`.

## Streaming

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/streaming/provision` | Yes | Create streaming server |
| GET | `/streaming` | Yes | List user's servers |
| GET | `/streaming/:id` | Yes | Get server details |
| DELETE | `/streaming/:id` | Yes | Terminate server |
| GET | `/streaming/:id/sessions` | Yes | List stream sessions |
| POST | `/streaming/webhook` | Key | Media server status callback |

## Billing

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/billing/checkout` | Yes | Create Stripe Checkout session |
| POST | `/billing/portal` | Yes | Create Customer Portal session |
| GET | `/billing/subscription` | Yes | Get current subscription + limits |
| GET | `/billing/usage` | Yes | Get usage vs limits |
| POST | `/billing/webhook` | Sig | Stripe webhook |

## Platform Hooks

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/hook/register` | No | Register callback URL |
| GET | `/hook/config` | No | Poll element config |
| GET | `/hook/scene` | No | Poll full scene config |

Hooks return the same scene content a visitor sees in-world. Rules for `callbackUrl`:

- It must resolve to a public address. Loopback, private and link-local addresses are refused with `400 callback_url_not_allowed`, at registration and again on each callback.
- A scene can hold at most 20 hooks; one more returns `429 too_many_callbacks`.
- Stream keys are never sent to hooks.

Hooks are listed with `GET /api/hooks` and removed with `DELETE /api/hooks/:hookId` by anyone with full access to the scene.

## API Keys

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/keys` | Yes | Create a key (returned once) |
| GET | `/keys` | Yes | List your keys |
| DELETE | `/keys/:keyId` | Yes | Delete a key |

## Companion Upload

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/upload-tokens` | Yes | Create upload token |
| GET | `/upload/:code` | Token | Validate upload code |
| POST | `/upload/:code` | Token | Upload file via code |

## Command Center

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/command-center/:eventId/status` | Yes | Multi-world status |
| POST | `/command-center/:eventId/broadcast` | Yes | Cross-world action |
