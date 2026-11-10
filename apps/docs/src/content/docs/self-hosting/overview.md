---
title: Self-Hosting Overview
description: What a self-hosted Virvi server is made of, which mode to pick, what it serves, and where to run it.
sidebar:
  order: 1
---

Virvi is open source (AGPL-3.0). A self-hosted install has every feature unlocked: no billing, no plan limits.

## What you run

| Part | Needed | Notes |
|---|---|---|
| Virvi server | Yes | One Docker image from the root `Dockerfile`: the API (Fastify), real-time rooms (Colyseus), the dashboard and these docs, all on one port (3010). |
| PostgreSQL | Yes | The Compose files use Postgres 16. Any Postgres your server can reach works. |
| Redis | Scalable mode only | Shares real-time rooms between servers. |
| File storage | Yes | Local disk (default) or an S3-compatible bucket (AWS S3, Cloudflare R2, MinIO). |
| Streaming media server | Only for live streams | A separate app, `apps/streaming` (RTMP in, HLS out). See [Live streaming](/docs/self-hosting/docker-compose/#live-streaming). |

## Pick a mode

Set `VIRVI_MODE`.

| | `single` (default) | `scalable` |
|---|---|---|
| Servers | One | Several, behind a load balancer |
| Real-time rooms | In memory | Redis (`REDIS_URL` required) |
| Storage | Local disk, or S3/R2 | S3/R2 when servers run on different machines |
| Scene import files | Local disk (`PRIVATE_STORAGE_PATH`) | A bucket (`SCENE_IMPORT_S3_URI`) |
| Rooms per server (`MAX_ROOMS`) | 50 | 500 |
| `/metrics` | Off unless `ENABLE_METRICS=true` | Always on |
| First account | Instance admin | Instance admin |

The third mode, `cloud`, runs the hosted virvi.io service (billing, the Design Studio). Don't use it for a self-hosted install.

## Start

Follow [Docker Compose](/docs/self-hosting/docker-compose/). The short version:

```bash
git clone https://github.com/virvi-xr/virvi.git && cd virvi
printf 'JWT_SECRET=%s\nPOSTGRES_PASSWORD=%s\n' "$(openssl rand -hex 32)" "$(openssl rand -hex 16)" > .env
docker compose -f docker-compose.single.yml up -d --build
curl -s http://localhost:3010/api/health
```

Then open `http://localhost:3010` and sign up. The first account becomes the instance admin.

For any address other than `localhost:3010`, also follow [Your own domain](/docs/self-hosting/docker-compose/#your-own-domain): the dashboard's API address is set when the image is built.

## What the server does when it starts

The image runs `apps/server/entrypoint.sh`:

1. If `DATABASE_URL` is set: runs `scripts/pre-push-upgrade.mjs`, then `drizzle-kit push` to create or update every table from `apps/server/src/db/schema.ts`. If the push fails, it runs a built-in SQL fallback that adds the newest tables and columns, and carries on.
2. Starts `node apps/server/dist/index.js`, which checks the database connection, adds the `btree_gist` extension and the booking overlap constraint, and starts listening.

There are no migration files to run by hand. Updating is: pull, rebuild, restart. See [Updating and Troubleshooting](/docs/self-hosting/updating-and-troubleshooting/).

## What it serves

Everything is on one port.

| Path | What |
|---|---|
| `/` | The dashboard (a static export in `/app/dashboard`, `DASHBOARD_DIR`). Unknown paths outside `/api/` get the dashboard's `index.html`. |
| `/api/...` | The REST API. See [REST API Reference](/docs/api/rest-reference/). |
| `/api/health` | Health check: `200` when Postgres answers, `503` otherwise. |
| `/api/instance` | Public install info: mode, version and branding. |
| `/api/docs` | Swagger UI. The OpenAPI document is at `/api/docs/json` (and `/api/docs/yaml`). |
| `/hook/...` | Platform hooks for HTTP-only platforms. |
| `/uploads/...` | Uploaded files, with local storage. |
| `/docs/...` | These docs, built into the image (`DOCS_DIR`). Every page also has a `.md` version, plus `/docs/llms.txt`, `/docs/llms-full.txt` and `/llms.txt`. |
| `/metrics` | Prometheus metrics, when enabled. No authentication. |
| WebSocket on `/` | Real-time rooms (Colyseus): `virvi_scene`, `virvi_command_center`, `virvi_studio`. |

Without a dashboard folder the server runs API-only. Without a docs folder it has no `/docs` routes. The Docker image has both.

## Where to run it

| Host | Files in the repo | Notes |
|---|---|---|
| Any Linux machine with Docker | `docker-compose.single.yml`, `docker-compose.scalable.yml` | The path these docs follow. |
| Railway | `Dockerfile`, `.railway/railway.ts` | Start command `apps/server/entrypoint.sh`, health check `/api/health`. Add a Postgres database, set `DATABASE_URL`, `JWT_SECRET`, `PUBLIC_URL`, and `TRUST_PROXY_HOPS=2`. Set `NEXT_PUBLIC_API_URL` and `NEXT_PUBLIC_WSS_URL` as variables so the build sees them. |
| Fly.io | `fly.toml` | Single mode on port 3010 with a `/api/health` check. Uploads go on a volume: create it once with `fly volumes create virvi_data --region iad --size 10` before the first deploy. Set `DATABASE_URL` and `JWT_SECRET` as secrets. |
| Render | `render.yaml` | Generates `JWT_SECRET`; you set `DATABASE_URL` and `PUBLIC_URL`. It stores uploads on a 10 GB persistent disk (Render doesn't do zero-downtime deploys for a service with a disk); for S3/R2 instead, set `STORAGE_PROVIDER=s3` and the S3 variables. |

On any host, set [`TRUST_PROXY_HOPS`](/docs/self-hosting/environment-variables/#trust_proxy_hops) to the number of proxies in front of the server.

## Things to set before going public

- A strong `JWT_SECRET` and `POSTGRES_PASSWORD`.
- `PUBLIC_URL`, and the dashboard build arguments for your address.
- `TRUST_PROXY_HOPS` for your proxy setup (`0` with no proxy).
- `STREAMING_WEBHOOK_KEY` if you turn streaming on.
- Block `/metrics` at your proxy if it is on.
- Keep Postgres (5432) and Redis (6379) off public interfaces. The Compose files publish them on `127.0.0.1` only.
- `SMTP_*` and `EMAIL_FROM` so password resets work, and `AR_REPORTS_EMAIL` so space reports reach you.
- Sign up first, so you are the instance admin.

## Branding

A self-hosted install can show its own logo and name instead of Virvi's. Only instance admins see this section.

Open **Settings → Branding** to set:

- **Logo:** a PNG, WebP or SVG up to 512 KB, shown at up to 160 × 40 px. It replaces the Virvi wordmark in the sidebar and on the sign-in page.
- **Name** (optional, up to 32 characters). It's the logo's alt text and replaces "Virvi" in the browser tab title.
- **Favicon** (optional): a square PNG, at least 64 × 64 px.

**Reset to Virvi** removes all three. The install label stays visible under a custom logo, as "Self-hosted · Powered by Virvi" (or "Self-hosted · Scalable · Powered by Virvi").

Images are stored with the install's normal media storage, checked by their content and saved as PNG. SVGs are converted to PNG on upload, so scripts in them never run; an SVG that loads outside files is refused. In `cloud` mode there is no branding.

The API: `PUT /api/instance/branding` and `DELETE /api/instance/branding` (instance admins only, not in cloud mode).
