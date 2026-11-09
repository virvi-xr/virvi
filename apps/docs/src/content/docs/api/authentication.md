---
title: Authentication
description: How to sign in to the Virvi API, refresh tokens, and create API keys for scripts and servers.
---

Every authenticated request sends a token in the `Authorization` header:

```http
Authorization: Bearer <access token or API key>
```

`<base>` below is `https://virvi.io` for hosted Virvi, or your server's `PUBLIC_URL`.

## API keys

Use an API key for anything that isn't a person in a browser.

**Create one** in the dashboard under **Settings → API keys**, or with the API while signed in with an account (not with another key):

```http
POST <base>/api/keys
Authorization: Bearer <access token>
Content-Type: application/json

{ "name": "my script", "expiresAt": "2027-01-01T00:00:00Z" }
```

| Field | Required | Meaning |
|---|---|---|
| `name` | Yes | A label for the key |
| `expiresAt` | No | ISO date. After it, the key returns `401`. No date: the key doesn't expire |
| `orgId` | No | An organization you belong to. Default: your active organization |

The response (`201`) holds the key once:

```json
{ "id": "…", "name": "my script", "key": "virvi_k1_…", "keyPrefix": "virvi_k1", "expiresAt": "2027-01-01T00:00:00.000Z", "createdAt": "…" }
```

Only a hash is stored. Copy `key` now; it can't be shown again.

**Use it** like a token: `Authorization: Bearer virvi_k1_…`.

**What it can do:** everything its account can, and no more. Keys have no scopes. A key can't create keys (`POST /api/keys` with a key returns `403`).

**List and delete:** `GET /api/keys` lists your keys (no secrets). `DELETE /api/keys/:keyId` deletes one at once.

Keep keys in environment variables or a secret store. Never put one in scene code, which anyone can read.

## Email and password

### Register

```http
POST <base>/api/auth/register
Content-Type: application/json

{ "email": "user@example.com", "password": "…", "displayName": "User" }
```

Returns `{ user, accessToken, refreshToken }`. On a self-hosted install, the first account becomes the instance admin. `409` if the email is taken.

### Sign in

```http
POST <base>/api/auth/login
Content-Type: application/json

{ "email": "user@example.com", "password": "…" }
```

Returns `{ user, accessToken, refreshToken }`, or `401 Invalid email or password`.

Register, sign-in and password routes allow 20 requests per minute per IP address.

### Refresh

Send the **refresh token** as the bearer token. There is no body.

```http
POST <base>/api/auth/refresh
Authorization: Bearer <refresh token>
```

Returns `{ accessToken }`.

Access tokens last `JWT_ACCESS_EXPIRY` (15 minutes by default); refresh tokens last `JWT_REFRESH_EXPIRY` (7 days by default). A request with an expired access token gets `401`: refresh, then retry.

### Other account routes

| Method | Path | Auth | What it does |
|---|---|---|---|
| GET | `/api/auth/providers` | No | `{ google, discord }`: which OAuth providers are on |
| GET | `/api/auth/google`, `/api/auth/discord` | No | Starts OAuth in a browser. `501` if not configured |
| POST | `/api/auth/forgot-password` | No | `{ email }`. Always `200`; sends a reset email when SMTP is set up |
| POST | `/api/auth/reset-password` | No | Completes a reset with the emailed token |
| PUT | `/api/auth/profile` | Yes | Changes `displayName` |
| PUT | `/api/auth/password` | Yes | `{ currentPassword, newPassword }` (at least 8 characters) |
| DELETE | `/api/auth/account` | Yes | `{ password }`. Deletes the account (password accounts only) |
| POST | `/api/auth/wallet/challenge`, `/api/auth/wallet/verify` | No | Sign in with an Ethereum wallet |
| GET | `/api/auth/wallets` | Yes | Your linked wallets |

## In-world sign-in (platform auth)

Scene code doesn't use passwords or keys. `@virvixr/dcl` signs in for you:

```http
POST <base>/api/auth/platform
Content-Type: application/json
(Decentraland signed-fetch headers)

{ "sceneId": "…", "user": { "id": "0x…", "displayName": "Player" }, "world": "decentraland", "location": { … }, "environment": { … } }
```

- With valid Decentraland signed-fetch headers, the server verifies the wallet and returns a **scene pass**: the player's role in the scene set up at that location, and nothing else. See [Scene pass](/docs/security/scene-pass/).
- Without them, it returns a guest token (`guest: true`, `refreshToken: null`) that can only view.
- A self-hosted, non-cloud server with `ALLOW_UNVERIFIED_PLATFORM_AUTH=true` accepts unverified identities instead. For local previews only.

## Errors

| Status | Meaning |
|---|---|
| `401` | Missing, invalid or expired token or key |
| `403` | Signed in, but not allowed (for example, not a host of that scene) |
| `404` | Not found, or not yours. Other accounts' scenes usually answer `404` rather than `403` |
| `429` | Rate limited. The global limit is `RATE_LIMIT_MAX` requests per minute per IP (300 by default) |
