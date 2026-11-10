# Design Studio (server)

People design Decentraland wearables and emotes by talking to an agent (Claude Code or Codex). Each design gets its
own Fly worker machine (`apps/studio-worker`), which talks to the routes here through
`apps/studio-worker/CONTRACT.md`.

| File | What |
|---|---|
| `store.ts` | the private studio bucket, and the contract's file paths |
| `quota.ts` | the daily prompt allowance and the hidden daily cost ceiling, per plan (`TIER_LIMITS`) |
| `machines.ts` | one Fly worker machine per design, and its worker token (only the hash is stored) |
| `results.ts` | applying a worker's Result once, and failing lost jobs |
| `designs.ts` | prompts, renders, view keys and the design detail the dashboard reads |
| `render-urls.ts` | signed, hour-long URLs for render frames: the only files a browser receives |
| `events.ts` | progress on the bus, relayed to the page by the `virvi_studio` room (`src/ws/VirviStudioRoom.ts`) |
| `pricing.ts` | what finalizing costs: first finalize, extra pieces, half-price revisions, and the checker gate |
| `payments.ts` | one-time Stripe Checkout for finalizing and top-ups, applied once from the webhook; entitlements, finalize jobs, mistake refunds |
| `scope.ts` | keeping the studio to design work: the turn-down log, flags for the owner (and their email), pausing an account |
| `credit.ts` | Virvi credit: a balance in USD cents per account, and a ledger row for every change |
| `merge.ts` | moving a visitor wallet's studio data (records, counters, credit, memberships, invites, notifications) onto an existing account |
| `handover.ts` | an owner's account deleted: each design they share passes to its longest-standing collaborator, else viewer (`studio_owner` notification); unshared ones go with the account |
| `mana/` | paying in MANA: the rate (`rate.ts`), quotes (`quote.ts`), the Polygon reader (`polygon.ts`), settling and the watcher (`settle.ts`), MANA-back requests (`refunds.ts`) |
| `ratings.ts` | 👍 / 👎 on each revision (an agent reply that changed pieces), and a 👎's one free "Try again with this feedback" (LIV-142) |
| `rating-review.ts` | what admins learn from ratings: the 👎 review queue, the weekly digest (the admin page's, and the Monday email to every admin, sent once per week), and the 👍 rate per agent and model for each kind |
| `lessons.ts` | lessons for the agent per design kind: drafted, approved by an admin, then sent with every new prompt of that kind (the job's `lessons`), at most 4,000 characters live per kind |
| `lesson-drafts.ts` | Claude (ANTHROPIC_API_KEY, Sonnet 5.5) drafting one lesson from a batch of 👎s of one kind |
| `prompt-help.ts` | "Improve my prompt": Claude (ANTHROPIC_API_KEY, Haiku 5.5) rewriting a draft into a concrete request with a few quick-pick questions, never sent to the agent; its own daily limit per account |
| `prompt-ideas.ts` | example prompts for a design's first message: about 200 wearable and 60 emote ideas in code, served a few at a time to follow the chips (`GET /designs/:id/prompt-ideas`), each retired for everyone once someone sends it as a first prompt, edited or not (`studio_idea_uses`); the admin page counts what is left per slot and move |
| `defaults.ts` | the agent a new design of each kind starts on, set by an admin beside the 👍 rates (never automatically) |
| `timings.ts` | how long each prompt waits for its first reply (`studio_jobs.timings`): the machine, each step's seconds, the finish log line, the admin page's First reply card and the design detail's `typicalFirstReplySec` |
| `warm.ts` | starting a design's machine while the person writes a prompt (`POST /designs/:id/warm`), so the prompt doesn't wait for it |
| `members.ts` | who a design is shared with (LIV-159): the owner, and open `studio_design_members` rows as collaborator or viewer |
| `invites.ts` | inviting people to a design by email or link (14 days; resent at most once an hour and 3 times in all, `resend_count` and `last_sent_at`), accepting and declining, role changes, removing and leaving; at most `STUDIO_MAX_MEMBERS` members plus open invites per design and 50 invites per owner per UTC day; the email goes out only when SMTP is set |
| `sweep.ts` | every minute: fails lost jobs and refunds them, restarts machines for waiting jobs, destroys idle machines, settles MANA transfers and expires unpaid MANA quotes; then the trial sweep and the weekly ratings digest |

Routes: `src/routes/studio.ts` (the dashboard, `/api/studio`) and `src/routes/studio-worker.ts` (the workers,
`/api/studio/worker`). Every studio route answers 404 unless the studio is enabled.

## Paying

- **Finalizing** a piece pays for its latest revision: `GET /designs/:id/finalize` quotes it, `POST` opens a Stripe
  Checkout (or grants at once when every line is waived). The webhook makes an *entitlement* per paid revision and
  queues a `finalize` job, which builds the package from that revision's stored files. Anyone on the design downloads
  it from `GET /designs/:id/pieces/:category/revisions/:number/package`; a failed package is retried free with
  `…/package/retry`.
- **Shared designs** (LIV-159): any collaborator finalizes and pays with their own card, credit, free finalizes or
  MANA, and the payment and entitlements are theirs. Another member's open checkout for the same revision refuses a
  second one (`409 checkout_open`). Only the payer reports a mistake on it, and a paid scene piece goes to the payer's
  asset library (the owner's once the payer's account is gone). Someone who left keeps the packages that became ready
  while they were on the design, and the ones they paid for: `GET /past-packages` and
  `GET /past-packages/:entitlementId/package`.
- **Some of the pieces** (LIV-81): both take `categories` (`?categories=a,b` on the quote), so the creator pays only
  for the pieces ticked. A partly finalized design (`finalizedPieces` of `pieceCount`) stays open for prompts and
  counts toward the open-design limit until every piece is finalized. Finalize's emote checks for a selection wear the
  chosen pieces and the finalized ones only (`categories` on `set-renders`, `emote-checks`, `clipping`,
  `finalize-renders`, and `GET /designs/:id/set`).
- **Revisions** (every finalize after a piece's first) are half price. A customer who says the revision fixed the
  agent's mistake (`…/report`, within 30 days, or at checkout) is refunded that line in full, at once.
- **Top-ups** (`POST /topups`) add prompts used after the day's allowance; they never expire.

## Deploying (the owner's steps)

The studio is on when `VIRVI_MODE=cloud` and both `STUDIO_WORKER_IMAGE` and `STUDIO_S3_URI` are set.

1. **A private R2 bucket.** In Cloudflare, create a bucket `vlm-studio` with no public access and no custom domain,
   and an R2 API token with Object Read & Write on that bucket only. It must not be the public uploads bucket.
2. **Railway variables** on the server service:
   - `STUDIO_S3_URI=s3://<access key id>:<secret>@<account id>.r2.cloudflarestorage.com/vlm-studio`
   - `STUDIO_WORKER_IMAGE=registry.fly.io/vlm-studio-worker:<tag>`, the image deployed from `apps/studio-worker`
   - `STUDIO_FLY_APP` only if the worker app isn't `vlm-studio-worker`
   - optional: `STUDIO_CLAUDE_MODEL` (default `claude-opus-5-5`), `STUDIO_CODEX_MODEL` (default `gpt-6.1-sol`),
     `STUDIO_GROK_MODEL` (default `grok-build-0.1`)
   - optional, for "Improve my prompt" (`POST /designs/:id/prompt-help`, which needs `ANTHROPIC_API_KEY` and answers
     `503 prompt_help_unavailable` without it): `STUDIO_PROMPT_HELP_MODEL` (default `claude-haiku-5-5`) and
     `STUDIO_PROMPT_HELP_PER_DAY` (default 30 per account and UTC day, trials included; `429 prompt_help_limit` past
     it; 0 answers `503` like a missing key, so the button hides). It never uses a prompt or counts toward the cost ceiling; the count is `studio_usage_days.prompt_helps`,
     added at boot like the other columns.
   - The example prompts under "What makes a good prompt" need nothing set: the ideas are in `prompt-ideas.ts`, and the
     ones already used are `studio_idea_uses` (one row per idea), made at boot like the other tables. An idea's id
     never changes once shipped; to drop one, delete it from the pool. **Example ideas** on the admin page
     (`GET /api/admin/studio/ideas`) shows how many are left per slot and move, flagging any with fewer than 3.
3. **The schema.** The server makes it at boot: `entrypoint.sh` runs `drizzle-kit push` before it starts the server,
   then a hand-written fallback (`CREATE TABLE IF NOT EXISTS` / `ADD COLUMN IF NOT EXISTS`) in case push failed. That
   covers the `studio_*` tables (four of them for payments, and `studio_idea_uses` for the example prompts), new columns
   (`studio_designs.finalized_at`, `studio_jobs.counted_from`, and for the first-reply wait `studio_jobs.timings` and
   `studio_designs.warmed_at`), and the MANA and credit tables below. Collaboration (LIV-159) adds
   `studio_design_members`, `studio_design_invites` and `notifications`, the sender columns `studio_messages.user_id`
   and `studio_jobs.user_id` (null means the owner), and makes `studio_payments.user_id` nullable with `ON DELETE SET NULL`
   (a deleted payer's payment stays, because entitlements reference it). `STUDIO_MAX_MEMBERS` (default 50) caps members plus
   pending invites per design. Nothing needs running by hand first; to check
   the schema before a deploy, `drizzle-kit push` against production does the same.
4. **Fly.** Confirm that the server's `FLY_API_TOKEN` can manage machines in `vlm-studio-worker`, in the
   `FLY_WORLDS_ORG` org (`vlm-worlds`). The agent keys are that app's secrets (`fly secrets import -a
   vlm-studio-worker`), never Railway variables or machine env.
5. **Spend limits** on the Anthropic and OpenAI keys: the daily cost ceilings are a backstop, not a budget.
6. **Stripe.** On the existing webhook endpoint (`/api/billing/webhook`), also enable `checkout.session.completed`
   (already on for subscriptions), `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`
   and `checkout.session.expired`. Nothing
   needs creating in Stripe: prices are sent with each checkout. They are settings, in US cents:
   `STUDIO_PRICE_WEARABLE_CENTS` (2900), `STUDIO_PRICE_EXTRA_PIECE_CENTS` (1900), `STUDIO_PRICE_EMOTE_CENTS` (3900),
   `STUDIO_REVISION_WEARABLE_CENTS` (1500), `STUDIO_REVISION_EXTRA_PIECE_CENTS` (1000), `STUDIO_REVISION_EMOTE_CENTS`
   (2000), `STUDIO_TOPUP_CENTS` (500) and `STUDIO_TOPUP_PROMPTS` (10).
7. **The worker image** must be rebuilt and pushed for finalize jobs: it adds ffmpeg and Decentraland's animations
   (`apps/studio-worker/README.md`, "Releasing an image"), then `STUDIO_WORKER_IMAGE` points at the new tag.

8. **Keeping the studio to design work** (`scope.ts`, `routes/admin-studio.ts`, the admin page Studio flags):
   - The worker checks each prompt the user typed with Claude Haiku before the agent runs (`studio_worker/scope.py`).
     An off-topic message ends as `off_topic`, not counted for the first `STUDIO_FLAG_THRESHOLD` in the window and counted
     after that; an agent that stops on one ends as `declined` (counted).
     Both are logged in `studio_scope_events`; the user sees only a category's fixed words, never the model's note.
   - An account with `STUDIO_FLAG_THRESHOLD` (3) turn-downs within `STUDIO_FLAG_WINDOW_HOURS` (24) is flagged once,
     and the owner is emailed at `STUDIO_FLAG_EMAIL` (unset: nothing is sent). Admins dismiss flags and pause or
     resume an account's studio access; a paused account can't send prompts, start designs, request renders, upload or
     buy top-ups, and can still finalize, pay and download.
   - A piece's first `STUDIO_INSTANT_REPORTS` (2) mistake reports refund at once; later ones are charged and wait for
     the owner's Approve or Decline on the same page, with an email.
   - **The owner's steps:** SMTP (`SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `EMAIL_FROM`) and
     `STUDIO_FLAG_EMAIL` on Railway; no email goes out without SMTP.
   - **Deploy order:** the server first (it accepts the `off_topic` and `declined` outcomes and creates the new tables
     at boot), then the worker image: `fly deploy --build-only --push --remote-only --image-label <sha>` from
     `apps/studio-worker`, then `e2e/fly.sh <image>`, then `e2e/scope_eval.py` on a machine of that image (it fails if
     a designer's message would be turned down), then `STUDIO_WORKER_IMAGE` on Railway.

## The first-reply wait

After a prompt is sent, the page lists the steps until the agent's first progress line (Starting your studio,
Checking your request, The agent is reading your request) with the time so far, and "Usually about N seconds" from
`typicalFirstReplySec` (the median over the last 50 timed prompts, cached 5 minutes; absent below 5).

- **Timings.** Each prompt job's `timings` (jsonb, null for other jobs and older prompts) holds `machine` (what
  `ensureWorker` did for it: `created`, `started`, `running` or `external`) and the seconds from the job's
  `createdAt` to `taken`, `screening` (the off-topic check, before the agent), `building`, `firstProgress` (the
  first progress line the page shows, not a `Running:` command) and `done`, plus the worker's `boot` seconds and
  whether it `restored` a workspace. Each is written once, as its event arrives; later progress lines write nothing.
  A worker image from before the `boot` event and the `screening` phase gives no `boot` or `screening`, and the
  rest still fills in. A finished prompt logs one line, ids and seconds only:
  `[studio] job <id> timing: machine=created taken=24s boot=9s screening=31s building=35s first_progress=52s done=310s`.
- **Admin.** `GET /api/admin/studio/first-reply` (the Studio admin page's First reply card): the median and 90th
  percentile of created → first progress over the last 50 timed prompts, by `machine`, and the median of each step.
- **Warming.** When someone starts typing a prompt, taps a slot or emote chip, or attaches a file, the page calls
  `POST /designs/:id/warm` (once per 5 minutes per design): the machine is made or started with no job, and the
  worker boots, restores and polls until a prompt comes or it exits idle after 600 s. It answers 204 whether it warmed
  or not, and does nothing when the account couldn't send a prompt (no prompts left, past the cost ceiling; a paused
  account gets the prompts route's 403), a job is already waiting or running, the design is archived,
  `STUDIO_MACHINES=external`, or the design was warmed in the last 5 minutes (`studio_designs.warmed_at`). No job is
  made, so nothing is counted or charged. The sweep counts `warmed_at` as activity, so it doesn't destroy a machine
  just warmed on a design idle for days.
- **Deploy order.** The server first (it accepts the `boot` event, and the timings columns are made at boot), then
  the worker image, which adds the `boot` event and the `screening` phase.

## Paying with MANA and credit

Besides a card, a customer can pay for finalizing and top-ups with MANA on Polygon, and with Virvi credit.

### Settings (the owner's steps)

MANA is off until `STUDIO_MANA_RECIPIENT` is set. Then the Pay with MANA button shows, and the MANA routes answer
`503 mana_unavailable` while it is unset.

- `STUDIO_MANA_RECIPIENT`: the wallet that receives the MANA. Checked at boot: it must be a valid address with the right
  upper/lower-case checksum, or the server refuses to start. The server never holds a key for it.
- `POLYGON_RPC_URL`: the Polygon node the server reads transfers from (default `https://polygon-rpc.com`, a free public
  node). For production use a paid RPC, such as Alchemy's Polygon endpoint; a public node is slow and rate limited, and
  a flaky one delays settling.
- `STUDIO_MANA_TOKEN`: the MANA token contract on Polygon, default `0xA1c57f48F0Deb89f569dFbE6E2B7f46D33606fD4`.
  **Confirm this address on Polygonscan (and in Decentraland's docs) before turning MANA on.** If it is wrong, nothing
  is ever settled by mistake: payments just don't verify.
- `STUDIO_SCENE_PARCEL`: the studio scene's base parcel as `x,y` (for example `-12,34`). The studio pass (below) is only
  issued to a scene on this parcel, and only from an official Genesis City realm: a World or someone else's realm that
  claims the parcel gets no studio pass.

### The new tables

The server's boot makes them, before it starts (`entrypoint.sh`: `drizzle-kit push`, then the fallback, which has
the same tables, columns and indexes): `studio_credits`, `studio_credit_ledger`, `studio_mana_transfers`,
`studio_mana_scan` and `studio_mana_refunds`. It also adds columns to `studio_payments` (`method`, `credit_held_cents`,
`mana_amount_wei`, `mana_usd_rate`, `mana_tx_hash`, with the unique hash and the partial unique index on open quotes'
amounts) and to the entitlement and mistake-report tables (`method`, `credit_cents`, `credited_cents`, `mana_cents`).
A transfer's `payment_id` and a MANA-back request's `report_id` are `ON DELETE SET NULL`: deleting an account keeps
those records, unlinked.

### Credit

Credit is a balance in US cents per account, and every change (hold, release, spend, refund, merge, MANA-back request)
is a row in `studio_credit_ledger`. A checkout spends it in a fixed order: free finalizes (gifts) first, then credit,
then card or MANA for the rest. A checkout that credit covers entirely is paid at once with no card or MANA step.

Credit a checkout is going to use is *held* from the balance while the checkout is open, so it can't be spent twice. When
the checkout expires unpaid, the hold is released back, once. When it is paid, the hold becomes the spend. Opening a new
checkout for the same design takes over the previous one's holds.

### How a MANA payment settles

1. **Quote.** The customer picks Pay with MANA. The server prices what is left after gifts and credit at the current
   MANA/USD rate from CoinGecko, fetched on the server (never taken from the browser). With no good rate in the last
   5 minutes it refuses with `503 rate_unavailable`. The quote holds for 10 minutes. Its amount is rounded up to a
   millionth of a MANA and ends in a random few digits of wei, so no two open quotes ask for the same amount.
2. **The customer's wallet sends** exactly that amount of MANA to the recipient.
3. **The server learns of it** in one of two ways: the page reports the transaction hash, or the watcher (run by the
   minute sweep) finds the transfer to the recipient by itself.
4. **Checks.** The transaction must be mined and not reverted, hold a MANA transfer to the recipient for *exactly* the
   quoted amount, and have been mined within the quote's 10 minutes plus a 15-minute grace. A transaction hash settles
   at most one payment, ever.
5. **30 confirmations.** Until the transfer is 30 blocks deep the page shows it as confirming; then the payment is
   granted. A quote that expired while its transaction was on the way is reopened (gifts and credit held again) and
   granted. If a gift or credit was spent in the meantime, the payment is still granted and the owner absorbs that small
   shortfall.

A quote that nothing paid is expired by the sweep once the grace has passed, releasing its holds.

A transfer that matches no payment (wrong amount, too late, sent twice, or from someone who never opened a checkout) is
kept and shown to the owner under **MANA payments that didn't match** (below).

### Refunds

A mistake-report refund goes back the way each line was paid:

- the card part goes back through Stripe;
- the credit part and the MANA part go back as credit;
- a gift line gets its free finalize back.

A grant-time overcharge (for example a second quote paid as well) also returns as credit; for a card payment, only the
card share goes back to the card. If a refund couldn't be paid at once the sweep retries it.

The MANA part of a refunded mistake report can be turned back into MANA: `POST /api/studio/mana-refunds` with the report
id takes that much credit and makes a MANA-back request to the customer's verified wallet. It is refused if the report
has no MANA part, was already asked back, the account has no verified wallet, or the credit has been spent since.

### The owner's two sections on the Studio flags page

On the admin page **Studio flags** (`/admin/studio`), besides flags and mistake reports:

- **MANA refunds to send.** Each request shows the customer, the USD value and their wallet. Get the amount to send from
  the page (the USD value at the current rate, rounded up to a millionth of a MANA), send it from your own wallet, then
  paste the transaction hash. The server checks on Polygon that it is a MANA transfer of that amount to that wallet
  before marking it sent. Or decline (type DECLINE): the credit goes back to the customer.
- **MANA payments that didn't match.** Each transfer comes with the open or expired payments it might be (asking for
  within 5% of the amount, created within a day, nearest first). Either *settle by hand* against one of them, which
  grants that payment, or mark it *returned* after sending the MANA back from your own wallet and pasting that hash.

### The studio pass and the checkout link

The studio scene signs in with a wallet and gets a *studio pass*: it works on the studio routes (those declaring
`scenePass.studio`, including the MANA-back request) and on `/api/auth/handoff`, and is refused everywhere else with
`403 studio_pass_not_allowed`. The pass is only issued for `STUDIO_SCENE_PARCEL` on an official Genesis City realm.

From the scene, `/api/auth/handoff` gives a one-time checkout link code that lives 10 minutes (an ordinary sign-in code
lives 60 seconds). The website trades it for a full wallet session, so the visitor can pay in the browser and come back
to the scene. Codes work once and only their hash is stored.

When a visitor's wallet joins an existing account, their designs, payments, reports, counters and credit move to that
account (`merge.ts`), with a `merge` row in the credit ledger on each side.

To check a deploy's machine lifecycle without a user: `scripts/studio-fly-smoke.ts`. To run a real worker against
a local server: `scripts/studio-local.md`.
