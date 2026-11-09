---
title: Quickstart
description: Get Virvi running in 5 minutes
sidebar:
  order: 2
---

## Option 1: Docker (Recommended)

```bash
git clone https://github.com/virvi-xr/virvi.git
cd virvi

# Copy env file and set your JWT secret
cp .env.example .env
# Edit .env: set JWT_SECRET to a random string

# Start everything
docker compose -f docker-compose.single.yml up -d
```

Open `http://localhost:3010` — sign up, and you're the admin.

## Option 2: Local Development

**Prerequisites:** Node.js 20+, pnpm 9+, Docker (for Postgres)

```bash
git clone https://github.com/virvi-xr/virvi.git
cd virvi

# Start database
docker compose -f docker-compose.dev.yml up -d

# Install dependencies
pnpm install

# Build all packages
pnpm turbo build

# Start the server
cd apps/server
DATABASE_URL="postgresql://vlm:vlm_dev@localhost:5432/vlm" \
JWT_SECRET="dev-secret" \
npx tsx src/index.ts

# In another terminal — start the dashboard
cd apps/web
NEXT_PUBLIC_API_URL=http://localhost:3010 \
NEXT_PUBLIC_WSS_URL=ws://localhost:3010 \
pnpm dev
```

## Option 3: One-Click Deploy

- **Railway:** Click the "Deploy on Railway" button in the repo README
- **Render:** Use `render.yaml` — auto-provisions with a starter plan
- **Fly.io:** `fly launch` from the repo root

## Next Steps

1. [Core Concepts](/docs/getting-started/concepts) — understand scenes, presets, elements
2. [Dashboard Guide](/docs/dashboard/scenes) — create your first scene
3. [Decentraland Setup](/docs/sdk/decentraland/install) — connect a DCL scene
4. [Hyperfy Setup](/docs/sdk/hyperfy/install) — connect a Hyperfy world
