---
title: Updating and Troubleshooting
description: Update a self-hosted Virvi server, check its health, read its logs, and fix the common start-up and proxy problems.
sidebar:
  order: 4
---

The commands use `docker-compose.single.yml`. For scalable mode, use `docker-compose.scalable.yml` instead.

## Update

1. Back up the database:

   ```bash
   docker compose -f docker-compose.single.yml exec -T postgres pg_dump -U vlm vlm > virvi-$(date +%F).sql
   ```

2. Get the new code:

   ```bash
   git pull
   ```

3. Rebuild and restart. Pass the same `--build-arg` values you used before (see [Your own domain](/docs/self-hosting/docker-compose/#your-own-domain)):

   ```bash
   docker compose -f docker-compose.single.yml build
   docker compose -f docker-compose.single.yml up -d
   ```

4. Check it:

   ```bash
   curl -s http://localhost:3010/api/health
   docker compose -f docker-compose.single.yml logs --tail 100 virvi
   ```

The database schema updates itself when the container starts (`drizzle-kit push`). There are no migrations to run by hand.

The uploads and database volumes survive rebuilds. `docker compose down -v` deletes them.

To restore a backup into an empty database:

```bash
docker compose -f docker-compose.single.yml exec -T postgres psql -U vlm vlm < virvi-2026-11-09.sql
```

## Check health

```bash
curl -s http://localhost:3010/api/health
```

```json
{
  "status": "ok",
  "mode": "single",
  "version": "2.0.0",
  "timestamp": "2026-11-09T12:00:00.000Z",
  "checks": { "postgres": "ok", "redis": "not_configured", "storage": "local" },
  "uptime": 42.1
}
```

| Field | Meaning |
|---|---|
| HTTP status | `200` when Postgres answers `SELECT 1`; `503` otherwise, with `status: "degraded"` |
| `checks.postgres` | `ok`, or `error: <message>` |
| `checks.redis` | `configured` when rooms use Redis, else `not_configured`. It is not a live connection test |
| `checks.storage` | The storage setting. It is not a live test either |

`GET /api/instance` returns `{ mode, version, ... }` and needs no sign-in.

## Read the logs

```bash
docker compose -f docker-compose.single.yml logs -f virvi      # follow the server
docker compose -f docker-compose.single.yml logs -f postgres   # follow the database
```

Lines from the server start with `[virvi-server]`. A healthy start includes, in order:

```text
[virvi-server] Running drizzle-kit push to sync schema...
[virvi-server] Ensuring critical schema columns exist...
[virvi-server] Starting in "single" mode
[virvi-server] Database connection verified
[virvi-server] Venue constraints ensured
[virvi-server] Docs served at /docs from /app/apps/docs/dist
[virvi-server] Serving dashboard from /app/dashboard
[virvi-server] HTTP listening on port 3010
[virvi-server] In-memory presence (single instance)
[virvi-server] Ready at https://virvi.example.com
```

In scalable mode with Redis you see `Redis presence enabled` instead of `In-memory presence`.

`LOG_LEVEL=debug` logs more. Every response carries an `x-request-id` header; the server's request logs carry the same ID.

## Common problems

### The server exits at once

| Log line | Cause | Fix |
|---|---|---|
| `FATAL: DATABASE_URL environment variable is required` | `DATABASE_URL` isn't set | Set it. The Compose files set it for you |
| `JWT_SECRET must be set in production` | `JWT_SECRET` is unset or the development default | Set a long random value |
| `TRIALS_ENABLED must be true or false` | A typo | Use `true` or `false`, or remove it |
| `SCENE_BUILD_RUNNER must be fly, local or off` | A typo | Use one of the three, or remove it |
| `invalid setting: ...` | A Design Studio limit isn't a whole number | Fix or remove it |
| Compose: `Set JWT_SECRET in .env` | `.env` has no `JWT_SECRET` | Add it to `.env` in the repo root |

### Can't reach the database

`/api/health` answers `503` with `"postgres": "error: ..."`, or the log shows `Migration skipped or failed: ...`.

- Check Postgres is up: `docker compose -f docker-compose.single.yml ps`.
- Check `DATABASE_URL`: user, password, host and database name. Inside Compose the host is `postgres`, not `localhost`.
- Changed `POSTGRES_PASSWORD` after the first start? Postgres keeps its original password. Set it back, or change the password inside Postgres to match.
- A managed database may need `?sslmode=require` on the URL.

### The schema sync failed

The log shows `drizzle-kit push failed, trying raw SQL fallback...`. The server still starts and the fallback adds the newest tables and columns, but some changes may be missing.

- Read the lines just above it for the reason.
- Make sure the database user can create tables and types.
- To run the sync by hand from a checkout: `cd apps/server && DATABASE_URL="postgresql://..." npx drizzle-kit push`.

### Bookings can overlap

The log shows `Venue constraints could not be ensured — double-booking protection is OFF`. The database user couldn't add the `btree_gist` extension. Run `CREATE EXTENSION IF NOT EXISTS btree_gist;` as a superuser, then restart.

### The dashboard doesn't load, or loads but can't sign in

- Log shows `No dashboard directory at ... — API-only mode`: the image was built without the dashboard, or `DASHBOARD_DIR` points elsewhere. Rebuild the image, or fix `DASHBOARD_DIR`.
- The page loads but every request fails, or goes to `localhost:3010`: the image was built without your address. Set `PUBLIC_URL` and `NEXT_PUBLIC_WSS_URL` in `.env` and rebuild ([Your own domain](/docs/self-hosting/docker-compose/#your-own-domain)).
- Real-time updates don't arrive: your proxy isn't passing WebSocket upgrades to port 3010.
- Uploaded files 404 or point at the wrong host: set `PUBLIC_URL` to the public address.

### `/docs` is missing

The log shows `Docs not built (...)`. The image has the docs at `/app/apps/docs/dist`, found from the working directory `/app`. If you run the server from somewhere else, set `DOCS_DIR` to that folder's absolute path. Outside Docker, build them with `pnpm --filter @virvixr/docs build`.

### Everyone hits the rate limit, or analytics shows one visitor

Every visitor looks like the proxy's IP address. `TRUST_PROXY_HOPS` is too low: set it to the number of proxies in front of the server (Railway: `2`). See [TRUST_PROXY_HOPS](/docs/self-hosting/environment-variables/#trust_proxy_hops).

If you have no proxy, set it to `0`; otherwise visitors can choose their own IP address with an `X-Forwarded-For` header.

### Players on different servers don't see each other's changes

Scalable mode won't start without `REDIS_URL` (`REDIS_URL must be set in scalable mode`). Set it on every server, all pointing at the same Redis.

### Scene imports are refused

`SCENE_BUILD_RUNNER` is `off` by default outside cloud mode, so uploads are refused. The `local` runner is for development only and isn't in the Docker image. In scalable mode, imports also need `SCENE_IMPORT_S3_URI`.

### Emails don't arrive

The log shows `SMTP not configured, skipping email to ...`. Set `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS` and `EMAIL_FROM`, in `.env`, then `docker compose up -d`.

### A setting has no effect

- With Compose, is it also set under the `virvi` service's `environment:`? Those lines win over `.env`.
- Did you restart the container after changing `.env`? (`docker compose up -d` recreates it.)
- Variables starting `NEXT_PUBLIC_` take effect only when the image is rebuilt.

### `Server room limit reached`

A server holds at most `MAX_ROOMS` scene rooms at once (50 in single mode). Raise `MAX_ROOMS`, or run scalable mode.
