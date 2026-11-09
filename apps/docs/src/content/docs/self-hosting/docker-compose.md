---
title: Docker Compose
description: Run Virvi with the repo's Docker Compose files, step by step, including your own domain, more variables, scaling and live streaming.
sidebar:
  order: 2
---

The repo has three Compose files at its root:

| File | Services | For |
|---|---|---|
| `docker-compose.single.yml` | `postgres` (16), `virvi` | One server. No Redis. |
| `docker-compose.scalable.yml` | `postgres` (16), `redis` (7), `virvi` | Several Virvi containers sharing Redis. |
| `docker-compose.dev.yml` | `postgres` (16), `redis` (7), `minio` | Local development. Runs no Virvi server. |

The `virvi` service builds the root `Dockerfile` (Node 20, Alpine). The image holds the API server, the dashboard, these docs and FFmpeg.

## Single mode

Run every command from the repo root.

### 1. Get the code

```bash
git clone https://github.com/virvi-xr/virvi.git
cd virvi
```

### 2. Write `.env`

Docker Compose reads `.env` in the repo root to fill in the Compose file. Single mode uses these four:

```bash
cat > .env <<EOF
JWT_SECRET=$(openssl rand -hex 32)
POSTGRES_PASSWORD=$(openssl rand -hex 16)
PUBLIC_URL=http://localhost:3010
PORT=3010
EOF
```

| Variable | Needed | Used for |
|---|---|---|
| `JWT_SECRET` | Yes. Compose stops with `Set JWT_SECRET in .env` without it | Signing sign-in tokens |
| `POSTGRES_PASSWORD` | No (default `vlm_prod`). Set your own | The `vlm` database user's password |
| `PUBLIC_URL` | No (default `http://localhost:3010`) | The address people use to reach the server |
| `PORT` | No (default `3010`) | The port on the host. The container always listens on 3010 |

Set `POSTGRES_PASSWORD` before the first start. Postgres keeps the password it was created with; changing it later breaks the connection.

### 3. Start

```bash
docker compose -f docker-compose.single.yml up -d --build
```

The first build takes several minutes. On start, the container syncs the database schema, then starts the server.

### 4. Check it

```bash
curl -s http://localhost:3010/api/health
```

A healthy server answers `200` with `"status":"ok"` and `"postgres":"ok"`. See [Updating and Troubleshooting](/docs/self-hosting/updating-and-troubleshooting/) if not.

### 5. Create the admin account

Open `http://localhost:3010` and sign up. The first account on a new install becomes its instance admin. Do this straight away on a public server: whoever signs up first gets admin.

### What the single file sets up

- `postgres`: database `vlm`, user `vlm`, data in the `pgdata` volume. Port 5432 is also published on the host; remove that `ports:` entry if the host is public.
- `virvi`: `VIRVI_MODE=single`, `STORAGE_PROVIDER=local`, uploads in the `uploads` volume (`/app/uploads`) and private import files in the `private` volume (`/app/private`).

## Your own domain

Two things change when people reach the server at a real address, such as `https://virvi.example.com`.

**1. The dashboard's API address is built into the image.** The dashboard calls `http://localhost:3010` unless you build it with your address:

```bash
docker compose -f docker-compose.single.yml build \
  --build-arg NEXT_PUBLIC_API_URL=https://virvi.example.com \
  --build-arg NEXT_PUBLIC_WSS_URL=wss://virvi.example.com
docker compose -f docker-compose.single.yml up -d
```

