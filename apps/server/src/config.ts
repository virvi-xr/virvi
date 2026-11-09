/**
 * Server configuration — driven by VIRVI_MODE with per-variable overrides.
 *
 * Modes:
 *   single   — Self-hosted, one server, in-memory Colyseus presence
 *   scalable — Self-hosted, multiple servers + Redis presence
 *   cloud    — Hosted virvi.io SaaS, multi-tenant, billing enabled
 */

import { resolve } from 'node:path'
import { readFileSync } from 'node:fs'
import { getAddress } from 'ethers'

export type VirviMode = 'single' | 'scalable' | 'cloud'

function env(key: string): string | undefined {
  return process.env[key]
}

function numEnv(key: string, fallback: number): number {
  const n = parseFloat(env(key) ?? '')
  return Number.isFinite(n) && n >= 0 ? n : fallback
}
const intEnv = (key: string, fallback: number) => Math.floor(numEnv(key, fallback))

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

/**
 * TRIALS_ENABLED: signed-out Design Studio trials. Unset, they are on in cloud mode and off in single/scalable mode
 * (the Design Studio only runs in cloud mode, and a self-hosted install has no bot check for them); `true` or `false`
 * overrides. Another value refuses to start rather than guess.
 */
export function trialsEnabledFrom(raw: string | undefined, m: VirviMode): boolean {
  if (raw === undefined || raw === '') return m === 'cloud'
  if (raw === 'true' || raw === 'false') return raw === 'true'
  throw new Error(`TRIALS_ENABLED must be true or false, not ${raw}`)
}

export type SceneBuildRunner = 'fly' | 'local' | 'off'

/** SCENE_BUILD_RUNNER; a value other than the three refuses to start rather than silently turning builds off. */
export function sceneBuildRunnerFrom(raw: string | undefined, m: VirviMode): SceneBuildRunner {
  if (raw === undefined || raw === '') return m === 'cloud' ? 'fly' : 'off'
  if (raw === 'fly' || raw === 'local' || raw === 'off') return raw
  throw new Error(`SCENE_BUILD_RUNNER must be fly, local or off, not ${raw}`)
}

/**
 * Paying for studio work in MANA on Polygon PoS. Off (recipient null) until STUDIO_MANA_RECIPIENT is set; a recipient
 * or STUDIO_MANA_TOKEN that is not a valid, correctly checksummed address refuses to start. The token default must be confirmed on Polygonscan
 * before MANA is turned on. A wrong token makes verification fail closed, so nothing is settled by mistake.
 */
