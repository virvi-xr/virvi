# Virvi secrets inventory

Names only. Never put a value in this file, a ticket or a chat. Taken on 2026-11-18 for LIV-191 (move secrets into 1Password).

Where the value lives today is the column to change: when LIV-191 is done, 1Password holds the source and the others are copies.

## Production secrets

| Secret | Lives in today | Used by | If it leaks |
|---|---|---|---|
| `DATABASE_URL` (Postgres password inside) | Railway: virvi-server, Postgres (`POSTGRES_PASSWORD`, `PGPASSWORD`) | server | Every account, design and payment record |
| `JWT_SECRET` | Railway: virvi-server | server; also the root of the ad-viewer key and the error-user salt | Anyone can sign in as anyone |
| `BEAT_MINTER_KEY` | Railway: virvi-server; source in 1Password | BEAT minting job | Can mint BEATs (MATIC in that wallet at risk) |
| `GIVEAWAY_WALLET_SECRET` | Railway: virvi-server; back up in 1Password | automatic giveaways | Opens every giveaway wallet (POL at risk); losing it loses that POL |
| `GIVEAWAY_GAS_KEY` | Railway: virvi-server; source in 1Password | giveaway gas tank | Can spend the gas tank's POL |
| `BEAT_NETWORK_HASH_SECRET` | Railway: virvi-server | BEAT network claims | Links hashed BEAT data back to people |
| `STRIPE_SECRET_KEY` | Railway: virvi-server; local `.env` (test key) | payments | Charges, refunds, customer data |
| `STRIPE_WEBHOOK_SECRET` | Railway: virvi-server | Stripe webhook | Fake payment events |
| `ANTHROPIC_API_KEY` | Railway: virvi-server; Fly: vlm-studio-worker, vlm-studio-spike; local worker `.env` | server (prompt help, lessons, assistant), studio worker | Spend on our account |
| `OPENAI_API_KEY` | Fly: vlm-studio-worker, vlm-studio-spike; local worker `.env` | studio worker (Codex) | Spend on our account |
| `XAI_API_KEY` | Fly: vlm-studio-worker | studio worker (Grok) | Spend on our account |
| `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` (R2) | Railway: virvi-server; local `~/.config/vlm/prod-storage.env`, `r2-worlds.env` | media, studio, imports, Hyperfy assets | Read, replace or delete every stored file |
| `FLY_API_TOKEN` | Railway: virvi-server; local `~/.config/vlm/fly-worlds.token` | hosted Hyperfy worlds, studio machines | Start, stop or delete Fly apps |
| `SCENE_BUILD_FLY_TOKEN` | Railway: virvi-server | scene build runner | Run machines on virvi-scene-builds |
| `HYPERFY_SECRET_KEY` | Railway: virvi-server; local `~/.config/vlm/hyperfy-secret-key` | hosted Hyperfy worlds | Admin in hosted worlds |
| `HYPERFY_WORLDS_DB_URL_TEMPLATE` (password inside) | Railway: virvi-server | hosted worlds' databases | Every hosted world's data |
| `DB_ADMIN_URL` | Fly: vlm-worlds-db-jobs | world database jobs | Same |
| `OPERATOR_PASSWORD`, `REPL_PASSWORD`, `SU_PASSWORD`, `SSH_KEY`, `SSH_CERT`, `FLY_CONSUL_URL` | Fly: vlm-worlds-pg (set by Fly's Postgres) | worlds Postgres cluster | Same; Fly manages these, leave them there |
| `STREAMING_WEBHOOK_KEY` = `VIRVI_WEBHOOK_KEY` | Railway: virvi-server; Fly: vlm-streaming; local `~/.config/vlm/streaming-webhook.key` | streaming server → Virvi | Fake stream start/stop events. The two copies must match |
| `TURNSTILE_SECRET_KEY` | Railway: virvi-server | guest trials | Bots past the trial check |
| `GOOGLE_CLIENT_SECRET`, `DISCORD_CLIENT_SECRET` | Railway: virvi-server | sign-in with Google and Discord | Impersonating Virvi's sign-in apps |
| `VIRVI_DCL_DEPLOY_KEY` | Railway: virvi-server | deploying Decentraland Worlds | Deploy as Virvi to its Worlds |
| `STUDIO_HELP_DISCORD_WEBHOOK_URL` | Railway: virvi-server | Studio "Help" posts | Spam in that Discord channel |
| `DISCORD_RELEASE_WEBHOOK` | GitHub: repo secret | release notes job | Spam in the release channel |
| `NPM_TOKEN` | GitHub: virvi-xr org secret (2023) | nothing in the current workflows | Publish packages as the org. Check if still needed |
| `SMTP_USER`, `SMTP_PASS` (Postmark) | not set yet | all email | Send email as virvi.io |

## Not set in production (the code reads them)

`VIRVI_DCL_PARCEL_DEPLOY_KEY` (Genesis City parcel deploys, LIV-58), `LINEAR_API_KEY` (error reports filing to Linear; "Linear filing off"), `METRICS_TOKEN`, `REDIS_URL`, `ERROR_USER_SALT` (falls back to a key derived from `JWT_SECRET`, which is fine).

## Configuration, not secret

Railway: `ANDROID_CERT_SHA256`, `BEAT_ADMIN_SAFE_POLYGON`, `BEAT_CHAIN`, `BEAT_CONTRACT_*`, `BEAT_ENABLED`, `CDN_URL`, `CORS_ORIGINS`, `DISCORD_CLIENT_ID`, `FLY_WORLDS_ORG`, `GOOGLE_CLIENT_ID`, `HLS_BASE_URL`, `HYPERFY_*` (other than the two above), `LOCAL_STORAGE_PATH`, `NEXT_PUBLIC_*`, `PUBLIC_URL`, `RTMP_INGEST_URL`, `S3_BUCKET`, `S3_ENDPOINT`, `S3_REGION`, `SCENE_BUILD_*` (other than the token), `SCENE_IMPORT_S3_URI`, `STORAGE_PROVIDER`, `STUDIO_*` (other than the webhook), `TRUST_PROXY_HOPS` (must be 2), `VIRVI_MODE`, `WEB_APP_URL`, and the planned `SMTP_HOST`, `SMTP_PORT`, `EMAIL_FROM`. GitHub repo variables: `NEXT_PUBLIC_API_URL`, `NEXT_PUBLIC_TURNSTILE_SITE_KEY`, `NEXT_PUBLIC_WSS_URL` (the workflow also reads `NEXT_PUBLIC_DISCORD_URL` and `NEXT_PUBLIC_DOCS_URL`, which aren't set). These can stay where they are.

## Outside any platform

Held by people, not set anywhere: the BEAT admin Safe's signer keys (never shared), the Polygonscan account, the Stripe, Postmark, Cloudflare, Fly, Railway, GitHub, npm and Linear account logins. 1Password is the place for the logins too. The Safe signers stay with their holders.

## Found while taking this

* **vlm-studio-spike** still holds live `ANTHROPIC_API_KEY` and `OPENAI_API_KEY`. It's an old spike app; its secrets (or the app) should go.
* **The Anthropic key is in four places** and the OpenAI key in three. One 1Password item each, copied out by the sync, makes rotating them one step.
* **Local copies** in `~/.config/vlm/` and the worker's `.env` (mode 600, git-ignored) duplicate production values. Once `op run` works locally, they can be deleted.
* **To rotate first:** the Postmark Server Token (pasted into a chat on 2026-11-18).
