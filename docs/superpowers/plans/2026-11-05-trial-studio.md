# Try the Design Studio without an account (LIV-91 phase 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A signed-out visitor opens `/try/studio`, passes an invisible bot check, gets a trial account, makes up to 2 designs with 3 free prompts, and on sign-up (or sign-in) keeps everything.

**Architecture:** A trial is a real `users` row (`is_trial`) with a `kind: 'trial'` JWT. `authenticate` lets a trial token through only on routes whose config says `trial: true` (default closed) and answers `403 account_required` elsewhere. Quotas give trials a total allowance on a sentinel usage day and a global daily budget. Sign-up routes, called with a trial bearer, convert the same row; sign-in merges the trial into the account with the existing `moveStudioData`. The web app holds the trial session in the same auth store as accounts and turns every `account_required` into a sign-up sheet that retries the blocked call.

**Tech Stack:** Fastify 5 + Drizzle (Postgres) server, Next.js web app, Vitest, Cloudflare Turnstile.

**Spec:** `docs/superpowers/specs/2026-11-05-trial-access-design.md` (copied from Linear LIV-91; the issue is the authority).

## Global Constraints

- Free trial prompts: 3 in total (config `TRIAL_PROMPTS`, default 3); trial cost ceiling $3 total (`TRIAL_COST_CEILING_USD`, default 3).
- Trial design limit: 2 designs, archived ones included (`TRIAL_DESIGNS`, default 2).
- Trial uploads: 25 MB total per trial (`TRIAL_UPLOAD_BYTES`, default 26214400).
- New trials: 3 per IP per UTC day and 3 per device per UTC day (`TRIAL_PER_IP_DAY`, `TRIAL_PER_DEVICE_DAY`, default 3).
- Global trial spend: `TRIAL_DAILY_BUDGET_USD` (default 50) across all trials per UTC day.
- Expiry: 14 days of inactivity (`TRIAL_IDLE_DAYS`, default 14).
- Refusal body for any non-allowlisted route: `403 { error: 'account_required', action: '<METHOD> <route url>' }`.
- Turnstile: server secret `TURNSTILE_SECRET_KEY`, web site key `NEXT_PUBLIC_TURNSTILE_SITE_KEY`. With no secret: in `VIRVI_MODE=cloud` new trials are refused (`503 trials_unavailable`); in other modes the check is skipped.
- Copy, verbatim: trial bar "You're trying Virvi. Create an account to save your work"; counter "N of 3 free prompts left"; out-of-prompts card "Create a free account to keep designing. You'll get your daily prompts (3 a day on Free), and everything you made stays here."; budget refusal "Free tries are busy right now — create an account to keep going."; landing link "Try it — no account needed".
- Breaking changes are fine (no users yet); no compat shims.
- Server tests: run with a per-worktree `TEST_DATABASE_URL` (global setup drops the DB).

## Rulings made while planning

- R1 Trial tokens live in the web auth store (localStorage, like account tokens), not an httpOnly cookie: the dashboard sends every call as a bearer token, and one session store keeps conversion a token swap. Cost if wrong: a cookie path later.
- R2 Turnstile is verified once, when the trial is created, and the trial is created by the visitor's first prompt (`/try/studio` makes nothing on load). That is "before the first costly action". Cost if wrong: a second check on the first prompt.
- R3 After an in-page sign-up (email, wallet) the blocked call is retried automatically. Google and Discord leave the page: the visitor comes back to the same page with a note "You're signed in — press <action> again". Cost if wrong: replaying the stored request after OAuth.
- R4 Trial usage is kept on a sentinel usage day `1970-01-01` (the column is a date); conversion deletes that row.
- R5 Sign-in from a trial always moves the trial's work into the account; the sheet's sign-in tab says so ("Your trial designs move into this account"). The spec's "offer" is that copy.

## Review Focus

1. Two prompts sent at once on a trial with 1 prompt left: exactly one is accepted (test in Task 3).
2. A route added later without `trial: true`: a trial token gets `account_required`, never a pass-through (the guard test in Task 2 walks every route).
3. A converted user's old trial token (access or refresh): refused with `401 trial_ended`, so the web app swaps to its account tokens (Task 2, Task 4).
4. The expiry sweep on an account that converted yesterday but was idle as a trial for 20 days: untouched (Task 5).
5. A forged or reused OAuth claim ticket: refused; a ticket for a trial that no longer exists creates a normal account (Task 4).