export function manaSettingsFrom(e: Record<string, string | undefined>) {
  const rawRecipient = e.STUDIO_MANA_RECIPIENT
  let recipient: string | null = null
  if (rawRecipient !== undefined && rawRecipient !== '') {
    try {
      recipient = getAddress(rawRecipient)
    } catch {
      throw new Error('STUDIO_MANA_RECIPIENT must be a valid, correctly checksummed Polygon address')
    }
  }
  // The page sends its transfer to this contract, so a bad value refuses to start too
  let token: string
  try {
    token = getAddress(e.STUDIO_MANA_TOKEN || '0xA1c57f48F0Deb89f569dFbE6E2B7f46D33606fD4')
  } catch {
    throw new Error('STUDIO_MANA_TOKEN must be a valid, correctly checksummed Polygon address')
  }
  return {
    recipient,
    rpcUrl: e.POLYGON_RPC_URL || 'https://polygon-rpc.com',
    token,
    chainId: 137 as const,
    quoteTtlMs: 600000 as const, // a quote holds for 10 minutes
    graceMs: 900000 as const, // a late transaction still settles within 15 minutes after that
    confirmations: 30 as const,
  }
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
    // Scene designs: furniture, and buildings by footprint (small 0.5x0.5 and 1x1, medium 1x2 and 2x2, large 4x4)
    furniture: cents('STUDIO_PRICE_FURNITURE_CENTS', 900),
    furnitureExtra: cents('STUDIO_PRICE_FURNITURE_EXTRA_CENTS', 500),
    revisionFurniture: cents('STUDIO_REVISION_FURNITURE_CENTS', 500),
    buildingSmall: cents('STUDIO_PRICE_BUILDING_SMALL_CENTS', 2900),
    buildingMedium: cents('STUDIO_PRICE_BUILDING_MEDIUM_CENTS', 4900),
    buildingLarge: cents('STUDIO_PRICE_BUILDING_LARGE_CENTS', 7900),
    revisionBuildingSmall: cents('STUDIO_REVISION_BUILDING_SMALL_CENTS', 1500),
    revisionBuildingMedium: cents('STUDIO_REVISION_BUILDING_MEDIUM_CENTS', 2500),
    revisionBuildingLarge: cents('STUDIO_REVISION_BUILDING_LARGE_CENTS', 4000),
    // The most a free-finalize credit covers on one line: a bigger line is charged the rest
    giftCapCents: cents('STUDIO_GIFT_CAP_CENTS', 2900),
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
 * A deploy key (VIRVI_DCL_DEPLOY_KEY, VIRVI_DCL_PARCEL_DEPLOY_KEY) checked once at startup: a 32-byte hex secp256k1
 * private key, returned 0x-prefixed. A malformed key is treated as unset (Virvi deploys show as unavailable) with a
 * warning that names the variable but never includes the key, instead of throwing on every use.
 */
export function validDeployKey(raw: string | undefined, name = 'VIRVI_DCL_DEPLOY_KEY'): string | null {
  const hex = raw?.trim().replace(/^0x/i, '') ?? ''
  if (!hex) return null
  if (/^[0-9a-f]{64}$/i.test(hex)) {
    const n = BigInt(`0x${hex}`)
    if (n > 0n && n < SECP256K1_N) return `0x${hex}`
  }
  console.warn(`[virvi-config] ${name} is not a valid private key (32 bytes of hex); Virvi deploys are off until it is fixed`)
  return null
}

/** The first line of a RELEASE file (the deploy stamps the commit SHA there, since `railway up` from a checkout passes
 * no RAILWAY_GIT_COMMIT_SHA); null when it's missing or unreadable. */
export function readReleaseFile(path: string): string | null {
  try { return readFileSync(path, 'utf8').split('\n')[0].trim() || null } catch { return null }
}

/** The build SHA a release is known by: VIRVI_RELEASE, else RAILWAY_GIT_COMMIT_SHA or SOURCE_COMMIT, else the stamped
 * RELEASE file, cut to 12; else 'dev'. */
export function releaseFrom(e: Record<string, string | undefined>, stamped: string | null = null): string {
  const raw = (e.VIRVI_RELEASE || e.RAILWAY_GIT_COMMIT_SHA || e.SOURCE_COMMIT || stamped || '').trim()
  return /^[A-Za-z0-9._-]+$/.test(raw) ? raw.slice(0, 12) : 'dev'
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
  // Signed-out Design Studio trials (see auth/trial.ts)
  trialsEnabled: trialsEnabledFrom(env('TRIALS_ENABLED'), mode),
  turnstileSecretKey: env('TURNSTILE_SECRET_KEY') || '',
  trialPrompts: intEnv('TRIAL_PROMPTS', 3),
  trialCostCeilingUsd: numEnv('TRIAL_COST_CEILING_USD', 3),
  trialDesigns: intEnv('TRIAL_DESIGNS', 2),
  trialUploadBytes: intEnv('TRIAL_UPLOAD_BYTES', 26214400),
  // Scene imports a trial may start, ever (failed ones included), and the largest zip it may upload
  trialImports: intEnv('TRIAL_IMPORTS', 2),
  trialImportMaxBytes: intEnv('TRIAL_IMPORT_MAX_BYTES', 26214400),
  // Room scans a trial may hold at once (deleting one makes room)
  trialRoomScans: intEnv('TRIAL_ROOM_SCANS', 5),
  trialPerIpDay: intEnv('TRIAL_PER_IP_DAY', 3),
  trialPerDeviceDay: intEnv('TRIAL_PER_DEVICE_DAY', 3),
  trialDailyBudgetUsd: numEnv('TRIAL_DAILY_BUDGET_USD', 50),
  trialIdleDays: intEnv('TRIAL_IDLE_DAYS', 14),
  // The oldest Decentraland HUD edit protocol (x-virvi-hud-protocol) allowed to write; older HUDs get 426 redeploy_required.
  // 0 lets every HUD edit, including those deployed before the header. Raise it when a release breaks old HUDs' edits.
  minDclHudProtocol: parseInt(env('MIN_DCL_HUD_PROTOCOL') || '0'),
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
  // A separate wallet for Genesis City parcels, which owners make an update operator on-chain. Unset hides that
  // option (browser signing still works). Env only: never logged, never returned.
  virviDclParcelDeployKey: validDeployKey(env('VIRVI_DCL_PARCEL_DEPLOY_KEY'), 'VIRVI_DCL_PARCEL_DEPLOY_KEY'),

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
  // Where uploaded scenes are built (apps/scene-builder/README.md): `fly` (a one-shot machine per build in
  // SCENE_BUILD_FLY_APP, from SCENE_BUILD_IMAGE), `local` (build.mjs on this server, unisolated: development only, refused
  // in cloud mode) or `off` (imports are refused). Default: `fly` in cloud mode, else `off`.
  sceneBuildRunner: sceneBuildRunnerFrom(env('SCENE_BUILD_RUNNER'), mode),
  sceneBuildImage: env('SCENE_BUILD_IMAGE'), // registry.fly.io/virvi-scene-builds:<git-sha>
  sceneBuildFlyApp: env('SCENE_BUILD_FLY_APP') || 'virvi-scene-builds',
  sceneBuildFlyToken: env('SCENE_BUILD_FLY_TOKEN'), // scoped to the build app only
  studioFlyApp: env('STUDIO_FLY_APP') || 'vlm-studio-worker',
  // `external`: Virvi never creates or starts worker machines; a worker is run by hand (local development)
  studioMachines: (env('STUDIO_MACHINES') === 'external' ? 'external' : 'fly') as 'fly' | 'external',
  studioClaudeModel: env('STUDIO_CLAUDE_MODEL') || 'claude-opus-5-5',
  studioCodexModel: env('STUDIO_CODEX_MODEL') || 'gpt-6.1-sol',
  studioGrokModel: env('STUDIO_GROK_MODEL') || 'grok-build-0.1',
  // Drafting agent lessons from a batch of 👎s on the Studio admin page (LIV-142, src/studio/lesson-drafts.ts). Unset,
  // there is no Draft button and admins write lessons by hand. The workers' keys stay behind their key proxy
  anthropicApiKey: env('ANTHROPIC_API_KEY') || null,
  studioLessonModel: env('STUDIO_LESSON_MODEL') || 'claude-sonnet-5-5',
  studioPrices: studioPricesFrom(process.env),
  studioMana: manaSettingsFrom(process.env),
  // The studio scene's parcel (for example "-12,34"), where the checkout link sends a returning visitor
  studioSceneParcel: env('STUDIO_SCENE_PARCEL') || null,
  studioCheckoutLinkMs: 600000, // a one-time checkout link expires after 10 minutes
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
  // LIV-135: checks whether Decentraland built a map snapshot (Initial Scene State) for each new deploy (0 disables)
  dclMapSweepMs: parseInt(env('DCL_MAP_SWEEP_MS') || '60000'),
  dclMapManifestUrl: (env('DCL_MAP_MANIFEST_URL') || 'https://abgen-cdn.decentraland.org/LOD/lods-unity/manifests').replace(/\/+$/, ''),

  // Analytics background jobs (session close, rollups, retention); disabled in tests
  analyticsJobsEnabled: env('ANALYTICS_JOBS') !== 'false',

  // ── Decentraland directory (analytics scene validation & claims) ───────
  catalystUrl: env('DCL_CATALYST_URL') || 'https://peer.decentraland.org',
  dclLandSubgraphUrl: env('DCL_LAND_SUBGRAPH_URL') || 'https://subgraph.decentraland.org/land-manager',
  worldsUrl: env('DCL_WORLDS_URL') || 'https://worlds-content-server.decentraland.org',

  // ── Error reporting (LIV-66, src/errors/) ─────────────────────────────
  // The build this server runs (the Errors page's "since deploy"): VIRVI_RELEASE, else Railway's commit SHA, else 'dev'
  release: releaseFrom(process.env, readReleaseFile(resolve(process.cwd(), 'RELEASE')) ?? readReleaseFile(resolve(process.cwd(), '../../RELEASE'))),
  // ERROR_REPORTING=false stops recording (the ingest endpoint still answers 202 and drops what it gets)
  errorReportingEnabled: env('ERROR_REPORTING') !== 'false',
  // How often buffered error events are written (0 disables the flusher; tests flush by hand)
  errorFlushMs: intEnv('ERROR_FLUSH_MS', 2000),
  // Retention purge and Linear filing passes; disabled in tests
  errorJobsEnabled: env('ERROR_JOBS') !== 'false',
  // Filing to Linear is off until both are set. Env only: never logged, never returned
  linearApiKey: env('LINEAR_API_KEY') || null,
  linearTeamId: env('LINEAR_TEAM_ID') || null,
  // Optional: the team's Triage state, labels (comma-separated, e.g. the Bug label) and the Bug template for new issues
  linearTriageStateId: env('LINEAR_TRIAGE_STATE_ID') || null,
  linearLabelIds: (env('LINEAR_LABEL_IDS') || '').split(',').map((s) => s.trim()).filter(Boolean),
  linearTemplateId: env('LINEAR_TEMPLATE_ID') || null,
  // Filing thresholds; each can be changed on the Errors page (stored in error_settings)
  errorThresholds: {
    newMinUsers: 2, // a new signature in a release hitting this many users
    severeMinUsers: 3, // a 5xx or crash hitting this many users in an hour (for browser errors: users or addresses)...
    severeMinCount: 10, // ...or a server-side one happening this many times in an hour (browser counts never count)
    spikeFactor: 3, // this many times its usual rate for that hour of the week
    spikeMinBaseline: 1, // "usual" is never taken as less than this many an hour
    spikeMinCount: 5, // and a spike needs at least this many in the hour
    spikeHistoryWeeks: 4, // how many past weeks make "usual"
    quietDays: 7, // no events this long after being marked fixed: noted as quiet
    maxIssuesPerPass: 5, // the most issues one filing pass makes (the rest wait for the next pass, or the page)
    maxIssuesPerDay: 20, // and the most in a day
    filing: true, // file at all (when Linear is set up)
  },

  // ── Dashboard ───────────────────────────────────────────────────────────
  dashboardDir: env('DASHBOARD_DIR') || './dashboard',
} as const
