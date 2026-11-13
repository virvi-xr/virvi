# Virvi

A platform for managing metaverse presence across multiple virtual worlds from a single interface. One person can deploy worlds, run live events, place 3D assets, control video streams, and monitor analytics across Decentraland, Hyperfy, and any future platform.

## What It Does

- **Web dashboard** — configure scene elements (video screens, images, 3D models, sounds, widgets) with position, rotation, scale, and behavior
- **Real-time sync** — changes from the dashboard appear in live metaverse scenes within milliseconds via Colyseus WebSocket
- **Multi-platform** — platform adapter architecture supports Decentraland, Hyperfy, and any platform with an entity/component system
- **In-world HUD** — manage scenes from inside the metaverse without leaving the world
- **Multi-world command center** — orchestrate simultaneous cross-platform events from one screen
- **Analytics** — visitor sessions, movement paths, and custom actions aggregated across all platforms
- **Events & giveaways** — time-bounded experiences with NFT distribution across multiple worlds
- **HLS streaming** — provision streaming servers, push RTMP, serve HLS playlists to in-world video screens
- **Media hosting** — upload and serve images, videos, and 3D models via CDN (S3/R2)
- **One-click deploy** — deploy Decentraland scenes and provision Hyperfy worlds from the dashboard

## Architecture

```
Web Dashboard (Next.js)  ──REST/WSS──▶  Virvi API Server (Fastify + Colyseus)
                                              │
                            ┌─────────┬───────┼───────┬──────────┐
                            ▼         ▼       ▼       ▼          ▼
                        Postgres    Redis   S3/R2   Stripe   Media Server
                                              │
In-World SDKs + HUD  ──Colyseus WSS──────────┘
  ├── @virvixr/core (platform-agnostic logic)
  ├── @virvixr/adapter-dcl (Decentraland)
  └── @virvixr/hyperfy-app (Hyperfy)
```

## Monorepo Structure

| Package | Description |
|---------|-------------|
| `apps/server` | Fastify API + Colyseus WebSocket server |
| `apps/web` | Next.js dashboard (static export) |
| `apps/streaming` | RTMP ingest + HLS transcoding server |
| `apps/docs` | Documentation site (Astro/Starlight) |
| `packages/shared` | Shared types, enums, platform adapter interface |
| `packages/core` | Platform-agnostic scene management, element managers |
| `packages/client` | HTTP + WebSocket client SDK |
| `packages/hud` | In-world management HUD (spatial UI overlay) |
| `packages/adapter-dcl` | Decentraland adapter |
| `packages/hyperfy-app` | Virvi app (`.hyp`) for self-run Hyperfy worlds |

## Quick Start

### Prerequisites

- Node.js >= 20
- pnpm >= 9
- Docker (for Postgres)

### Local Development

```bash
# Start Postgres
docker compose up -d

# Copy environment config
cp .env.example .env

# Install dependencies
pnpm install

# Start all services (server on :3010, web on :3000)
pnpm dev
```

### Environment Variables

See [.env.example](.env.example) for all options. The minimum required:

```
DATABASE_URL=postgresql://vlm:vlm_dev@localhost:5432/vlm
JWT_SECRET=your-secret-here
```

## Deployment Modes

Virvi supports three deployment modes via `VIRVI_MODE`:

| Mode | Use Case | Requirements |
|------|----------|--------------|
| `single` | Self-hosted, one server | Postgres only |
| `scalable` | Self-hosted, multiple servers | Postgres + Redis |
| `cloud` | Multi-tenant SaaS | Postgres + Redis + Stripe + S3/R2 |

### Railway (Cloud)

The project includes a `Dockerfile` (Railway builds it automatically) and `.railway/railway.ts`, which sets the start command and health check. Apply it with `railway config apply` (needs Node 22.6+ and the `railway` npm package), and add every variable you set to its `env` list or the next apply deletes it. Set these env vars on Railway:

