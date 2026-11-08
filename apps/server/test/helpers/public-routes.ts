// Shared by the scene-pass and trial guard route walks.
// Routes that never read a bearer token (signed fetch, webhook keys, codes, public browse, static).
// A new public route must be added here deliberately, with its reason.
// Exact `METHOD url` matches.
export const PUBLIC_EXACT = [
  'POST /api/auth/register', // creates an account from email + password; no bearer
  'POST /api/auth/login', // email + password; no bearer
  'POST /api/auth/refresh', // takes a refresh token only; an access token (pass or account) gets 401 "Not a refresh token"
  'POST /api/auth/trial', // public: Turnstile token + device id; creates a trial session
  'POST /api/auth/platform', // DCL signed fetch; issues the pass
  'GET /api/auth/providers', // static list of enabled sign-in providers
  'POST /api/auth/forgot-password', // email only
  'POST /api/auth/reset-password', // reset token in body
  'POST /api/auth/wallet/challenge', // nonce for an address; no bearer
  'POST /api/auth/handoff/exchange', // single-use code in body
  'POST /api/setup', // DCL signed fetch (location setup)
  'POST /api/setup/status', // DCL signed fetch (location setup status)
  'GET /api/setup/scene', // public: Virvi scene for a set-up location (guest content-only connect)
  'GET /api/setup/models', // public: model list for a set-up location
  'GET /api/hyperfy/feed', // world-key auth
  'POST /api/hyperfy/analytics', // world-key auth
  'POST /api/hyperfy/pair', // world-key auth; the HUD starts a pairing
  'GET /api/hyperfy/pair/:code/qr.png', // public: the code is the auth (QR of its approve link)
  'POST /api/hyperfy/pair/:code/claim', // the code plus the browser secret is the auth
  'POST /api/hyperfy/pairings/:id/renew', // the pairing's browser secret is the auth
  'POST /api/hyperfy/pairings/vouch', // world-secret auth; a hosted world speaks for its player
  'GET /api/hyperfy/app.hyp', // public: the built Virvi Hyperfy app download
  'POST /api/ar/spaces/:id/analytics', // public for a published space (visits from a headset)
  'POST /api/ar/spaces/:id/report', // public for a published space (a visitor reports it from the headset menu)
  'POST /api/ar/pair', // public: a headset starts a pairing with the hash of its secret
  'POST /api/ar/pair/:code/claim', // the code plus the headset secret is the auth
  'POST /api/ar/devices/:id/pass', // the headset secret is the auth
  'POST /api/ar/devices/:id/end', // the headset secret is the auth
  'POST /api/ar/devices/:id/spaces', // the headset secret is the auth
  'POST /api/ar/devices/:id/scenes', // the headset secret is the auth
  'POST /api/ar/devices/:id/room-scans', // the headset secret is the auth (saves to the headset's approver only)
  'GET /.well-known/assetlinks.json', // public: the Android app links file, nothing of ours in it
  'POST /api/ingest', // DCL signed fetch / ingest key
  'POST /api/analytics/claims/check-signed', // DCL signed fetch
  'POST /api/ads/serve', // DCL signed fetch (ads for the signed scene's spaces)
  'POST /api/ads/events', // DCL signed fetch (ad views from the signed scene)
  'POST /api/streaming/authorize', // media server callback, shared secret
  'GET /api/streaming/live-keys', // media server callback, shared secret
  'POST /api/streaming/webhook', // media server callback, shared secret
  'POST /api/billing/webhook', // Stripe signature
  'GET /api/assets', // public browse list (never reads a bearer)
  'GET /api/assets/:id', // public asset detail
  'GET /api/assets/categories', // public category list
  'GET /api/catalog/packs', // public credits list (no bearer)
  'POST /api/advertiser-leads', // public: landing page early-access form (anonymous visitors, never reads a bearer)
  'POST /api/errors', // public: error reports from guests, trials and accounts; an optional bearer only picks the user to count (hashed), never grants anything
  'POST /api/errors/reports', // public: a crash screen's Report; an optional bearer only names the sender
  'POST /api/errors/prompt', // public: "should I ask?" for an error; an optional account bearer applies that account's own prompt state, nothing else
  'GET /api/studio/render-frames/*', // the signed frame token is the auth (no bearer)
  'GET /api/health', // health check
  'GET /api/instance', // public: install mode and version (no secrets)
  'GET /metrics', // Prometheus scrape
  'GET /', // static dashboard
  'GET /*', // static dashboard files
]
// startsWith matches — only genuinely prefixed families.
export const PUBLIC_PREFIX = [
  'GET /api/auth/google', // OAuth redirect + callback
  'GET /api/auth/discord', // OAuth redirect + callback
  'GET /api/upload/', // companion upload: the code is the auth
  'POST /api/upload/', // companion upload: the code is the auth
  'GET /hook/', // platform hooks: per-hook secret in the URL
  'POST /hook/', // platform hooks: per-hook secret in the URL
  'GET /api/docs', // Swagger UI and its static files
  'GET /uploads/', // static uploaded media
  'GET /api/studio/worker/', // studio worker machines: the per-design worker token is the auth
  'PUT /api/studio/worker/', // studio worker machines: the per-design worker token is the auth
  'POST /api/studio/worker/', // studio worker machines: the per-design worker token is the auth
  'GET /api/imports/build/', // scene build boxes: the one-build token is the auth
  'POST /api/imports/build/', // scene build boxes: the one-build token is the auth
]
// Read an optional bearer but treat a scene pass as no bearer (so the walk cannot see a 403).
// Each entry has its own test below.
export const IGNORES_SCENE_PASS = [
  'POST /api/auth/wallet/verify', // a pass never links a wallet; it signs in as the wallet instead
]
export const isPublic = (method: string, url: string) => {
  const key = `${method} ${url}`
  return PUBLIC_EXACT.includes(key) || PUBLIC_PREFIX.some((p) => key.startsWith(p)) || IGNORES_SCENE_PASS.includes(key)
}

