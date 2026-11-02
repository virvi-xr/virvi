/**
 * Server configuration — driven by VIRVI_MODE with per-variable overrides.
 *
 * Modes:
 *   single   — Self-hosted, one server, in-memory Colyseus presence
 *   scalable — Self-hosted, multiple servers + Redis presence
 *   cloud    — Hosted virvi.io SaaS, multi-tenant, billing enabled
 */

import { resolve } from 'node:path'

export type VirviMode = 'single' | 'scalable' | 'cloud'

function env(key: string): string | undefined {
  return process.env[key]
}

const mode: VirviMode = (env('VIRVI_MODE') as VirviMode) || 'single'

/**
 * True when Colyseus runs on Redis presence and driver, so a scene's rooms can live in other processes. Process-local
 * state shared with the rooms (the draft-holds registry) is only whole when this is false.
 */
export function roomsDistributed(c: { useRedisPresence: boolean; redisUrl?: string } = config): boolean {
  return c.useRedisPresence && !!c.redisUrl
}

/** A whole-number setting; a bad value refuses to start rather than silently changing a limit. */
function positiveInt(raw: string | undefined, def: number, zeroOk = false): number {
  if (raw === undefined || raw === '') return def
  const n = Number(raw)
  if (!Number.isInteger(n) || n < (zeroOk ? 0 : 1)) throw new Error(`invalid setting: ${raw}`)
  return n
}

/** Design Studio prices in US cents, each a setting (see src/studio/README.md). A bad value refuses to start. */
export function studioPricesFrom(e: Record<string, string | undefined>) {
  const cents = (name: string, def: number) => {
    const raw = e[name]
    if (raw === undefined || raw === '') return def
    if (!/^\d+$/.test(raw)) throw new Error(`${name} must be a whole number of cents`)
    return Number(raw)
  }
  return {
    wearable: cents('STUDIO_PRICE_WEARABLE_CENTS', 2900),
    extraPiece: cents('STUDIO_PRICE_EXTRA_PIECE_CENTS', 1900),
    emote: cents('STUDIO_PRICE_EMOTE_CENTS', 3900),
    revisionWearable: cents('STUDIO_REVISION_WEARABLE_CENTS', 1500),
    revisionExtraPiece: cents('STUDIO_REVISION_EXTRA_PIECE_CENTS', 1000),
    revisionEmote: cents('STUDIO_REVISION_EMOTE_CENTS', 2000),
    topupCents: cents('STUDIO_TOPUP_CENTS', 500),
    topupPrompts: cents('STUDIO_TOPUP_PROMPTS', 10),
  }
}

/** Refuse to start a production-like server on the well-known development JWT secret. */
export function assertProductionSecrets(c: { mode: VirviMode; nodeEnv?: string; jwtSecret: string }): void {
  const production = c.mode === 'cloud' || c.nodeEnv === 'production'
  if (production && (!c.jwtSecret || c.jwtSecret === 'dev-secret-change-me')) {
    throw new Error('JWT_SECRET must be set in production')
  }
}

/**
 * Normalise comma-separated SHA-256 certificate fingerprints to Google's assetlinks format (`AA:BB:...`): accepts any
 * case, with or without colons or spaces. Entries that aren't 64 hex digits are dropped, warned by index only.
 */
export function normalizeCertFingerprints(raw: string): string[] {
  const out: string[] = []
  raw.split(',').forEach((entry, i) => {
    const hex = entry.replace(/[\s:]/g, '').toUpperCase()
    if (!hex) return
    if (!/^[0-9A-F]{64}$/.test(hex)) {
      console.warn(`[virvi-config] ANDROID_CERT_SHA256 entry ${i} is not a SHA-256 fingerprint, ignoring it`)
      return
    }
    out.push(hex.match(/../g)!.join(':'))
  })
  return out
}

/** Order of secp256k1: a private key must be in [1, n). */
const SECP256K1_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n

/**
 * VIRVI_DCL_DEPLOY_KEY checked once at startup: a 32-byte hex secp256k1 private key, returned 0x-prefixed. A
 * malformed key is treated as unset (Virvi deploys show as unavailable) with a warning that never includes it,
 * instead of throwing on every use.
 */
