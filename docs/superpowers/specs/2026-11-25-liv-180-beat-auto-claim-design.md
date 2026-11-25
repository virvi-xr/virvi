# LIV-180 part 1: BEAT auto-claim after consent

Part 2 of LIV-180 (the in-world claim booth) shipped as the giveaway kiosk. This is part 1, as written in the ticket.
Calls I made are marked **(my call)**.

## What changes

Today a visitor taps the BEAT card, agrees to attendance tracking, waits out the minimum time and then has to press
Claim. With auto-claim, agreeing to tracking also opts in to the claim: once the visitor meets the BEAT's rules
(minimum time present, inside the claim window, supply not used up), the claim happens on its own and the card says
"Your BEAT is on its way".

## Consent stays informed

- `beatConsentText(name, { autoClaim })`: when `autoClaim` is true the text also says that agreeing claims the BEAT to
  their wallet once they've been here long enough. The rest of the text stays the same.
- **Version:** this is consent version 3 (`BEAT_CONSENT_VERSION = 3`). Pin both v3 variants' hashes in
  apps/server/test/beats-shared.test.ts, next to v2's.
- **Old scenes (my call):** `trackBeat` accepts version 2 or 3, so scenes on older runtimes keep working. Store the
  version the visitor actually agreed to on the claim (today it always stores the constant). A claim under v2 is never
  auto-claimed: its visitor never read that wording.
- **Re-tracking:** tracking again with v3 over a present v2 claim upgrades its consentVersion/consentedAt. That's
  today's logic, applied to the version sent.

## Server

- **Column:** `beats.auto_claim` BOOLEAN NOT NULL DEFAULT true. Add it to the schema and the entrypoint.sh ALTER
  fallback, as `hold_mints` is.
  - BEAT create and edit accept `autoClaim`.
  - The host can turn it off per BEAT. It's on by default.
- **`VisitorBeat`:** gains `autoClaim: boolean` (the BEAT's setting).
- **When it claims:**
  - **On a check-in:** after a check-in updates the time, if the BEAT has auto_claim on, the claim is present, its
    consentVersion is 3 or more, and secondsPresent ≥ minPresentSeconds, call the existing `claimBeat` path (same
    locks, same checks: started, claim window, supply, per-network limit, platform check, new-wallet limit, blocked
    wallet).
  - **On `trackBeat`:** the same check runs at the end, for a BEAT already started with a minimum of 0.
  - **Idempotent:** `claimBeat` already returns a non-present claim as it is.
  - **Failures:** an expected refusal (`not_yet`, `not_started`, `too_late`, `all_claimed`, `too_many_from_network`,
    profile, new-wallet or blocked errors) is swallowed. The check-in still succeeds and returns the visitor view, so
    the card shows the state as before (sold out, or claimable with the manual Claim button).
  - **Wiring:** the check-in route must pass platform and ip, as the claim route does.
- **Guests:** unchanged. `trackBeat` already refuses a caller without a wallet (`no_wallet`), and the card prompts
  them to sign in.

## Card (adapter-dcl `beat/card.ts`)

- **Consent version:** the core client's `trackBeat` sends v3.
- **Consent body:** `beatConsentText(beat.name, { autoClaim: beat.autoClaim })`.
- **Tracking line:** while tracking an auto-claim BEAT, the line adds "It's claimed for you once you've been here long
  enough." **(my call on copy)**
- **Claim on its way:** the pending state's line for an auto claim starts with "Your BEAT is on its way." Keep the
  held/sending detail after it.
- **Manual Claim stays:** the `claimable` state keeps its Claim button as a fallback (auto-claim off, a v2 claim, or
  an auto attempt refused).

## Dashboard (apps/web `components/beats/BeatForm.tsx`)

- **Checkbox:** "Claim automatically", checked by default, with the help line "Visitors who agree to tracking get the
  BEAT sent once they've been here long enough. Turn off to make them press Claim."
- **Editing:** it can be changed while editing, as the other non-chain settings can.
- **Detail page:** shows the setting if the other settings are shown there.

## Docs and privacy

- The privacy page quotes `beatConsentText('{name}')`. Also quote the auto-claim variant, or say that agreeing also
  claims the BEAT when the host has that on.
- Update the BEAT docs page (apps/docs, the BEAT host and visitor pages) with one or two sentences.

## Tests (from the ticket)

- The check-in that crosses the threshold claims exactly once.
- Concurrent check-ins don't double-claim.
- No claim before the start, after the claim window, or when the supply is used up.
- No auto-claim when the BEAT has it off, or for a v2 claim.
- `trackBeat` with v2 still works; an unknown version is still 400 `bad_consent`.
- A guest (no wallet) still gets `no_wallet`.
- Card: the consent body and lines for autoClaim on and off.

## Shipping

- Runtime bump v19 → v20 (`bash dcl-runtime/build.sh`, after bumping DCL_RUNTIME_VERSION) and `@virvixr/dcl` 2.20.0 →
  2.21.0. Keep `VIRVI_DCL_RANGE` and `DCL_HUD_VERSION` at 2.20.0 until 2.21.0 is published.
- Don't publish to npm.
