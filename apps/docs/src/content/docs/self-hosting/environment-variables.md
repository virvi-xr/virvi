---
title: Environment Variables
description: Every environment variable the Virvi server reads, with its default, what it does and when you need it.
sidebar:
  order: 3
---

The server reads its settings from environment variables when it starts (`apps/server/src/config.ts`). Change one, then restart the server.

With Docker Compose, put variables in `.env`; the lines under the `virvi` service's `environment:` win over it. See [Docker Compose](/docs/self-hosting/docker-compose/#adding-more-variables).

Never commit secret values. The tables describe each secret; they never show one.

## Modes

`VIRVI_MODE` sets the defaults for everything else.

| Mode | Use it for | Presence (real-time rooms) | Billing | First account |
|---|---|---|---|---|
| `single` (default) | One server | In memory | Off: every feature unlocked | Becomes instance admin |
| `scalable` | Several servers behind a load balancer | Redis | Off: every feature unlocked | Becomes instance admin |
| `cloud` | The hosted virvi.io service | Redis | On | Never auto-promoted |

`cloud` is for virvi.io. Self-hosted installs use `single` or `scalable`.

## Required

| Variable | single | scalable | Default | What it does |
|---|---|---|---|---|
| `DATABASE_URL` | Required | Required | none | Postgres connection string. Without it the server prints `FATAL: DATABASE_URL environment variable is required` and exits. |
| `JWT_SECRET` | Required | Required | `dev-secret-change-me` | Signs every sign-in token. Use a long random string (`openssl rand -hex 32`). When `NODE_ENV=production` (always true in the Docker image) or in cloud mode, the server refuses to start without it or with the default. Changing it signs everyone out. |
| `PUBLIC_URL` | Required | Required | `http://localhost:3010` | The public origin of this server, such as `https://virvi.example.com`. Used in uploaded file URLs, OAuth redirects and the API docs' server URL. |
| `REDIS_URL` | Not used | Required | none | Redis for cross-server rooms. The server won't start in `scalable` mode without it. |

## Server and network