---

### Task 1: Trial accounts and the trial session

**Files:**
- Modify: `apps/server/src/db/schema.ts` (users), `apps/server/entrypoint.sh` (fallback columns), `apps/server/src/config.ts`
- Create: `apps/server/src/auth/trial.ts`, `apps/server/src/auth/turnstile.ts`, `apps/server/src/routes/trial.ts`
- Modify: `apps/server/src/auth/tokens.ts` (`TokenKind`), `apps/server/src/middleware/auth.ts` (types), `apps/server/src/routes/auth.ts` (refresh), `apps/server/src/app.ts` (register route)
- Test: `apps/server/test/trial-session.test.ts`

**Interfaces:**
- Produces:
  - `users` columns: `isTrial boolean not null default false`, `trialLastActiveAt timestamptz null`, `trialIpHash text null`, `trialDeviceHash text null`.
  - `TokenKind = 'account' | 'scene' | 'trial'`.
  - `issueTrialSession(app, user): { user: { id, displayName, trial: true, expiresAt: string }, accessToken, refreshToken }` in `auth/trial.ts`; claims `{ id, email: null, role: 'creator', kind: 'trial', verified: false }`.
  - `trialExpiresAt(lastActive: Date): Date` (lastActive + `TRIAL_IDLE_DAYS`).
  - `verifyTurnstile(token: string | undefined, ip: string): Promise<boolean>` in `auth/turnstile.ts` (POST `https://challenges.cloudflare.com/turnstile/v0/siteverify`, form `secret`, `response`, `remoteip`; `success === true`). Injectable fetch for tests via `setTurnstileFetch`.
  - `POST /api/auth/trial { turnstileToken, deviceId }` → `201` trial session; `400 bad_device` (deviceId not 16–64 `[A-Za-z0-9_-]`), `403 bot_check_failed`, `429 trial_limit`, `503 trials_unavailable`.
  - `/api/auth/refresh` accepts a trial refresh token while the row is still `isTrial`, returning a trial access token; otherwise `401 trial_ended`.

- [ ] **Step 1: Write the failing tests** in `trial-session.test.ts`:
  - `creates a trial user and session after the bot check`: POST with a stubbed Turnstile that answers success → 201; the row has `isTrial: true`, `email: null`; `user.trial === true`; `expiresAt` 14 days after now; decoded access token has `kind: 'trial'`.
  - `refuses a failed bot check` (stub answers `{ success: false }`) → 403 `bot_check_failed`, no row made.
  - `limits new trials to 3 a day per IP and per device`: 3 from one IP pass, the 4th gets 429 `trial_limit`; 3 from one deviceId over different IPs (`x-forwarded-for` with `trustProxy` as the test app sets it, or inject `remoteAddress`) then 429.
  - `refreshes a trial session; a converted trial's refresh is refused`: refresh → new trial access token; set `isTrial=false` → 401 `trial_ended`.
  - `refuses trials in cloud mode without a Turnstile secret` (set config fields on the imported `config` and restore after) → 503 `trials_unavailable`.

- [ ] **Step 2: Run** `npx vitest run test/trial-session.test.ts` — Expected: FAIL (404 on the route).

- [ ] **Step 3: Implement** the columns (and the `ADD COLUMN IF NOT EXISTS` lines in the entrypoint fallback, next to the other users columns), the config values from Global Constraints, `auth/trial.ts`, `auth/turnstile.ts` and `routes/trial.ts`. Hash IP and device with `sha256` (`auth/hash.ts`); count today's rows by hash with `createdAt >= start of UTC day`. Display name `Guest`. Set `trialLastActiveAt = now`. Route rate limit: `{ max: 10, timeWindow: '1 minute' }`.

- [ ] **Step 4: Run** the test file — Expected: PASS. Then `npx tsc --noEmit -p .` — Expected: no errors.

- [ ] **Step 5: Commit** `feat(trial): guest trial accounts and sessions behind a bot check (Refs LIV-91)`.

### Task 2: Trial tokens only on allowlisted routes

**Files:**
- Modify: `apps/server/src/middleware/auth.ts`, `apps/server/src/auth/scene-from.ts` (`FastifyContextConfig.trial?: true`), `apps/server/src/app.ts` (route registry records `trial`), `apps/server/src/routes/studio.ts`, `apps/server/src/auth/tokens.ts` (`verifySessionToken` refuses `trial`), `apps/server/src/auth/actor.ts`
- Test: `apps/server/test/trial-guard.test.ts`, `apps/server/test/cross-account-walk.test.ts`

