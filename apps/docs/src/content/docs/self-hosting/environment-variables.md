---
title: Environment Variables
description: Complete reference for all Virvi environment variables
---

## Required (All Modes)

| Variable | Description |
|----------|-------------|
| `VIRVI_MODE` | `single` \| `scalable` \| `cloud` (default: `single`) |
| `DATABASE_URL` | PostgreSQL connection string |
| `JWT_SECRET` | Random 64-char string for JWT signing |
| `PUBLIC_URL` | Public URL of this instance |

## Storage

| Variable | Description |
|----------|-------------|
| `STORAGE_PROVIDER` | `local` \| `supabase` \| `s3` \| `r2` (default: `local`) |
| `LOCAL_STORAGE_PATH` | Path for local storage (default: `./uploads`) |
| `PRIVATE_STORAGE_PATH` | Where single mode keeps private files such as scene import sources and builds (default: a `private` folder beside `LOCAL_STORAGE_PATH`). Must be outside `LOCAL_STORAGE_PATH`, which is served publicly, and on persistent storage; the server refuses to use a path inside it |
| `SCENE_IMPORT_S3_URI` | Private bucket for scene imports, `s3://<key>:<secret>@<host>/<bucket>` or `file://<dir>`. Required in scalable and cloud modes; single mode falls back to `PRIVATE_STORAGE_PATH`. A daily sweep deletes an import's files 30 days after it ended (the import itself is kept) and `deployed/` files no live or recent (30-day) deployment uses; see [Scene import files](#scene-import-files) |
| `SCENE_BUILD_RUNNER` | Where uploaded scenes are built: `fly` (a one-shot, isolated machine per build), `local` (runs `apps/scene-builder/build.mjs` on the server with no isolation; development only, refused in cloud mode) or `off` (scene imports are refused). Default: `fly` in cloud mode, otherwise `off`. Any other value stops the server from starting |
| `SCENE_BUILD_IMAGE` | The build image for `fly`, e.g. `registry.fly.io/virvi-scene-builds:<label>` (see `apps/scene-builder/README.md`). Without it, `fly` builds are unavailable |
| `SCENE_BUILD_FLY_APP` | The Fly app build machines run in (default: `virvi-scene-builds`) |
| `SCENE_BUILD_FLY_TOKEN` | A Fly token scoped to the build app only. Without it, `fly` builds are unavailable |
| `SUPABASE_URL` | Supabase project URL |
| `SUPABASE_ANON_KEY` | Supabase anon key |
| `SUPABASE_SERVICE_KEY` | Supabase service role key |
| `S3_BUCKET` | S3/R2 bucket name |
| `S3_REGION` | S3 region |
| `S3_ENDPOINT` | Custom S3 endpoint (for R2/MinIO) |
| `CDN_URL` | Prepended to public file URLs |
| `VIRVI_DCL_DEPLOY_KEY` | Private key (32-byte hex) of the wallet Virvi deploys World scenes with once an owner grants it |
| `VIRVI_DCL_PARCEL_DEPLOY_KEY` | Private key (32-byte hex) of the wallet Virvi deploys Genesis City parcels with. Keep it separate from `VIRVI_DCL_DEPLOY_KEY`. Unset, browser signing still works and the "Make Virvi an operator" option is hidden |
| `DCL_LAND_SUBGRAPH_URL` | Decentraland LAND subgraph, used only to find which estate each parcel is in (default: `https://subgraph.decentraland.org/land-manager`) |
| `DCL_CATALYST_URL` | Decentraland catalyst: Genesis City deploys, and who may deploy to each parcel (owner, operators, update managers) through its lambdas (default: `https://peer.decentraland.org`) |

### Scene import files

The import bucket (or `PRIVATE_STORAGE_PATH`) holds `imports/<id>/` (each upload's source, its built files and its build
log) and `deployed/<hash>` (the files of every World deploy, kept once per content hash, for "Download what went live").
Five minutes after it starts, and then once a day, the server deletes:

- an import's `imports/<id>/` 30 days after the import ended (deployed or failed, a replaced upload included). The import
  stays listed; its build log answers 410 `files_expired`.
- every `deployed/<hash>` that neither a World's current live deployment nor any deployment from the last 30 days uses,
  and that was written more than an hour ago. Downloading an older deploy then reads the files from Decentraland's Worlds
  server, while it still has them.
- any `imports/<id>/` left without its import (deleting an account or a scene deletes its imports' files at once; this
  catches what a failure left behind).

Nothing is configured for this; a server without the bucket skips it.

