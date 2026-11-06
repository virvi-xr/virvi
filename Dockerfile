# =============================================================================
# Virvi V2 — Production Dockerfile
# One image for all modes (single / scalable / cloud). Behavior controlled by
# environment variables at runtime. See .env.example for full reference.
# =============================================================================

# ── Stage 1: Build ───────────────────────────────────────────────────────────
FROM node:20-alpine AS builder
WORKDIR /app

RUN corepack enable && corepack prepare pnpm@9.15.0 --activate

# Copy workspace config and package manifests first (layer cache)
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json turbo.json tsconfig.base.json ./
COPY patches ./patches
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY apps/streaming/package.json apps/streaming/
COPY apps/docs/package.json apps/docs/
COPY packages/shared/package.json packages/shared/
COPY packages/core/package.json packages/core/
COPY packages/client/package.json packages/client/
COPY packages/hud/package.json packages/hud/
COPY packages/adapter-dcl/package.json packages/adapter-dcl/
COPY packages/hyperfy-app/package.json packages/hyperfy-app/

RUN pnpm install --frozen-lockfile

# Copy source and build everything
COPY . .

# NEXT_PUBLIC_* vars are inlined at build time by Next.js.
# Set via Railway env vars or --build-arg.
ARG NEXT_PUBLIC_API_URL
ARG NEXT_PUBLIC_WSS_URL
ARG NEXT_PUBLIC_DOCS_URL
ARG NEXT_PUBLIC_DISCORD_URL
ARG NEXT_PUBLIC_TURNSTILE_SITE_KEY
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL
ENV NEXT_PUBLIC_WSS_URL=$NEXT_PUBLIC_WSS_URL
ENV NEXT_PUBLIC_DOCS_URL=$NEXT_PUBLIC_DOCS_URL
ENV NEXT_PUBLIC_DISCORD_URL=$NEXT_PUBLIC_DISCORD_URL
ENV NEXT_PUBLIC_TURNSTILE_SITE_KEY=$NEXT_PUBLIC_TURNSTILE_SITE_KEY

RUN pnpm turbo build

# Copy the Next.js static export into the dashboard directory
RUN cp -r apps/web/out dashboard \
    && echo "--- Dashboard build verification ---" \
    && ls -la dashboard/ \
    && test -f dashboard/index.html \
    && echo "--- Dashboard OK ---"

# Remove source files to reduce image size (keep dist + node_modules)
# Keep apps/server/src/db/schema.ts — drizzle-kit push needs it at runtime
RUN find apps/server/src -name '*.ts' -not -path '*/db/schema.ts' -delete 2>/dev/null; \
    find packages -name '*.ts' -not -path '*/node_modules/*' -delete 2>/dev/null; \
    rm -rf apps/web/src apps/docs/src apps/streaming/src test-scenes .git; \
    true

# ── Stage 2: Runtime ─────────────────────────────────────────────────────────
FROM node:20-alpine
WORKDIR /app

# Optional: FFmpeg for HLS streaming support
RUN apk add --no-cache ffmpeg

# Copy the entire built monorepo (preserves pnpm symlink structure)
COPY --from=builder /app ./

# Create uploads directory for local storage
RUN mkdir -p /app/uploads /app/private

ENV NODE_ENV=production
ENV DASHBOARD_DIR=/app/dashboard

# Make entrypoint executable
RUN chmod +x apps/server/entrypoint.sh

# Entrypoint: sync DB schema then start server
CMD ["apps/server/entrypoint.sh"]
