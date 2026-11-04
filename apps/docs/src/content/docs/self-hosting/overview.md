---
title: Self-Hosting Overview
description: Run Virvi on your own infrastructure
---

Virvi is fully open-source. Self-hosters get every feature for free — no billing gates, no feature locks.

## Deployment Modes

| Mode | `VIRVI_MODE=single` | `VIRVI_MODE=scalable` |
|------|-------------------|---------------------|
| **Servers** | 1 container | Multiple containers + load balancer |
| **Colyseus** | In-memory presence | Redis presence (cross-server routing) |
| **Redis** | Not needed | Required |
| **Storage** | Local filesystem | S3/R2 (shared across servers) |
| **First signup** | Auto-promoted to admin | Auto-promoted to admin |
| **Max rooms** | 50 | 500 per server |

## Quick Start

### Single Mode (5 minutes)

```bash
docker compose -f docker-compose.single.yml up -d
```

Requires only `JWT_SECRET` and optionally `POSTGRES_PASSWORD`.

### Scalable Mode (30 minutes)

```bash
docker compose -f docker-compose.scalable.yml up -d --scale virvi=3
```

Requires `JWT_SECRET`, `POSTGRES_PASSWORD`, and a Redis instance.

## Cloud Providers

- **Railway** — `Dockerfile` builds automatically; `.railway/railway.ts` sets the start command and health check (`railway config apply`)
- **Render** — `render.yaml` included, auto-generates JWT_SECRET
- **Fly.io** — `fly.toml` included, `fly launch` from repo root
- **Any VPS** — `docker build .` + set environment variables

## What's Included

The Docker image contains:

- Virvi API server (Fastify + Colyseus)
- Next.js dashboard (standalone mode)
- Drizzle auto-migrations (runs on boot)
- FFmpeg (for optional HLS streaming)

## Branding

A self-hosted install can show its own logo and name instead of Virvi's. The first account to sign up on a new install is its instance admin; only instance admins see this section.

Open **Settings → Branding** to set:

- **Logo:** a PNG, WebP or SVG up to 512 KB, shown at up to 160 × 40 px. It replaces the Virvi wordmark in the sidebar (desktop and mobile) and on the sign-in page.
- **Name** (optional, up to 32 characters), for example "Acme Events". It's the logo's alt text and replaces "Virvi" in the browser tab title.
- **Favicon** (optional): a square PNG, at least 64 × 64 px.

Each upload shows a preview before you save. **Reset to Virvi** removes all three.

The install label stays visible under a custom logo, as "Self-hosted · Powered by Virvi" (or "Self-hosted · Scalable · Powered by Virvi").

Uploads are stored with the install's normal media storage (local disk or S3/R2). Every image is checked by its content and saved as a PNG. SVGs are converted to PNG on upload, so scripts and event handlers in them never run. An SVG that loads files from outside itself is refused.

Branding is for self-hosted installs only: in `cloud` mode the section isn't shown and no custom branding is returned.