| Variable | Default | What it does |
|---|---|---|
| `VIRVI_MODE` | `single` | `single`, `scalable` or `cloud`. See [Modes](#modes). |
| `PORT` | `3010` | HTTP and WebSocket port. Both share it. |
| `WEB_APP_URL` | `PUBLIC_URL` | Origin of the dashboard. Used as the domain in wallet sign-in messages and in links Virvi hands out (upload links, pairing links). Set it only if the dashboard is on a different origin. |
| `TRUST_PROXY_HOPS` | `1` | How many reverse proxies sit between the internet and the server. See [TRUST_PROXY_HOPS](#trust_proxy_hops). |
| `RATE_LIMIT_MAX` | `300` | Requests per minute per client IP, for `/api/` routes only. Dashboard files, uploads and docs don't count. Sign-in routes have their own, stricter limit. |
| `MAX_UPLOAD_MB` | `100` | Largest request body, in MB. |
| `LOG_LEVEL` | `info` when `NODE_ENV=production`, else `debug` | `debug`, `info`, `warn` or `error`. |
| `NODE_ENV` | `production` in the Docker image | `production` makes `JWT_SECRET` mandatory. |
| `DASHBOARD_DIR` | `./dashboard` (`/app/dashboard` in the image) | Folder with the built dashboard. Missing: the server runs API-only. |
| `DOCS_DIR` | `./apps/docs/dist` | Folder with the built docs, served at `/docs`. Missing: no `/docs` routes. Relative to the working directory (`/app` in the image). |

### TRUST_PROXY_HOPS

The server reads each visitor's IP address for rate limits, trial limits and analytics. Behind a reverse proxy, the socket's address is the proxy's, and the real address is in the `X-Forwarded-For` header. `TRUST_PROXY_HOPS` says how many proxy hops to trust in that header.

| Setup | Set |
|---|---|
| Clients connect straight to the server (no proxy) | `0` |
| One proxy in front (nginx, Caddy, Traefik, a load balancer) | `1` (the default) |
| Railway | `2` |
| A CDN in front of your proxy | `2` (count every hop you control or trust) |

Too low: every visitor shares the proxy's address, so one busy visitor can rate-limit everyone. Too high: visitors can fake their address by sending their own `X-Forwarded-For`. With no proxy, the default `1` lets them do that, so set `0`.

A negative or non-numeric value is treated as `1`.

## Database

| Variable | Default | What it does |
|---|---|---|
| `DATABASE_URL` | none | Postgres connection string (required). |
| `DB_POOL_MAX` | `10` in single mode, `20` otherwise | Most database connections per server. |

## Storage

| Variable | Default | What it does |
|---|---|---|
| `STORAGE_PROVIDER` | `local` | `local` stores uploads on disk. `s3` or `r2` stores them in an S3-compatible bucket. Any other value stops the server at boot. Unset, it's `local` (`s3` in cloud mode). Use `s3` or `r2` when you run more than one server on different machines. |
| `LOCAL_STORAGE_PATH` | `./uploads` | Folder for uploads with `local`. Served publicly at `/uploads/`. Must be on persistent storage. |
| `PRIVATE_STORAGE_PATH` | a `private` folder beside `LOCAL_STORAGE_PATH` | Single mode only: where scene import sources and builds are kept. Must be outside `LOCAL_STORAGE_PATH` (the server refuses a path inside it) and on persistent storage. |
| `S3_BUCKET` | none | Bucket name. Required with `s3`/`r2`; the server throws `S3_BUCKET is required when using s3/r2 storage` on the first upload without it. |
| `S3_REGION` | `auto` | Bucket region. Use `auto` for Cloudflare R2. |
| `S3_ENDPOINT` | none | Endpoint for R2 or MinIO. Leave unset for AWS S3. |
| `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | none | Bucket credentials, read by the AWS SDK. |
| `CDN_URL` | none | Origin for public file URLs, such as a custom bucket domain. Without it, URLs are `<S3_ENDPOINT>/<bucket>/...`, or `https://<bucket>.s3.amazonaws.com/...` with no endpoint. |

## Scene import

| Variable | Default | What it does |
|---|---|---|
| `SCENE_BUILD_RUNNER` | `off` (`fly` in cloud mode) | Where uploaded scenes are built. `off` refuses imports. `local` runs `apps/scene-builder/build.mjs` on the server with no isolation: development only, and it needs `npm install` in `apps/scene-builder` (not in the Docker image). `fly` starts a one-shot Fly machine per build. Any other value stops the server from starting. |
| `SCENE_IMPORT_S3_URI` | none | Private bucket for imports: `s3://<key>:<secret>@<host>/<bucket>`, or `file://<dir>`. Single mode falls back to `PRIVATE_STORAGE_PATH`; scalable mode needs it. |
| `SCENE_BUILD_IMAGE` | none | Build image for `fly`. |
| `SCENE_BUILD_FLY_APP` | `virvi-scene-builds` | The Fly app build machines run in. |
| `SCENE_BUILD_FLY_TOKEN` | none | Fly token scoped to the build app only. |

Five minutes after it starts, then once a day, the server deletes an import's files 30 days after the import ended, and deployed files no current or recent (30-day) deployment uses. The import itself stays listed. Nothing to configure.

## Sign-in

| Variable | Default | What it does |
|---|---|---|
| `JWT_ACCESS_EXPIRY` | `15m` | Access token lifetime. Also the life of an in-world scene pass. |
| `JWT_REFRESH_EXPIRY` | `7d` | Refresh token lifetime. |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | none | Turns on "Sign in with Google". Both must be set. |
| `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET` | none | Turns on "Sign in with Discord". Both must be set. |
| `OAUTH_CALLBACK_URL` | `PUBLIC_URL` | Base for OAuth redirect URIs. Register `<base>/api/auth/google/callback` and `<base>/api/auth/discord/callback` with the provider. |
| `ALLOW_UNVERIFIED_PLATFORM_AUTH` | `false` | `true` accepts in-world sign-ins without a verified Decentraland signature. Ignored in cloud mode. For local scene previews only; never set it on a public server. |
| `MIN_DCL_HUD_PROTOCOL` | `0` | Oldest in-world HUD edit protocol (header `x-virvi-hud-protocol`) allowed to save edits. Older HUDs get `426` and ask for a redeploy. Leave at `0` unless a release says otherwise. |

`GET /api/auth/providers` shows which OAuth providers are on.

## Email

Without `SMTP_HOST`, no email is sent (password resets, invites); the server logs `SMTP not configured, skipping email`.

| Variable | Default | What it does |
|---|---|---|
| `SMTP_HOST` | none | SMTP server. |
| `SMTP_PORT` | `587` | SMTP port. |
| `SMTP_USER`, `SMTP_PASS` | none | SMTP credentials. |
| `EMAIL_FROM` | `noreply@virvi.io` | Sender address. Set your own. |
| `AR_REPORTS_EMAIL` | `support@virvi.io` | Where a visitor's "Report this space" (AR spaces) is emailed. Set your own address, or reports go to Virvi support. |

## Guest trials

Signed-out visitors can try Virvi at `/try/...` (see [Try Without an Account](/docs/getting-started/try-without-an-account/)).

| Variable | Default | What it does |
|---|---|---|
| `TRIALS_ENABLED` | `false` (`true` in cloud mode) | `true` or `false`. Any other value stops the server from starting. |
| `TURNSTILE_SECRET_KEY` | none | Cloudflare Turnstile secret for the bot check on new trials. Without it, single and scalable mode skip the check; cloud mode refuses new trials. |
| `NEXT_PUBLIC_TURNSTILE_SITE_KEY` | none | Turnstile site key. A build argument of the dashboard, not read at runtime. |
| `TRIAL_PROMPTS` | `3` | Free Design Studio prompts per trial. |
| `TRIAL_COST_CEILING_USD` | `3` | Most model spend one trial may use. |
| `TRIAL_DESIGNS` | `2` | Designs per trial. |
| `TRIAL_UPLOAD_BYTES` | `26214400` (25 MB) | Total upload size per trial. |
| `TRIAL_IMPORTS` | `2` | Scene imports per trial, ever (failed ones count). |
| `TRIAL_IMPORT_MAX_BYTES` | `26214400` (25 MB) | Largest scene zip a trial may import. |
| `TRIAL_ROOM_SCANS` | `5` | Room scans a trial may hold at once. |
| `TRIAL_PER_IP_DAY` | `3` | New trials per IP address per day. |
| `TRIAL_PER_DEVICE_DAY` | `3` | New trials per device per day. |
| `TRIAL_DAILY_BUDGET_USD` | `50` | Daily model spend across all trials. |
| `TRIAL_IDLE_DAYS` | `14` | Days unused before a trial is removed. |

The Design Studio runs only in cloud mode, so on a self-hosted install trials cover the scene tools.

## Design Studio

The Design Studio runs only in cloud mode. These settings shape its "Improve my prompt" button, which rewrites a draft before it is sent. The button needs `ANTHROPIC_API_KEY` on the server; without it the button is hidden.

| Variable | Default | What it does |
|---|---|---|
| `STUDIO_PROMPT_HELP_MODEL` | `claude-haiku-5-5` | The Claude model that rewrites drafts. |
| `STUDIO_PROMPT_HELP_PER_DAY` | `30` | Rewrites each account (trials too) may ask for per UTC day. They don't use prompts. `0` allows none. A value that isn't a whole number stops the server from starting. |

## Streaming

These connect the server to the [streaming media server](/docs/self-hosting/docker-compose/#live-streaming).

| Variable | Default | What it does |
|---|---|---|
| `ENABLE_STREAMING` | `false` (on in cloud mode) | `true` lets users create stream keys. |
| `RTMP_INGEST_URL` | `rtmp://localhost:1935/live` | RTMP address shown to streamers (the OBS "Server"). |
| `HLS_BASE_URL` | `http://localhost:8000/streams` | Public base of HLS playback URLs. |
| `STREAMING_WEBHOOK_KEY` | none | Shared secret with the media server (`VIRVI_WEBHOOK_KEY` there). Unset, single and scalable mode accept unauthenticated calls to `/api/streaming/authorize`, `/api/streaming/live-keys` and `/api/streaming/webhook`. Set it whenever the server is reachable from the internet. |

## Decentraland

| Variable | Default | What it does |
|---|---|---|
| `VIRVI_DCL_DEPLOY_KEY` | none | Private key (32-byte hex) of a wallet used only to deploy Worlds an owner has granted it ("Let Virvi deploy for me"). A malformed key stops the server at boot (the error names the variable, never the value). |
| `VIRVI_DCL_PARCEL_DEPLOY_KEY` | none | A separate wallet's private key for Genesis City parcels. Unset hides the "Make Virvi an operator" option; browser signing still works. A malformed key stops the server at boot. |
| `DCL_REDEPLOY_SWEEP_MS` | `30000` | How often pending redeploys are checked (`0` disables). |
| `DCL_MAP_SWEEP_MS` | `60000` | How often to check whether Decentraland built a map snapshot for a new deploy (`0` disables). |
| `DCL_CATALYST_URL` | `https://peer.decentraland.org` | Catalyst for Genesis City deploys and parcel permissions. |
| `DCL_LAND_SUBGRAPH_URL` | `https://subgraph.decentraland.org/land-manager` | LAND subgraph, used to find a parcel's estate. |
| `DCL_WORLDS_URL` | `https://worlds-content-server.decentraland.org` | Worlds content server. |
| `DCL_MAP_MANIFEST_URL` | `https://abgen-cdn.decentraland.org/LOD/lods-unity/manifests` | Where map snapshots are looked up. |

## Hosted Hyperfy worlds

Optional. "Create a hosted world" appears only when `HYPERFY_INFRA_PROVIDER=fly` and all of these are set: `FLY_API_TOKEN`, `FLY_WORLDS_ORG`, `HYPERFY_IMAGE`, `HYPERFY_WORLDS_DB_URL_TEMPLATE` (a `postgres://` URL containing `{user}` and `{password}`), `HYPERFY_ASSETS_S3_URI`, `HYPERFY_ASSETS_BASE_URL`, `HYPERFY_ROUTER_DOMAIN` and `HYPERFY_SECRET_KEY` (32 bytes of hex). `HYPERFY_WORLDS_DB_MODE` is `fly-job` (default with Fly; uses the `HYPERFY_DB_JOB_APP` app, default `vlm-worlds-db-jobs`) or `direct` (needs `HYPERFY_WORLDS_DATABASE_URL`).

Connecting a Hyperfy world you run yourself needs none of these.

## Billing

Billing is for cloud mode.

| Variable | Default | What it does |
|---|---|---|
| `STRIPE_SECRET_KEY` | none | Turns billing and plan limits on, in any mode. Leave it unset on a self-hosted install, or features become gated by plan. |
| `STRIPE_WEBHOOK_SECRET` | none | Verifies Stripe webhooks at `/api/billing/webhook`. |
| `STRIPE_PRICE_CREATOR`, `STRIPE_PRICE_PRO`, `STRIPE_PRICE_STUDIO` | `price_creator`, `price_pro`, `price_studio` | Stripe price IDs for each plan. |

## Monitoring and background jobs

| Variable | Default | What it does |
|---|---|---|
| `ENABLE_METRICS` | `false` in single mode; always on in scalable and cloud | `true` serves Prometheus metrics at `/metrics`. The route has no authentication: block it at your proxy if the server is public. |
| `ANALYTICS_JOBS` | on | `false` stops analytics background jobs (session close, rollups, retention). |
| `ERROR_REPORTING` | on | `false` stops recording error events in the database. |
| `LIFECYCLE_SWEEP_MS` | `5000` | How often venue bookings are advanced (`0` disables). |
| `GEOIP_COUNTRY_DB_PATH` | none | Path to an `.mmdb` country database for analytics. Without it, countries come only from a CDN header such as `cf-ipcountry`. |
| `FFPROBE_PATH` | `ffprobe` | ffprobe binary, used to read video lengths. The Docker image includes FFmpeg. |

## Build-time variables

The dashboard is a static export. These are baked in when the image is built (`docker build --build-arg ...`), not read at runtime.

| Build argument | Default | What it does |
|---|---|---|
| `NEXT_PUBLIC_API_URL` | `http://localhost:3010` | Where the dashboard sends API calls. Set it to your `PUBLIC_URL`, or the dashboard only works from `localhost:3010`. |
| `NEXT_PUBLIC_WSS_URL` | `ws://localhost:3010` | Where the dashboard opens WebSockets: your `PUBLIC_URL` with `wss://` (or `ws://`). |
| `NEXT_PUBLIC_DOCS_URL` | the server's own `/docs/` | Docs link on the landing page. |
| `NEXT_PUBLIC_DISCORD_URL` | none | Discord link on the landing page; hidden when unset. |
| `NEXT_PUBLIC_TURNSTILE_SITE_KEY` | none | Turnstile site key for trials. |

The server's `/llms.txt`, `/docs/llms.txt`, `/docs/llms-full.txt` and `/docs/<page>.md` files link to its own address (`WEB_APP_URL`, which defaults to `PUBLIC_URL`), so an agent reading your install's docs stays on your install. The HTML pages keep their virvi.io canonical links.
