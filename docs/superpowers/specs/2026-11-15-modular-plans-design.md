# Modular plans: one base plan, add-ons, and packs

**Status:** draft for the owner. **(owner)** marks a decision that is the owner's. Prices marked *proposal* are the
author's starting numbers; each must pass the profit rule (below) against real bills before launch.

## Why

Virvi's subscriptions have to pay for very different things: the server and database, an always-on streaming server
and the bandwidth its viewers use, image and video hosting, hosted worlds, and the Design Studio's model costs. Today
there are five fixed tiers (`TIER_LIMITS` in `apps/server/src/integrations/stripe.ts`) that bundle all of it.

What we learned from customers and from production:

- **The Studio's prices feel wrong.** People called $29 to finalize a wearable extortionate, and the $5 top-up of 10
  prompts useless. Of 6 finalize checkouts so far, 4 were free (gifts or waivers) and the 2 that cost $58 were
  abandoned.
- **The tiers give away the expensive parts.** Creator ($15 planned) includes 15 prompts a day, up to 450 a month. At
  the costs we've recorded that's about $67 a month on Codex and $300+ on Claude, for a $15 plan.
- **A streamer pays for Studio prompts they never use, and a designer pays for streaming.** Neither feels like a deal.
- **No plan can be bought yet.** Production has no `STRIPE_PRICE_*` settings and the live Stripe account has no Virvi
  prices. Nobody is paying, so the plans can change without moving anyone.

## Goals

- **Affordable:** a small entry price, and nobody pays for parts they don't use.
- **Understandable:** a pricing page a new user reads in under a minute. Only two things ever run out: Studio prompts
  and streaming hours.
- **Profitable:** every part pays for what it costs us, even for the heaviest user, and usage sold beyond a plan is
  always sold at a profit.
- **Configurable:** someone can add exactly the parts they need on top of the base plan.

## Non-goals

- Teams and organizations. `subscriptions` has an `orgId`, but org billing is a separate design.
- Self-hosting. `config.allFeaturesUnlocked` keeps everything unlocked, unchanged.
- Enterprise. It stays by arrangement (Contact Sales).
- Usage-based billing after the fact (metered invoices). Everything is paid in advance: a plan, add-ons or packs.

## Anti-goals

- **A page of sliders.** Fully build-your-own pricing makes new users guess what they need before they've used
  anything, and every support question starts by working out someone's configuration.
- **Surprise bills.** Nothing charges more than the customer chose in advance. When something runs out, it stops and
  offers a pack.
- **Many small charges.** Add-ons come in a few meaningful sizes, not per-unit switches; five $3 lines feel worse than
  one $15 plan.

## What we pay for

| Cost | Runs on | Grows with | What we know |
|---|---|---|---|
| Server and database | Railway (`virvi-server`, `Postgres`) | fixed | bill not yet read |
| Streaming server | Fly `vlm-streaming`: one always-on `performance-2x`, 4 GB | fixed, then a step per extra server | about $62/mo; **`MAX_STREAMS = 4` for all customers together** |
| Stream viewers | bandwidth out of Fly | viewers × hours | **`live.virvi.io` is served straight from Fly, no CDN** (checked: `server: Fly`, `via: fly.io`). About $0.02/GB, and a 1080p viewer-hour is about 2 GB: **about $0.04 per viewer-hour** |
| Images and video | Cloudflare R2 behind `cdn.virvi.io` | GB stored | $0.015/GB-month, free egress: 500 GB costs $7.50/mo |
| Hosted worlds | Fly machines in `vlm-worlds` | worlds | machine sizes and bill not yet read |
| Design Studio | Anthropic and OpenAI tokens; Fly `vlm-studio-worker` (`performance-4x`, $0.17/h, stopped between prompts) | prompts | recorded per prompt (below) |

