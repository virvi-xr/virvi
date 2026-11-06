# Try Virvi without an account (LIV-91)

Source: Linear issue [LIV-91](https://linear.app/livication/issue/LIV-91). Owner decisions recorded there on 2026-11-04;
owner asked to start building on 2026-11-05. This file copies the parts the build relies on. The issue stays the
authority; where they differ, the issue wins.

## Story

As someone curious about Virvi, I want to try the Design Studio and the scene builder straight away, without creating
an account. I can type a few prompts and watch a wearable or building take shape, and lay out a scene. When I want to
keep it, I create an account: to finalize, deploy or save, download or publish, or when I run out of free prompts.
Everything I made carries over, and my prompts reset so I can keep going.

## Decided (2026-11-04)

- 3 free Studio prompts in total, not per day (set in config).
- On sign-up, prompts reset to the normal Free allowance (a full day: 3). No welcome bonus. Trial usage isn't counted
  against the account's first day.
- Guests get import, demos and the room-scan builder (phase 2).
- Guests can preview in Decentraland with no account (phase 3).
- Deploying creates the account from the wallet (phase 2).
- Trial data expires after 14 days of inactivity unless claimed, including stopping and removing Studio machines. The
  page says so.
- Cloudflare Turnstile (invisible or managed mode), only before the first costly action.

## Phase 1 scope (this build): the Design Studio

### Trial accounts
- A guest session creates a real `users` row with `is_trial = true`, no email, password or wallet. Created on first
  use, not on page load. Designs, uploads and usage keep their normal owner and foreign keys.
- Signing up later converts the same row, so nothing is copied.
- A new token kind `trial`, accepted by `authenticate` only on routes marked trial-safe (an allowlist: new routes are
  closed to trial users by default), refused everywhere else with `403 { error: 'account_required', action: '<what they tried>' }`.
- Per-IP and per-device limit on new trials, e.g. 3 a day.

### What a guest can do in the Studio
- Can: create up to 2 designs; prompt (within the free prompts); see renders, previews and the in-progress 3D view;
  report a mistake; small uploads (e.g. 25 MB total).
- Needs an account: finalize (pay or use a credit), download pieces or packages, Download all, top up prompts, redeem a
  gift code, more than 2 designs.
- Settings, billing and orgs: account only. Trial users have no org or roles and can't be invited.
- Every blocked action opens the sign-up sheet in place, saying what it unlocks, e.g. "Create a free account to
  finalize *Neon Jacket*. Your design and its 4 revisions are saved." After sign-up, the action they tried continues.

### Free prompts
- The existing `reservePrompt` path with a `trial` plan: a total allowance instead of a daily one, a low cost ceiling
  (e.g. $3 for the whole trial), give-back on error still applies.
- The Studio shows "2 of 3 free prompts left". At 1 left, a gentle note. At 0, the prompt box turns into a sign-up card:
  "Create a free account to keep designing. You'll get your daily prompts (3 a day on Free), and everything you made
  stays here." The card shows a preview of their design and links to plans.
- A global daily budget across all trials. When reached, new trials can still look around, but prompting says "Free
  tries are busy right now — create an account to keep going."

### Converting
- Signing up from a trial (email, Google, Discord or wallet) upgrades the same `users` row: sets the identity, clears
  `is_trial`, applies the Free plan and resets prompts.
- Signing in to an existing account from a trial moves the trial's work into that account (designs and uploads change
  owner, usage history is dropped, the trial row is deleted), in one transaction.
- Email sign-up keeps its verification rules.

### Getting in
- Public entry point `/try/studio` with a prompt box straight away, no sign-in redirect, linked from the landing page
  ("Try it — no account needed").
- The dashboard shell for guests: a slim trial bar ("You're trying Virvi. Create an account to save your work"; Sign up
  primary, Sign in secondary). Nav items guests can't use show a lock and open a short explainer; never hidden.

### Analytics
Track trial started, prompts used, the first blocked action, sign-up from trial (and which blocked action led to it),
and trial expired.

### Safety
- Trial users can only reach their own data. Add a trial user to the cross-account walk; every non-allowlisted route
  returns `account_required`.
- Existing Studio moderation applies. Trial renders and uploads are private.

## Later phases (not in this build)
- Phase 2: the scene builder wizard, import, the room-scan builder and the demo views for guests; deploying creates the
  account from the wallet.
- Phase 3: Decentraland previews in a Virvi-owned preview World.

## Still open
- Preview World capacity (phase 3).
- Expiry reminder. Phase 1 call: show the expiry date in the trial bar; "email me a link" can come later.