- `DATABASE_URL` — Railway Postgres connection string
- `JWT_SECRET` — random 64-char string
- `NEXT_PUBLIC_API_URL` — your Railway public URL (e.g., `https://virvi-production.up.railway.app`)
- `NEXT_PUBLIC_WSS_URL` — same URL with `wss://` prefix

### Docker Compose (Self-Hosted)

```bash
# Single mode (one server + Postgres)
docker compose -f docker-compose.single.yml up -d

# Scalable mode (multiple servers + Postgres + Redis)
docker compose -f docker-compose.scalable.yml up -d
docker compose -f docker-compose.scalable.yml up -d --scale virvi=3
```

## Features

### Dashboard Pages

- **Scenes** — create/edit scenes, manage elements (video, image, model, sound, widget), real-time Colyseus sync
- **Events** — schedule events, link scenes, coordinate cross-platform activations
- **Giveaways** — create giveaways, add items, track claims
- **Images & Video** and **3D Models** — upload/manage images and video, and GLB models, with CDN delivery
- **Streaming** — provision HLS streaming servers, manage stream keys
- **Analytics** — visitor sessions, platform breakdown, action tracking per scene
- **Settings** — organization management, team invites, billing/subscription, API keys, account settings
- **Admin** — system stats, user management, org management (admin-only)

### Authentication

- Email/password with bcrypt
- Google OAuth
- Discord OAuth
- API keys (`virvi_k1_...` prefix)
- Web3 wallet signatures (platform auth)

### Billing (Cloud Mode)

Five-tier Stripe subscription system: Free, Creator, Pro, Studio, Enterprise. Tier limits enforce scene counts, storage quotas, and streaming minutes. Self-hosted modes have all features unlocked.

### Storage

- **Local** — filesystem storage (default for self-hosted)
- **S3/R2** — Cloudflare R2 or AWS S3 for persistent cloud storage

### API Documentation

When the server is running, Swagger UI is available at `/api/docs`.

## Spec Documents

- [VLM_V2_BUILD_SPEC.md](VLM_V2_BUILD_SPEC.md) — complete rebuild specification, architecture, and implementation details
- [VLM_V2_IMPLEMENTATION_PLAN.md](VLM_V2_IMPLEMENTATION_PLAN.md) — phased build plan with current status
- [VLM_V2_ADAPTER_DESIGNS.md](VLM_V2_ADAPTER_DESIGNS.md) — detailed designs for Decentraland, Hyperfy, and Second Life adapters
- [VLM_V2_WEBXR_SPEC.md](VLM_V2_WEBXR_SPEC.md) — WebXR "phygital" adapter for AR experiences in physical spaces (iPhone, Vision Pro, Quest)
- [VLM_V2_DCL_INSPECTOR_INTEGRATION.md](VLM_V2_DCL_INSPECTOR_INTEGRATION.md) — Embed DCL 3D inspector in dashboard + Virvi Smart Item for Creator Hub

## Testing

nvm use 20
pnpm docker:dev          # Postgres on :5432
pnpm --filter @virvixr/server test

## Tech Stack

- **Server:** Fastify 5, Colyseus, Drizzle ORM, PostgreSQL
- **Frontend:** Next.js 15, React 19, Tailwind CSS 4
- **Real-time:** Colyseus WebSocket (Redis presence for multi-instance)
- **Auth:** @fastify/jwt, bcryptjs, google-auth-library
- **Billing:** Stripe
- **Storage:** @aws-sdk/client-s3 (S3/R2), local filesystem
- **Email:** Nodemailer
- **Monitoring:** prom-client (Prometheus), @fastify/swagger
- **Build:** Turborepo, pnpm workspaces, TypeScript

## License

Virvi is open source, under the same licenses VLM used:

- Everything in this repository is under the [GNU General Public License v3.0](LICENSE) (GPL-3.0), except:
- `packages/dcl` (the `@virvixr/dcl` npm package) and `packages/hud`, which go into creators' own Decentraland scenes, are under the [Apache License 2.0](packages/dcl/LICENSE), so your scene can use any license you like.

Copyright 2023-2026 Livication LLC.