**Interfaces:**
- Consumes: Task 1's `issueTrialSession`, `users.isTrial`.
- Produces:
  - Route config flag `trial: true` (opt-in).
  - `authenticate`: for `kind: 'trial'`: the user row must exist with `isTrial` (else `401 trial_ended`); a route without `config.trial` gets `403 { error: 'account_required', action: \`${request.method} ${request.routeOptions.url}\` }`; on success sets `request.user = { id, email: null, role, orgId: null, kind: 'trial', verified: false, trial: true }` and updates `trialLastActiveAt` when it is over 10 minutes old.
  - `AuthUser.trial?: boolean`; `actorFromClaims` returns `ANONYMOUS` for `kind: 'trial'` (no scene access through the actor).
  - Studio routes with `trial: true`: `GET /api/studio/usage`, `POST /api/studio/designs`, `GET /api/studio/designs`, `GET /api/studio/designs/:id`, `PATCH /api/studio/designs/:id`, `POST /api/studio/designs/:id/prompts`, `GET /api/studio/designs/:id/finalize`, `POST /api/studio/designs/:id/pieces/:category/revisions/:number/report`, `POST /api/studio/designs/:id/uploads`, `GET` and `DELETE /api/studio/designs/:id/uploads/:uploadId`, `POST /api/studio/designs/:id/renders`, `/set-renders`, `/emote-checks`, `/clipping`. Everything else (finalize POST, packages, topups, payments, MANA, gift codes, finalize-renders) stays closed.