export function validDeployKey(raw: string | undefined): string | null {
  const hex = raw?.trim().replace(/^0x/i, '') ?? ''
  if (!hex) return null
  if (/^[0-9a-f]{64}$/i.test(hex)) {
    const n = BigInt(`0x${hex}`)
    if (n > 0n && n < SECP256K1_N) return `0x${hex}`
  }
  console.warn('[virvi-config] VIRVI_DCL_DEPLOY_KEY is not a valid private key (32 bytes of hex); Virvi deploys are off until it is fixed')
  return null
}

export const config = {
  mode,

  // ── Server ──────────────────────────────────────────────────────────────
  port: parseInt(env('PORT') || '3010'),
  publicUrl: env('PUBLIC_URL') || 'http://localhost:3010',
  webAppUrl: env('WEB_APP_URL') || env('PUBLIC_URL') || 'http://localhost:3010',
  logLevel: env('LOG_LEVEL') || (env('NODE_ENV') === 'production' ? 'info' : 'debug'),

  // ── Android app links (/.well-known/assetlinks.json) ─────────────────────
  androidAppPackage: env('ANDROID_APP_PACKAGE') || 'io.virvi.ar',
  // Release-key SHA-256 fingerprints, comma-separated; empty until the app is signed
  androidCertSha256: normalizeCertFingerprints(env('ANDROID_CERT_SHA256') || ''),

  // ── Virvi Spaces reports ───────────────────────────────────────────────────
  // Where a visitor's "Report this space" is emailed (best-effort; reports are always stored and shown on /admin)
  arReportsEmail: env('AR_REPORTS_EMAIL') || 'support@virvi.io',

  // ── Database ────────────────────────────────────────────────────────────
  databaseUrl: env('DATABASE_URL')!,
  dbPoolMax: parseInt(env('DB_POOL_MAX') || (mode === 'single' ? '10' : '20')),

  // ── Auth ─────────────────────────────────────────────────────────────────
  jwtSecret: env('JWT_SECRET') || 'dev-secret-change-me',
  jwtAccessExpiry: env('JWT_ACCESS_EXPIRY') || '15m',
  jwtRefreshExpiry: env('JWT_REFRESH_EXPIRY') || '7d',
  // Accept unverified DCL platform logins (local preview only — never in production)
  allowUnverifiedPlatformAuth: env('ALLOW_UNVERIFIED_PLATFORM_AUTH') === 'true',

  // Let platform hooks call back to private/loopback addresses (local development and tests only)
  allowPrivateCallbackUrls: env('ALLOW_PRIVATE_CALLBACK_URLS') === 'true',

  // ── Google OAuth ──────────────────────────────────────────────────────────
  googleClientId: env('GOOGLE_CLIENT_ID'),
  googleClientSecret: env('GOOGLE_CLIENT_SECRET'),
  oauthCallbackUrl: env('OAUTH_CALLBACK_URL') || env('PUBLIC_URL') || 'http://localhost:3010',

  // ── Discord OAuth ────────────────────────────────────────────────────────
  discordClientId: env('DISCORD_CLIENT_ID'),
  discordClientSecret: env('DISCORD_CLIENT_SECRET'),

  // ── Colyseus Presence ───────────────────────────────────────────────────
  // single: in-memory (no Redis needed)
  // scalable/cloud: Redis required for cross-server room routing
  useRedisPresence: env('REDIS_URL')
    ? true
    : mode !== 'single',
  redisUrl: env('REDIS_URL'),

  // ── Billing & Feature Gating ────────────────────────────────────────────
  billingEnabled: env('STRIPE_SECRET_KEY')
    ? true
    : mode === 'cloud',
  stripeSecretKey: env('STRIPE_SECRET_KEY'),
  stripeWebhookSecret: env('STRIPE_WEBHOOK_SECRET'),

  // All features unlocked when billing is disabled (self-hosted gets everything)
  allFeaturesUnlocked: !env('STRIPE_SECRET_KEY') && mode !== 'cloud',

  // ── Multi-tenancy ───────────────────────────────────────────────────────
  multiTenant: env('MULTI_TENANT')
    ? env('MULTI_TENANT') === 'true'
    : mode === 'cloud',

  // ── Storage ─────────────────────────────────────────────────────────────
  storageProvider: env('STORAGE_PROVIDER')
    || (mode === 'cloud' ? 's3' : 'local'),
  cdnUrl: env('CDN_URL') || null,

  // Decentraland wallet Virvi deploys Worlds scenes with ("Let Virvi deploy for me"). Env only:
  // never logged, never returned.
  virviDclDeployKey: validDeployKey(env('VIRVI_DCL_DEPLOY_KEY')),

  // Supabase (single mode default external storage)
  supabaseUrl: env('SUPABASE_URL'),
  supabaseAnonKey: env('SUPABASE_ANON_KEY'),
  supabaseServiceKey: env('SUPABASE_SERVICE_KEY'),

  // S3 / R2
  s3Bucket: env('S3_BUCKET'),
  s3Region: env('S3_REGION'),
  s3Endpoint: env('S3_ENDPOINT'), // For R2 or MinIO

  // Local filesystem
  localStoragePath: env('LOCAL_STORAGE_PATH') || './uploads',
  // Private local objects (single mode scene imports). Never under localStoragePath: that folder is served at /uploads/
  privateStoragePath: env('PRIVATE_STORAGE_PATH') || resolve(env('LOCAL_STORAGE_PATH') || './uploads', '..', 'private'),

  // ── Streaming ───────────────────────────────────────────────────────────
  streamingEnabled: env('ENABLE_STREAMING') === 'true' || mode === 'cloud',

  // ── Hosted Hyperfy worlds (Fly) ─────────────────────────────────────────
  // Offered only when the provider is `fly` and every value below is set (see hyperfyHosting()).
  hyperfyInfraProvider: env('HYPERFY_INFRA_PROVIDER'),
  flyApiToken: env('FLY_API_TOKEN'), // scoped to the worlds org only
  flyWorldsOrg: env('FLY_WORLDS_ORG'),
  hyperfyImage: env('HYPERFY_IMAGE'), // registry.fly.io/vlm-hyperfy-image:<git-sha>
  // How world roles/schemas are created and dropped: `fly-job` (default on fly; in a one-shot machine of
  // HYPERFY_DB_JOB_APP, inside Fly's private network, with the admin URL as that app's secret DB_ADMIN_URL) or `direct`
  // (from this server, with HYPERFY_WORLDS_DATABASE_URL). Resolved by worldsDbMode().
  hyperfyWorldsDatabaseUrl: env('HYPERFY_WORLDS_DATABASE_URL'), // admin URL, direct mode only
  hyperfyWorldsDbMode: env('HYPERFY_WORLDS_DB_MODE'),
  hyperfyDbJobApp: env('HYPERFY_DB_JOB_APP') ?? 'vlm-worlds-db-jobs',
  hyperfyWorldsDbUrlTemplate: env('HYPERFY_WORLDS_DB_URL_TEMPLATE'), // what worlds connect with; {user} and {password}
  hyperfyAssetsS3Uri: env('HYPERFY_ASSETS_S3_URI'), // s3://<key>:<secret>@<account>.r2.cloudflarestorage.com/<bucket>
  hyperfyAssetsBaseUrl: env('HYPERFY_ASSETS_BASE_URL'), // the bucket's CDN origin
  hyperfyRouterDomain: env('HYPERFY_ROUTER_DOMAIN'), // worlds.virvi.io
  hyperfySecretKey: env('HYPERFY_SECRET_KEY'), // 32-byte hex, encrypts admin codes

  // ── Design Studio (cloud only; see src/studio/README.md) ───────────────
  studioWorkerImage: env('STUDIO_WORKER_IMAGE'), // registry.fly.io/vlm-studio-worker:<git-sha>
  studioS3Uri: env('STUDIO_S3_URI'), // private bucket, s3://<key>:<secret>@<account>.r2.cloudflarestorage.com/<bucket>, or file://<dir>
  // Scene imports (uploaded sources, built output, logs): private bucket, s3://<key>:<secret>@<account>.r2.cloudflarestorage.com/<bucket>, or file://<dir>
  // Outside cloud mode it falls back to <LOCAL_STORAGE_PATH>/private (storage/private-store.ts)
  sceneImportS3Uri: env('SCENE_IMPORT_S3_URI'),
  studioFlyApp: env('STUDIO_FLY_APP') || 'vlm-studio-worker',
  // `external`: Virvi never creates or starts worker machines; a worker is run by hand (local development)
  studioMachines: (env('STUDIO_MACHINES') === 'external' ? 'external' : 'fly') as 'fly' | 'external',
  studioClaudeModel: env('STUDIO_CLAUDE_MODEL') || 'claude-opus-5-5',
  studioCodexModel: env('STUDIO_CODEX_MODEL') || 'gpt-6.1-sol',
  studioGrokModel: env('STUDIO_GROK_MODEL') || 'grok-build-0.1',
  studioPrices: studioPricesFrom(process.env),
  // Turn-downs: who hears about an account that keeps sending off-topic work, after how many in how long, and how many
  // mistake refunds per piece are instant before the rest wait for review (src/studio/scope.ts)
  studioFlag: {
    email: env('STUDIO_FLAG_EMAIL') || null,
    threshold: positiveInt(env('STUDIO_FLAG_THRESHOLD'), 3),
    windowHours: positiveInt(env('STUDIO_FLAG_WINDOW_HOURS'), 24),
    instantReports: positiveInt(env('STUDIO_INSTANT_REPORTS'), 2, true),
  },
  studioEnabled: mode === 'cloud' && !!env('STUDIO_WORKER_IMAGE') && !!env('STUDIO_S3_URI'),

  // ── Metrics ─────────────────────────────────────────────────────────────
  metricsEnabled: env('ENABLE_METRICS') === 'true' || mode !== 'single',

  // ── Auto-Promote First User ─────────────────────────────────────────────
  // In single/scalable mode, the first signup automatically becomes admin
  autoPromoteFirstUser: mode !== 'cloud',

  // ── Rate Limiting ──────────────────────────────────────────────────────
  rateLimitMax: parseInt(env('RATE_LIMIT_MAX') || '300'),
  // Reverse-proxy hops to trust for client IP (Railway = 1)
  trustProxyHops: ((n) => (Number.isNaN(n) || n < 0 ? 1 : n))(parseInt(env('TRUST_PROXY_HOPS') || '1')),

  // ── CORS ──────────────────────────────────────────────────────────────
  corsOrigins: [
    env('PUBLIC_URL') || 'http://localhost:3010',
    ...(env('CORS_ORIGINS') ? env('CORS_ORIGINS')!.split(',').map((s) => s.trim()).filter(Boolean) : []),
  ],

  // ── Email ──────────────────────────────────────────────────────────────
  smtpHost: env('SMTP_HOST'),
  smtpPort: parseInt(env('SMTP_PORT') || '587'),
  smtpUser: env('SMTP_USER'),
  smtpPass: env('SMTP_PASS'),
  emailFrom: env('EMAIL_FROM') || 'noreply@virvi.io',

  // ── Limits ──────────────────────────────────────────────────────────────
  maxRoomsPerServer: parseInt(env('MAX_ROOMS') || (mode === 'single' ? '50' : '500')),
  maxUploadSize: parseInt(env('MAX_UPLOAD_MB') || '100') * 1024 * 1024,

  // How often the venue booking lifecycle sweep runs (0 disables, used in tests)
  lifecycleSweepMs: parseInt(env('LIFECYCLE_SWEEP_MS') || '5000'),
  dclRedeploySweepMs: parseInt(env('DCL_REDEPLOY_SWEEP_MS') || '30000'),

  // Analytics background jobs (session close, rollups, retention); disabled in tests
  analyticsJobsEnabled: env('ANALYTICS_JOBS') !== 'false',

  // ── Decentraland directory (analytics scene validation & claims) ───────
  catalystUrl: env('DCL_CATALYST_URL') || 'https://peer.decentraland.org',
  worldsUrl: env('DCL_WORLDS_URL') || 'https://worlds-content-server.decentraland.org',

  // ── Dashboard ───────────────────────────────────────────────────────────
  dashboardDir: env('DASHBOARD_DIR') || './dashboard',
} as const
