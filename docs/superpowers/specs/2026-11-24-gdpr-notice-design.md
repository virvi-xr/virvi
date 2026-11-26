# GDPR notice: design

Owner request, 2026-11-24: "add the GDPR notice and log people's decision". The owner chose **both** places: scene
visitors and dashboard accounts. Old VLM had a GDPR notice with acceptance in its dashboard. Calls I made are marked
**(my call)**.

## Why

- **Scenes:** visitors are tracked from the moment they arrive. Virvi records pseudonymous usage events: arrive and
  leave, sampled movement, clicks and hovers, videos, emotes, camera mode (see apps/web/src/app/privacy/page.tsx).
  They get no notice and no choice, unless the host has wallet visibility on.
- **Dashboard:** accounts agree to the Terms (`termsAcceptances`), but they're never shown a privacy notice and get no
  choice about the optional processing: browser error reporting with page-visit breadcrumbs (LIV-66,
  apps/web/src/lib/errors/reporter.ts).
- **Both:** every decision must be logged with its version and time, so Virvi can show who agreed to what, and when.

## 1. Scene visitors

**Notice.** The first time a visitor enters any Virvi scene, a small HUD notice appears. It must not block movement and
must match the look of the existing scene notices: the BEAT and raffle cards, and the wallet-visibility notice. Copy
**(my call)**:

> This scene uses Virvi, which records how visitors use it (where you walk, what you click, videos you play) under a
> pseudonym, to give the host statistics. No wallet address is stored unless the host turns that on, and you'll be told
> if they do. [Accept] [Decline] · Privacy: virvi.io/privacy

The privacy link opens through the adapter's existing openUrl.

**Before a decision.** No analytics events leave the scene. The collector buffers them in memory, up to its existing
buffer limits:
- **Accept:** flush the buffer and carry on as today.
- **Decline:** drop the buffer, and send no analytics for the rest of the visit. That includes the wallet-visibility
  data.

Everything else in the scene works as usual either way: BEATs, raffles, giveaways, and the presence check-ins those
features need. Those features already have their own consent.

**One decision covers every Virvi scene (my call).** The decision is remembered server-side per visitor:
- **Key:** the verified wallet, or for a guest the guest id, hashed with a server-secret HMAC. That is a new,
  cross-scene key, deliberately separate from the per-scene analytics pseudonym. Reuse an existing server secret if a
  suitable one exists; otherwise derive one from an existing secret with a fixed label. Never add a new required env
  var.
- **When asked:** the visitor is asked again only when `ANALYTICS_CONSENT_VERSION` (in @virvixr/shared, starting at 1)
  goes up.
- **Fallback:** if the decision lookup fails (network), treat it as no decision yet. Keep buffering, and show the
  notice.

**Server:**
- `GET` returns the visitor's current decision. `POST` records one (`{ decision: 'accept' | 'decline', version }`).
  Both run under the scene's visitor or session auth, the way the BEAT and giveaway visitor routes do.
- **Stale version:** rejected with 400, like the Terms' StaleTermsError.
- **The log:** table `analytics_consents`, append-only, never updated in place. Columns: id, subject hash, decision,
  version, scene id where it was given, platform, created_at. The current decision is the latest row for the current
  version.
- **The analytics ingest endpoint also enforces it:** events from a visitor whose latest decision for the current
  version is `decline`, or who has no decision, are dropped server-side. The server applies the decision even when an
  old scene runtime ignores the notice. A scene running an old runtime never shows a notice, so its visitors never
  decide and their events would all be dropped. That would silently turn off analytics for every scene that hasn't
  redeployed, which isn't acceptable.
  - **Old runtimes:** on the ingest side, enforce only `decline`. "No decision yet" is enforced client-side by the new
    runtime's buffer. **(my call)**
- **No raw wallets:** no route returns or logs a raw wallet.

**Changing your mind:** the HUD gets a small "Privacy" entry wherever the existing HUD menu or settings live, which shows
the notice again. Making a new decision appends a new row.

## 2. Dashboard accounts

**Notice.** Once per `PRIVACY_NOTICE_VERSION` (in @virvixr/shared, starting at 1), a signed-in account sees a modal in
the dashboard. Copy **(my call)**:

> **Your privacy at Virvi.** Virvi stores your account details and what you build, to run the service (see the Privacy
> Policy). With your OK, Virvi also records errors in your browser and the pages you visited just before them, to fix
> bugs faster. [Accept] [Decline]

- **Placement:** follow the Terms prompt pattern, and show this modal after the Terms prompt, never on top of it.
- **Decline:** turns off browser error reporting for that account: the reporter doesn't start, and records no
  breadcrumbs. Server-side error reporting is unaffected; it's operational and covers no browsing.
- **Accept:** reporting runs as today.
- **Before a decision:** the reporter may start, but it holds breadcrumbs and sends nothing until the account accepts.
  On decline it discards them.
- **Changing your mind:** Settings gets a "Privacy" row showing the current choice and letting the user change it.
  Each change appends a row.
- **Server:** table `privacy_decisions`, append-only. Columns: user id (cascade on account delete), decision, version,
  via (`'prompt' | 'settings'`), created_at. Routes follow the `auth/terms.ts` pattern: status, and a record route that
  rejects a stale version.
- **Admins:** in the admin user view, show each account's current decision and when it was made. Admin user detail
  already shows the Terms state; put it beside that.

## Shared

- **Privacy page:** add a section to apps/web/src/app/privacy/page.tsx (and to apps/docs/src/content/docs/privacy.md,
  which it says to keep in step). It covers the visitor notice, what declining stops, the cross-scene decision record
  and how long it's kept (for as long as Virvi runs scenes; a deletion request removes it), and the dashboard choice.
- **Data deletion:**
  - `POST /api/analytics/me/delete` also deletes that visitor's `analytics_consents` rows. Exception: one final
    `decline` row is kept if the visitor declined, so their refusal keeps being honoured.
  - Account deletion cascades `privacy_decisions`.
- **Shipping:** a runtime version bump for Virvi-built scenes (v18 → v19) and a `@virvixr/dcl` minor bump (2.19.0 →
  2.20.0). The owner publishes to npm, so don't publish.
  - **Release order:** Scene Import breaks while `VIRVI_DCL_RANGE` names an unpublished version. Leave
    `VIRVI_DCL_RANGE` and `DCL_HUD_VERSION` at 2.19.0 in this branch, and say clearly in the report which constants
    must move once 2.20.0 is published. **(my call)**
  - Add the new ranges to `VIRVI_DCL_RANGES_WRITTEN` if that list needs them.

## Not in scope

- Cookie banners for the marketing site: it sets no non-essential cookies. Turnstile runs only on the trial forms, as a
  bot check.
- Per-host notice copy.