## Scalable/Cloud Mode

| Variable | Description |
|----------|-------------|
| `REDIS_URL` | Redis connection string (required for scalable/cloud) |

## Billing (Cloud Only)

| Variable | Description |
|----------|-------------|
| `STRIPE_SECRET_KEY` | Enables billing + feature gating |
| `STRIPE_WEBHOOK_SECRET` | Stripe webhook endpoint secret |
| `STRIPE_PRICE_CREATOR` | Stripe price ID for Creator tier |
| `STRIPE_PRICE_PRO` | Stripe price ID for Pro tier |
| `STRIPE_PRICE_STUDIO` | Stripe price ID for Studio tier |

## Guest Trials

Signed-out visitors can try the Design Studio at `/try/studio` (see [Try Without an Account](/getting-started/try-without-an-account/)).

| Variable | Description |
|----------|-------------|
| `TRIALS_ENABLED` | `true` or `false`: whether visitors can start a trial. Default: on in `cloud` mode, off in `single` and `scalable` mode (the Design Studio only runs in cloud mode). Any other value stops the server from starting. Trial guests are never counted as users, and never take the first-account admin role |
| `TURNSTILE_SECRET_KEY` | Cloudflare Turnstile secret for the bot check on new trials. Without it, cloud mode refuses new trials and other modes skip the check |
| `NEXT_PUBLIC_TURNSTILE_SITE_KEY` | Turnstile site key. A web build variable (a Docker build arg in the root `Dockerfile`), not read by the server at runtime |
| `TRIAL_PROMPTS` | Free prompts per trial, in total (default: `3`) |
| `TRIAL_COST_CEILING_USD` | Most one trial may cost in model spend (default: `3`) |
| `TRIAL_DESIGNS` | Designs per trial (default: `2`) |
| `TRIAL_UPLOAD_BYTES` | Total upload size per trial in bytes (default: `26214400`, 25 MB) |
| `TRIAL_PER_IP_DAY` | New trials per IP address per day (default: `3`) |
| `TRIAL_PER_DEVICE_DAY` | New trials per device per day (default: `3`) |
| `TRIAL_DAILY_BUDGET_USD` | Daily model spend across all trials; once reached, trial prompting pauses until the next day (default: `50`) |
| `TRIAL_IDLE_DAYS` | Days without use before a trial is removed (default: `14`) |

## Streaming

| Variable | Description |
|----------|-------------|
| `ENABLE_STREAMING` | `true` to enable streaming features |
| `RTMP_INGEST_URL` | RTMP ingest base URL (default: `rtmp://localhost:1935/live`) |
| `HLS_BASE_URL` | Playback base URL, e.g. `https://live.virvi.io/streams` (default: `http://localhost:8000/streams`) |
| `STREAMING_WEBHOOK_KEY` | Shared secret with the media server (`VIRVI_WEBHOOK_KEY` there) for publish checks and live/offline webhooks. Required in cloud mode; when unset, self-hosted servers accept unauthenticated media-server calls |

## Platform Hooks

| Variable | Description |
|----------|-------------|
| `ALLOW_PRIVATE_CALLBACK_URLS` | `true` lets platform hooks call private and loopback addresses. Local development and tests only; leave unset in production |

## Hyperfy Provisioning

| Variable | Description |
|----------|-------------|
| `HYPERFY_INFRA_PROVIDER` | `fly` \| `docker` \| `local` (default: `local`) |
| `FLY_API_TOKEN` | Fly.io API token |
| `FLY_HYPERFY_APP` | Fly.io app name (default: `vlm-hyperfy`) |
| `HYPERFY_IMAGE` | Docker image for Hyperfy worlds |
| `DOCKER_SOCKET` | Docker socket path (default: `/var/run/docker.sock`) |

## Tuning

| Variable | Description |
|----------|-------------|
| `PORT` | HTTP port (default: `3010`) |
| `LOG_LEVEL` | `debug` \| `info` \| `warn` \| `error` |
| `JWT_ACCESS_EXPIRY` | Access token lifetime (default: `15m`) |
| `JWT_REFRESH_EXPIRY` | Refresh token lifetime (default: `7d`) |
| `MAX_ROOMS` | Max concurrent Colyseus rooms (default: `50` single, `500` scalable) |
| `DASHBOARD_DIR` | Path to static dashboard files (default: `./dashboard`) |
| `MULTI_TENANT` | `true` for data isolation between orgs |
| `ENABLE_METRICS` | `true` for Prometheus `/metrics` endpoint |