- [ ] **Step 1: Write the failing tests** in `trial-guard.test.ts`:
  - `only the listed routes take a trial token`: from `app.registeredRoutes`, `routes.filter(r => r.trial).map(r => \`${r.method} ${r.url}\`).sort()` equals the list above, sorted.
  - `every other route answers account_required to a trial token`: walk every registered non-public route (reuse the scene-pass guard test's `isPublic` and id substitution), inject with a trial bearer; collect offenders whose answer isn't `403` with `error === 'account_required'` and `action === \`${method} ${url}\``; expect `[]`.
  - `a converted or deleted trial's token is refused`: `isTrial=false` → `GET /api/studio/designs` gives 401 `trial_ended`; deleted row → 401 `trial_ended`.
  - `a trial token is no Colyseus session`: `verifySessionToken(trialAccess)` is null.
  - In `cross-account-walk.test.ts`, add a trial user who owns nothing: every allowlisted route against another account's design id returns 404 or 403, never 2xx.

- [ ] **Step 2: Run** both files — Expected: FAIL.

- [ ] **Step 3: Implement.** In `authenticate`, handle `kind === 'trial'` right after the refresh/guest checks, before the account and scene branches; the `isTrial` lookup is one `select` by id. `registeredRoutes` gains `trial: !!r.config?.trial`. In `studio.ts`, add `trial: true` to the listed routes' config (keep `scenePass: STUDIO_ROUTE_SCENE_PASS`). In `routes/studio.ts` uploads, a trial's total upload bytes over `TRIAL_UPLOAD_BYTES` gets `403 { error: 'account_required', action: 'upload_more' }`.

- [ ] **Step 4: Run** `npx vitest run test/trial-guard.test.ts test/cross-account-walk.test.ts test/scene-pass-guard.test.ts test/studio*.test.ts` — Expected: PASS.

- [ ] **Step 5: Commit** `feat(trial): trial tokens reach allowlisted Studio routes only (Refs LIV-91)`.

### Task 3: Trial prompts, designs and the global budget

**Files:**
- Modify: `apps/server/src/studio/quota.ts`, `apps/server/src/studio/designs.ts` (`usage`), `apps/server/src/routes/studio.ts` (design creation limit), `apps/server/src/db/schema.ts` (+ entrypoint fallback)
- Test: `apps/server/test/trial-quota.test.ts`

**Interfaces:**
- Consumes: `users.isTrial`.
- Produces:
  - `TRIAL_DAY = '1970-01-01'` exported from `quota.ts`; `usageDay(userId, now): Promise<string>` (trial → `TRIAL_DAY`, else `utcDay(now)`); `reservePrompt`, `promptStatus`, `recordCost` use it.
  - For a trial, `limitsFor` returns `{ plan: 'trial', allowance: TRIAL_PROMPTS, ceiling: TRIAL_COST_CEILING_USD }`; gifts and credits never apply.
  - Table `studio_trial_spend_days (day date primary key, cost_usd double not null default 0)`; `recordCost` for a trial also adds to today's row.
  - `reservePrompt` for a trial returns `{ ok: false, reason: 'trial_busy' }` when today's trial spend ≥ `TRIAL_DAILY_BUDGET_USD`; the prompt route answers it `429 { error: 'trial_busy', message: 'Free tries are busy right now — create an account to keep going.' }`, and `allowance` for a trial as `403 { error: 'account_required', action: 'more_prompts' }`.
  - `promptStatus` for a trial: `{ plan: 'trial', allowance: 3, used, left, trial: true, resetsAt: null, ... }`.
  - Design creation for a trial: total designs (archived included) ≥ `TRIAL_DESIGNS` → `403 { error: 'account_required', action: 'more_designs' }`.

- [ ] **Step 1: Write the failing tests**:
  - `a trial gets 3 prompts in total, not per day`: reserve 3 (counted) on day 1 → ok; a 4th on day 2 → `reason: 'allowance'`.
  - `two reservations at once on the last prompt: only one passes` (`Promise.all` of two `reservePrompt` calls with 2 already used) → exactly one ok.
  - `the trial cost ceiling holds`: `recordCost` 3.0 → next reservation `cost_ceiling`.
  - `the global trial budget stops new trial prompts but not accounts'`: insert today's `studio_trial_spend_days` at the budget → trial `trial_busy`, a Free account still ok.
  - `a refunded trial prompt comes back` (`refundPrompt(userId, TRIAL_DAY, 'allowance')`).
  - Route: `POST /api/studio/designs` a third time for a trial → 403 `account_required` / `more_designs`; `GET /api/studio/usage` shows `trial: true, left: 3`.

- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement** as in Interfaces; callers that compute `day` before calling `refundPrompt` keep the `day` returned by `reservePrompt`.
- [ ] **Step 4: Run** `npx vitest run test/trial-quota.test.ts test/studio*.test.ts` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(trial): 3 free prompts, 2 designs and a daily budget for trials (Refs LIV-91)`.

### Task 4: Converting and merging a trial

**Files:**
- Create: `apps/server/src/auth/trial-convert.ts`
- Modify: `apps/server/src/routes/auth.ts` (register, login, Google and Discord start and callback), `apps/server/src/routes/wallet-auth.ts`, `apps/server/src/routes/trial.ts` (claim ticket)
- Test: `apps/server/test/trial-convert.test.ts`

**Interfaces:**
- Consumes: Task 1 sessions, `moveStudioData` (`studio/merge.ts`).
- Produces:
  - `trialFromBearer(app, request): Promise<string | null>`: the trial user id from a valid trial access token in `Authorization`, else null.
  - `convertTrial(trialId, set: { email?: string | null; displayName: string }): Promise<User>`: in one transaction clears `isTrial`, sets the fields, deletes the `TRIAL_DAY` usage row; returns the user (same id).
  - `mergeTrial(trialId, accountId): Promise<void>`: one transaction; `moveStudioData(tx, trialId, accountId, now)`, deletes the trial's usage rows, deletes the trial user.
  - `POST /api/auth/trial/claim` (trial bearer) → `{ ticket }`, a JWT `{ id, kind: 'trial_claim' }` valid 10 minutes.
  - `GET /api/auth/google?claim=<ticket>` and `/api/auth/discord?claim=<ticket>` pass the ticket through OAuth `state`; the callbacks verify it (`kind === 'trial_claim'`, the user still `isTrial`): a new OAuth identity converts the trial (the auth method is inserted for the trial's id); an existing identity merges the trial into that account. An invalid ticket is ignored (normal sign-in).
  - With a trial bearer: `POST /api/auth/register` converts (409 if the email is taken, as today); `POST /api/auth/login` merges into the signed-in account; `POST /api/auth/wallet/verify` converts when the wallet has no account, merges when it has one. Each answers with the normal account session (same body as today).
  - Funnel rows (Task 5's table): `signed_up` with `action` from the body's optional `fromAction`.

- [ ] **Step 1: Write the failing tests**:
  - `email sign-up from a trial keeps the same id, its designs, and resets prompts`: trial with 1 design and 2 used prompts → register with trial bearer → `user.id === trialId`, design still owned, `GET /api/studio/usage` with the new token shows the Free plan and `left: 3`, `isTrial` false.
  - `signing in from a trial moves its designs into the account and removes the trial`.
  - `wallet sign-in converts or merges`: unknown wallet → same id; wallet with an account → merged.
  - `Google from a trial with a claim ticket converts` (mock the Google client exactly as the existing OAuth tests do, or call the callback handler's helper `finishOAuth(identity, claim)` that Step 3 extracts).
  - `a forged or stale claim is ignored`: a ticket signed with another secret, or for a trial already converted → a normal new account; the trial untouched.
  - `the trial's old tokens are refused after conversion` → 401 `trial_ended`.

- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement.** Extract `finishOAuth(app, identity: { type: 'oauth'; identifier: string; email: string | null; displayName: string; metadata: object }, claim: string | undefined)` from the two callbacks so both providers share it.
- [ ] **Step 4: Run** `npx vitest run test/trial-convert.test.ts test/auth*.test.ts test/wallet*.test.ts` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(trial): signing up keeps the trial's work; signing in moves it (Refs LIV-91)`.

### Task 5: Expiry and the funnel

**Files:**
- Create: `apps/server/src/auth/trial-sweep.ts`
- Modify: `apps/server/src/studio/sweep.ts` (call it), `apps/server/src/db/schema.ts` (+ entrypoint fallback), the routes that emit funnel rows
- Test: `apps/server/test/trial-sweep.test.ts`

**Interfaces:**
- Produces:
  - Table `trial_events (id uuid pk, user_id uuid null, kind text not null, action text null, created_at timestamptz default now())`, `kind` one of `started | prompt | blocked | signed_up | expired`; `user_id` is not a foreign key (rows outlive the trial).
  - `recordTrialEvent(kind, userId, action?)`, fire-and-forget. `blocked` is written by `authenticate` only for the trial's first refusal (none recorded yet for that user).
  - `sweepTrials(now, deps): Promise<{ expired: number }>`: users with `isTrial` and `trialLastActiveAt < now - TRIAL_IDLE_DAYS` → for each design `destroyWorker(designId, deps)` and `getStudioStore().deletePrefix(\`designs/${id}/\`)`, then delete the user (designs cascade) and record `expired`.

- [ ] **Step 1: Write the failing tests**:
  - `expires idle trials with their designs and files`: a trial idle 15 days with a design → user and design gone, `deletePrefix` called with `designs/<id>/`, `destroyWorker` called (fake deps).
  - `never touches a converted account or an active trial`: a converted user with an old `trialLastActiveAt`, and a trial active yesterday → both kept.
  - `records the funnel`: trial creation → `started`; an accepted trial prompt → `prompt`; the first `account_required` → one `blocked` with its action, a second refusal adds none; conversion → `signed_up` with `fromAction`.
- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement**; call `sweepTrials` from the studio sweep loop next to `sweepStudio`, catching and logging its errors.
- [ ] **Step 4: Run** `npx vitest run test/trial-sweep.test.ts test/trial-*.test.ts` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(trial): idle trials expire after 14 days; the trial funnel is recorded (Refs LIV-91)`.

### Task 6: The web app's trial session and sign-up sheet

**Files:**
- Modify: `apps/web/src/lib/auth.tsx`, `apps/web/src/lib/api.ts`
- Create: `apps/web/src/lib/trial.ts`, `apps/web/src/components/SignUpSheet.tsx`, `apps/web/src/components/Turnstile.tsx`
- Test: `apps/web/src/lib/trial.test.ts`

**Interfaces:**
- Consumes: Tasks 1–4 routes.
- Produces:
  - Auth context: `user.trial?: boolean`, `user.expiresAt?: string`; `startTrial(turnstileToken: string): Promise<void>` (device id from `localStorage['virvi.device']`, made once with `crypto.randomUUID()`); register, login and wallet sign-in send the trial bearer when the session is a trial and replace it with the account session; `oauthUrl(provider)` fetches a claim ticket first when a trial.
  - `lib/trial.ts`: `accountRequired(err): { action: string } | null`; `blockedCopy(action: string, ctx: { designName?: string; revisions?: number }): { title: string; unlocks: string }` with entries for `POST /api/studio/designs/:id/finalize` ("Create a free account to finalize *Neon Jacket*. Your design and its 4 revisions are saved."), packages/downloads, `POST /api/studio/topups`, gift codes, `more_designs`, `more_prompts`, `upload_more`, and a default ("Create a free account to use this.").
  - `apiFetch`: on `403 account_required` from a trial session, it awaits `openSignUp({ action, ctx })` (a promise resolving when the sheet completes an in-page sign-up) and retries the request once with the new token; it rejects with the original error when the sheet is closed. `401 trial_ended` with a stored account session swaps to it.
  - `<SignUpSheet>`: tabs Create account (email form, Google, Discord, wallet) and Sign in (email, wallet; copy "Your trial designs move into this account"); the title is `blockedCopy(...).title`.
  - `<Turnstile onToken>`: loads `https://challenges.cloudflare.com/turnstile/v0/api.js` once, renders invisible; with no site key it calls `onToken('')`.

- [ ] **Step 1: Write the failing tests** for `lib/trial.ts`: `accountRequired` reads `{ status: 403, body: { error: 'account_required', action } }` and ignores other errors; `blockedCopy` for finalize with a design name and revisions gives the exact sentence above; an unknown action gives the default.
- [ ] **Step 2: Run** `npx vitest run src/lib/trial.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** the lib, the components and the auth/api changes.
- [ ] **Step 4: Run** `pnpm typecheck && npx vitest run` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(web): trial sessions and a sign-up sheet that carries on with the blocked action (Refs LIV-91)`.

### Task 7: `/try/studio`, the trial shell and the Studio counter

**Files:**
- Create: `apps/web/src/app/try/studio/page.tsx`
- Modify: `apps/web/src/app/(dashboard)/layout.tsx`, `apps/web/src/app/(dashboard)/studio/[designId]/client.tsx` (counter and out-of-prompts card), `apps/web/src/app/_landing/*` (link), `apps/web/src/lib/session.ts` (trial path rule)
- Test: `apps/web/src/lib/session.test.ts` (trial path rule)

**Interfaces:**
- Consumes: Task 6.
- Produces:
  - `trialAllows(pathname): boolean` in `lib/session.ts`: `/studio` and `/studio/*` only.
  - `/try/studio` (public): kind chips Wearable / Emote / Building (`wearable`, `emote`, `scene`), a prompt box and Start. On Start: Turnstile token → `startTrial` (if no session) → `createStudioDesign({ kind, agent: 'claude' })` → send the prompt → `router.push('/studio/<id>')`. A signed-in account goes straight to `/studio`.
  - Dashboard layout with a trial session: no sign-in redirect on allowed paths; other paths show a locked explainer with Sign up; nav items other than Design Studio show a lock and open the sheet ("Create a free account to use <label>."); the trial bar above `children` with the copy from Global Constraints plus "Your trial is kept until <expiresAt as a date>"; the account footer shows Sign up / Sign in instead of Sign out. Layout effects that call account-only routes don't run for a trial.
  - Studio design page for a trial: "N of 3 free prompts left" next to the prompt box; at 1 left the note "1 free prompt left — create an account for 3 a day"; at 0 the prompt box is replaced by the out-of-prompts card with the design's latest render and Create account / See plans.
  - Landing page: "Try it — no account needed" → `/try/studio`.

- [ ] **Step 1: Write the failing test** `trialAllows('/studio')`, `trialAllows('/studio/abc')` true; `/scenes`, `/settings`, `/studio-x` false.
- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `pnpm typecheck && npx vitest run && pnpm build` — Expected: PASS and build succeeds.
- [ ] **Step 5: Commit** `feat(web): try the Design Studio at /try/studio with no account (Refs LIV-91)`.

### Task 8: Docs and rollout notes

**Files:**
- Create: `apps/docs/src/content/docs/getting-started/try-without-an-account.md`
- Modify: `apps/docs/src/content/docs/self-hosting/environment-variables.md` (the `TRIAL_*` and Turnstile variables)

- [ ] **Step 1:** Write the page (what a guest can and can't do, the 3 prompts, 14-day expiry, what sign-up keeps) and the variables. Run `pnpm --filter @virvixr/docs build` (or `pnpm build` in `apps/docs`) — Expected: builds.
- [ ] **Step 2: Commit** `docs: trying Virvi without an account (Refs LIV-91)`.