**Studio costs recorded in production** (57 prompts, 2026-10-29 to 11-15; worked out from token counts and
`apps/studio-worker/studio_worker/prices.json`, not yet checked against the providers' bills):

| | Codex | Claude |
|---|---|---|
| Wearable, first build | $0.22 | $1.24 |
| Wearable, each tweak | $0.14 | $0.72 |
| Emote, per prompt | $0.14–0.17 | $2.00–2.77 |
| A whole wearable design | $0.53 | $2.56 |

Recorded totals to check against the bills: Anthropic $28.14 (23 prompts), OpenAI $4.29 (28), xAI $5.30 (6).

**Before any price is set**, read one month of every bill above and compare the Studio totals with ours. If the bills
are higher, the gap is cost we don't record (local and test runs, failed prompts, a wrong rate) and prices must cover it.

## The profit rule

Every part of the offer is priced by one rule, so prices can be re-checked whenever costs move:

1. **A recurring part's price ≥ its share of fixed costs + the cost of its included usage if fully used.** The heaviest
   member of a part breaks even; average members, who use a fraction, are where the margin is.
2. **A pack's price ≥ 2 × its usage cost at the expensive end** (Claude for prompts, a well-watched stream for hours),
   after Stripe's fee (2.9% + 30¢, so no pack under $10).
3. **Storage and features are generous**, because they cost us little and make the plan feel worth it.

The numbers live in settings, never in code, so a price change after the bills is a settings change.

## The offer

### Free

- Scenes, the wizard, and imports, as today. 1 GB storage. 1 hosted world.
- Studio: 3 prompts a day to try it; **finalizing costs $7 per wearable, $9 per emote, $4 per extra piece in a set, $3
  per later revision** (*proposal*; today $29 / $39 / $19 / half price).
- Packs at the Free price.

### The base plan (*proposal*: about $9/mo) **(owner: name and price)**

What everyone who pays gets, chosen because it's cheap for us or everyone needs it:

- 25 GB storage, 1 hosted world, HUD editing, 1 API key, 30-day analytics.
- **Finalizing is free.**
- A small monthly Studio allowance (*proposal*: 30 prompts a month).
- Packs at the member price.

### Add-ons (monthly, any combination, each in a few sizes)

| Add-on | What it adds | *Proposal* | Prices against |
|---|---|---|---|
| **Streaming** | 20 hours a month, 1 stream at a time; 60 hours in the larger size | $10 / $25 | streaming capacity and viewer bandwidth |
| **Studio prompts** | 100 or 300 more prompts a month | $20 / $50 | model costs |
| **Extra hosted worlds** | +1 or +5 worlds | $5 / $20 | world machines |
| **Pro features** | recording, custom domain, 3D heatmap, 90-day analytics and export, cross-world broadcast, 5 API keys, 100 GB more storage | $10 | little cost: value, not usage |

The add-on list is short on purpose. Anything that costs us little goes in the base plan or Pro features rather than
becoming a switch.

### Packs (one-off, never expire)

| Pack | Free | Member | Notes |
|---|---|---|---|
| 100 Studio prompts | $40 | $30 | the friend's ladder; a smaller first pack (30 for $15) for Free users **(owner)** |
| 10 streaming hours | — | *proposal* $8 | members only, since Free has no streaming |

Bought prompts and hours are used after the month's allowance, and **bought prompts skip the hidden daily cost
ceiling** (they're paid for at a profit). The $3 per-prompt stop stays. Today `reservePrompt` in
`apps/server/src/studio/quota.ts` refuses a bought prompt once the day's cost passes the plan's ceiling ($6 on Free),
so a Free user with 100 bought prompts is stopped after about 6 Claude prompts.

### Max mode (the Claude agent) **(owner: name)**

- The Claude agent is offered as a premium mode: "slower and more careful, uses 3 prompts per message." Codex is the
  standard mode at 1 prompt.
- **Emotes in Max mode use 5 prompts**, because a Claude emote prompt costs $2–3.
- Not "Pro mode": Pro is today's plan name and would collide with Pro features.
- **We have no evidence yet that Claude's results are better.** Production has 5 ratings, all on Codex. Before
  marketing it as premium, compare the two (LIV-142's ratings, or a side-by-side on a few briefs).

### Ready-made bundles on the pricing page

Most people should click one of three cards; "Customize" opens the add-ons.

| Bundle | Made of | *Proposal* |
|---|---|---|
| **Creator** | base | $9 |
| **Streamer** | base + Streaming 20 h | $19 |
| **Designer** | base + Studio 100 + Pro features | $39 |

A bundle is just a preset of add-ons, not a separate tier; a customer can add or remove parts later in the portal.

## Streaming needs a decision first **(owner)**

At about $0.04 per viewer-hour straight from Fly, one 20-hour month watched by 50 people costs about $40 in bandwidth,
more than any sensible add-on price. Two ways out:

1. **Put `live.virvi.io` behind a CDN** (Cloudflare in front of the HLS segments). Segments are cached at the edge, so
   bandwidth no longer grows with viewers and streaming hours become the only meter. Check Cloudflare's terms for
   serving video through its CDN on our plan, or use a video-friendly CDN.
2. **Meter viewer-hours too**, with the add-on including e.g. 1,000 viewer-hours. Accurate, but a second meter is harder
   to understand.

The author recommends 1. Either way, **the 4-streams-at-once limit is shared by every customer**: the Streaming add-on
should reserve capacity, and selling more than 4 concurrent streams needs a second streaming server (about $62/mo each).

## How it changes the code

### Today

- One subscription row per user with one `tier`; `tierFromPriceId` reads only the first Stripe subscription item.
- Limits come from `TIER_LIMITS[tier]` (read in `getSubscription`, `hyperfy/slots.ts`, `media/quota.ts`,
  `studio/quota.ts`, `analytics/jobs.ts`, `routes/billing.ts`).
- Features are gated by tier rank in `middleware/feature-gate.ts` (`FEATURE_TIERS`).
- **Streaming minutes are shown on the billing page but never enforced.**
- Studio prompts are counted per UTC day (`studio_usage_days`).

### After

- **A catalogue in config** (`billing/catalogue.ts`): the base plan and each add-on size, its Stripe price id (from a
  setting), and what it adds: limit increments (`storageBytes`, `hyperfyInstances`, `streamHoursPerMonth`,
  `studioPromptsPerMonth`, …) and feature flags (`recording`, `customDomain`, …). Bundles are presets of catalogue
  entries.
- **Stripe:** one subscription per customer with several items (base + add-ons, each with a quantity). Checkout in
  `subscription` mode takes several line items; changes go through the Customer Portal or an in-app "Customize" page
  using subscription item updates with proration.
- **`subscription_items` table**, synced from `customer.subscription.*` webhooks: price id, catalogue key, quantity.
- **`entitlements(userId)`** replaces `TIER_LIMITS[tier]`: Free's limits, or the base plan's plus each item's increments
  × quantity. `getSubscription` returns it as `limits`, so most readers change only their import. Cached per request.
- **Feature gate by flag:** `requireFeature` checks `entitlements.features[feature]` instead of tier rank. Its 403 names
  the add-on that unlocks the feature, so the page can offer exactly that.
- **Monthly Studio allowance:** prompts counted per billing period (from `currentPeriodStart`), not per day. Keep a daily
  cap as abuse protection only. Max mode weighting (3, emotes 5) happens where a prompt is reserved, so allowance,
  packs, refunds and the cost ceiling all count weighted prompts.
- **Streaming enforcement (new):** count stream hours per billing period from the existing stream sessions; refuse a new
  stream with `upgrade_required` / `pack_required` when hours or the concurrency slot run out; a live stream that runs
  out gets a warning and a grace period rather than a cut mid-show **(owner: grace length)**.
- **Packs:** the existing one-off checkout (`studio_payments` kind `topup`) takes a pack size from the catalogue, and a
  new kind `stream_hours` adds hours to a balance like `studio_prompt_credits`.
- **Pages:** the pricing page (three bundle cards + Customize), the billing section (one usage bar per meter, the
  add-ons with change buttons), and the Studio's prompt counter (monthly, with Max mode's cost shown before sending).
- **Notifications:** an email at 80% and 100% of each meter, with a link to the right pack.

### What stays

- Self-hosted mode, admin bypass, the Studio's gifts, Virvi credit and MANA payments, mistake refunds, and the per-prompt
  $3 stop.
- The `tier` column, kept as the name of the bundle a customer started from (for analytics and support), no longer used
  to gate anything.

## Rollout

1. **Costs:** read the bills, settle the streaming CDN question, and fill in every price with the profit rule. Write
   the result into this document.
2. **Entitlements under the current tiers:** add the catalogue, `entitlements()` and flag-based gating, with today's
   five tiers expressed as catalogue entries. No visible change; tests prove every limit reads the same.
3. **Add-ons and bundles:** Stripe prices, multi-item checkout, `subscription_items`, the Customize page.
4. **Meters:** monthly Studio allowance, Max mode weighting, bought prompts past the cost ceiling, streaming hours
   enforcement, stream-hour packs, the 80%/100% emails.
5. **Studio prices:** free finalize for members, the new Free finalize prices, the new pack ladder.
6. **Launch:** set the `STRIPE_PRICE_*` settings, publish the pricing page.

## Decisions for the owner

1. The base plan's name and price, and its included Studio prompts.
2. Whether to put streaming behind a CDN (recommended) or meter viewer-hours.
3. Max mode's name, and whether to launch it before a quality comparison.
4. A smaller first prompt pack for Free users, and its price.
5. What happens to a live stream that runs out of hours, and how long the grace period is.
6. Whether to keep Studio ($149) and Enterprise as bundles or retire Studio.
7. Yearly billing (e.g. two months free): now or later.

## Left to the builder

- Exact table and column names, catalogue file layout, and how proration is shown before a change is confirmed.
- Caching of entitlements and when the webhook sync re-reads Stripe.
- How the in-app Customize page and the Stripe Customer Portal divide the work.
