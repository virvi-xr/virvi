---
title: Quickstart
description: Run your own Virvi server with Docker in a few minutes, or set up a local development checkout.
sidebar:
  order: 2
---

Using hosted Virvi? Sign in at [virvi.io](https://virvi.io) and skip to [Next steps](#next-steps).

## Option 1: Docker (recommended)

You need Docker with Compose and `openssl`.

```bash
git clone https://github.com/virvi-xr/virvi.git
cd virvi

# Secrets for the Compose file (it reads .env in this folder)
printf 'JWT_SECRET=%s\nPOSTGRES_PASSWORD=%s\n' "$(openssl rand -hex 32)" "$(openssl rand -hex 16)" > .env

# Build and start Postgres + Virvi
docker compose -f docker-compose.single.yml up -d --build

# Check it (wait for the build and first start)
curl -s http://localhost:3010/api/health
```

Open `http://localhost:3010` and sign up. The first account becomes the instance admin.

This works at `localhost:3010`. To serve it at your own address, see [Your own domain](/docs/self-hosting/docker-compose/#your-own-domain).

## Option 2: Local development

You need Node.js 20 or newer, pnpm 9 (`corepack enable`) and Docker (for Postgres).

```bash
git clone https://github.com/virvi-xr/virvi.git
cd virvi

# Postgres, Redis and MinIO
docker compose -f docker-compose.dev.yml up -d

# Install and build every package
pnpm install
pnpm turbo build

# Create the database tables (once, and again after schema changes)
cd apps/server
DATABASE_URL="postgresql://vlm:vlm_dev@localhost:5432/vlm" npx drizzle-kit push

# Start the API server on :3010 (restarts on changes)
DATABASE_URL="postgresql://vlm:vlm_dev@localhost:5432/vlm" \
JWT_SECRET="dev-secret" \
pnpm dev
```

In another terminal, start the dashboard on `http://localhost:3000`:

```bash
cd apps/web
NEXT_PUBLIC_API_URL=http://localhost:3010 \
NEXT_PUBLIC_WSS_URL=ws://localhost:3010 \
pnpm dev
```

The server doesn't create tables on its own outside Docker: run `drizzle-kit push` first, or every request fails.

## Option 3: A cloud host

The repo has files for Railway (`.railway/railway.ts`), Render (`render.yaml`) and Fly.io (`fly.toml`). Each needs a Postgres database and a few variables. See [Where to run it](/docs/self-hosting/overview/#where-to-run-it).

## Next steps

1. [Core Concepts](/docs/getting-started/concepts/): scenes, presets and elements.
2. [Images & Video and 3D Models](/docs/dashboard/media-library/): upload what your scene will show.
3. [Decentraland Setup](/docs/sdk/decentraland/install/): connect a Decentraland scene.
4. [Hyperfy Setup](/docs/sdk/hyperfy/install/): connect a Hyperfy world.