**2. The server needs its public address and the proxy count.** Set `PUBLIC_URL=https://virvi.example.com` in `.env`, and set [`TRUST_PROXY_HOPS`](/docs/self-hosting/environment-variables/#trust_proxy_hops) for your proxy (see below).

Put a reverse proxy (Caddy, nginx, Traefik) in front for HTTPS. It must pass WebSocket upgrades: real-time sync runs on the same port as the API. With Caddy, `reverse_proxy localhost:3010` does both.

## Adding more variables

The Compose files pass only the variables listed under the `virvi` service's `environment:`. Adding a line to `.env` alone does nothing for the server. To set more (SMTP, OAuth, `TRUST_PROXY_HOPS` and so on), add them to that list:

```yaml
  virvi:
    environment:
      # ...the existing lines...
      TRUST_PROXY_HOPS: ${TRUST_PROXY_HOPS:-1}
      SMTP_HOST: ${SMTP_HOST}
      EMAIL_FROM: ${EMAIL_FROM}
```

Or add `env_file: .env` to the `virvi` service to pass every line of `.env`. The full list is in [Environment Variables](/docs/self-hosting/environment-variables/).

Then apply it:

```bash
docker compose -f docker-compose.single.yml up -d
```

## Scalable mode

`docker-compose.scalable.yml` adds Redis (`REDIS_URL=redis://redis:6379`) so real-time rooms work across several Virvi containers.

```bash
docker compose -f docker-compose.scalable.yml up -d --build
```

**Scaling past one container needs a change.** The `virvi` service publishes host port `${PORT:-3010}`, and only one container can hold it, so `--scale virvi=3` fails as written. To run several:

1. Remove the `ports:` entry from the `virvi` service.
2. Add a load balancer service on the same Compose network that forwards to `virvi:3010` and passes WebSocket upgrades.
3. Then run `docker compose -f docker-compose.scalable.yml up -d --scale virvi=3`.

Other things to know:

- All containers share the `uploads` volume, so local storage works only while they run on one Docker host. Across hosts, use `STORAGE_PROVIDER=s3` or `r2`.
- Scene imports need `SCENE_IMPORT_S3_URI` in scalable mode; the scalable file has no private volume.
- `/metrics` is always on in scalable mode and has no authentication. Don't expose it.
- Every container syncs the database schema when it starts.

## Live streaming

Live streaming needs the separate media server in `apps/streaming` (RTMP in, HLS out). It isn't in the Compose files.

Build and run it:

```bash
docker build -f apps/streaming/Dockerfile -t virvi-streaming .
docker run -d --name virvi-streaming \
  -p 1935:1935 -p 8000:8000 \
  -e VIRVI_API_URL=http://<virvi-server-host>:3010 \
  -e VIRVI_WEBHOOK_KEY=<shared-secret> \
  -v virvi-streams:/data/streams \
  virvi-streaming
```

| Media server variable | Default | What it does |
|---|---|---|
| `VIRVI_API_URL` | `http://localhost:3010` | The Virvi server it checks stream keys with |
| `VIRVI_WEBHOOK_KEY` | none | Shared secret; must equal the server's `STREAMING_WEBHOOK_KEY` |
| `RTMP_PORT` | `1935` | RTMP ingest port |
| `HTTP_PORT` | `8000` | HLS playback port (`/streams/<playbackId>/playlist.m3u8`) |
| `OUTPUT_DIR` | `/data/streams` in the image | Where HLS segments are written |
| `MAX_STREAMS` | `4` | Most streams transcoded at once |
| `ENABLE_ABR` | off | `true` transcodes several qualities |
| `FFMPEG_PATH` | `ffmpeg` | FFmpeg binary (included in the image) |

Then set on the Virvi server: `ENABLE_STREAMING=true`, `STREAMING_WEBHOOK_KEY` (the same secret), `RTMP_INGEST_URL` (for example `rtmp://stream.example.com:1935/live`) and `HLS_BASE_URL` (for example `https://stream.example.com/streams`, behind HTTPS).

## Development

`docker-compose.dev.yml` starts Postgres (user and password `vlm` / `vlm_dev`), Redis and MinIO (console on port 9001, `vlm_dev` / `vlm_dev_secret`). Run the server and dashboard yourself: see [Quickstart](/docs/getting-started/quickstart/#option-2-local-development).

```bash
docker compose -f docker-compose.dev.yml up -d
```

## Stop and remove

```bash
docker compose -f docker-compose.single.yml down      # stop; data volumes stay
docker compose -f docker-compose.single.yml down -v   # stop and DELETE the database and uploads
```
