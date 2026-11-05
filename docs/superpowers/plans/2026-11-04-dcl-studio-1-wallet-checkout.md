# Design Studio in Decentraland, Part 1: wallet accounts and checkout — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Decentraland wallet becomes a Virvi studio account that can check out through a one-time link, paying by card or MANA on Polygon, with Virvi credit for MANA refunds and an owner page for sending MANA back.

**Architecture:**
- **Payments:** MANA and credit are two more ways to fund the existing `studio_payments` row. Settled MANA goes through the same `grantPayment`, so entitlements, jobs and packages don't change. Credit is a USD-cents balance with a ledger. Checkouts hold it exactly as they hold gift finalizes today (`giftsHeld`).
- **Polygon:** reached through an injectable `PolygonReader`, using ethers 6, which is already a server dependency. Only JSON-RPC reads; the server never signs.
- **Studio pass:** a new token, `kind: 'scene', via: 'studio'`, issued to the studio parcel. It opens the studio routes only. The existing hand-off turns it into the 10-minute checkout link.

**Tech Stack:** Fastify, drizzle and Postgres, vitest, ethers 6 on the server, Next.js on the web with EIP-1193 `window.ethereum`. No new web dependency.

**Spec:** `docs/superpowers/specs/2026-11-04-dcl-design-studio-scene-design.md` (Part 1). Read the existing studio spec's Paying section and `apps/server/src/studio/README.md` too.

## Global Constraints

- **Network:** MANA on Polygon PoS only: chain id `137`, token `0xA1c57f48F0Deb89f569dFbE6E2B7f46D33606fD4`. Verify the token address against Decentraland's docs or Polygonscan in Task 1 before hard-coding it as the default.
- **Recipient:** `STUDIO_MANA_RECIPIENT`, with the owner's value `0x01d871870CbBddE934526E17637c0cfEf0b3b38B`.
  - It's checksum-validated at boot, and a bad value refuses to start.
  - When it's unset, MANA is off: the Pay with MANA button is hidden, and the routes answer `503 mana_unavailable`.
- **Quotes and links:** a MANA quote holds for **10 minutes**, and a late transaction still settles within a **15-minute grace** after that. A transaction needs **30 confirmations** before it settles **(plan call)**. The one-time checkout link expires after **10 minutes**.
- **No key, no browser rates:** the server never holds a private key, and never accepts a rate, amount or recipient from the browser. With no MANA/USD rate fetched in the last **5 minutes**, it refuses to quote (`503 rate_unavailable`).
- **Credit:** USD cents per account, with a ledger row for every change. It's spent in this order: gift finalizes, then credit, then card or MANA.
- **Refunds:** a mistake refund goes back the way each line was paid:
  - the card part through Stripe;
  - the MANA part and the credit part as credit, where the MANA part can be turned into a MANA-back request;
  - a gift line as a restored gift finalize, which is today's behaviour.
- **Matching:** each transaction hash settles at most one payment, ever. Two open quotes never ask for the same wei amount.
- **Studio pass:** it works on studio routes only (routes declaring `scenePass.studio`) and on `/api/auth/handoff`. It's refused everywhere else with `403 studio_pass_not_allowed`.
- **Commits:** every commit ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Run server tests with Node 22 (`source ~/.nvm/nvm.sh && nvm use 22`) and an isolated `TEST_DATABASE_URL` (for example `postgres://vlm:vlm_dev@localhost:5432/vlm_test_mana`).

## Review Focus

1. **One transaction reported for two payments,** or reported twice: exactly one payment settles, and the second report gets `409 tx_used`. Tested in Task 6.
2. **A transfer mined after its quote expired but within the grace period** settles. One mined after the grace period is recorded as unmatched for the owner and grants nothing. Tested in Task 6.
3. **A checkout abandoned while holding credit:** when it expires (Stripe's webhook, or the sweep for MANA), the credit returns exactly once, even if expiry runs twice. Tested in Task 3.
4. **A reused or old checkout link** gets `410`, and the browser falls back to normal sign-in. A studio pass never becomes a scene pass, or the reverse. Tested in Task 7.
5. **A MANA refund request after the credit was already spent** is refused (`409 credit_spent`), so credit is never paid out twice. Tested in Task 9.

---

### Task 1: Settings and schema

**Files:**
- Modify: `apps/server/src/config.ts` (beside `studioFlag`)
- Modify: `apps/server/src/db/schema.ts` (the studio payments block, around lines 1691–1785)
- Modify: `.env.example`
- Test: `apps/server/test/studio-mana-config.test.ts`, `apps/server/test/studio-schema.test.ts`

**Interfaces:**
- Produces:
  - `config.studioMana: { recipient: string | null; rpcUrl: string; token: string; chainId: 137; quoteTtlMs: 600000; graceMs: 900000; confirmations: 30 }`
  - `config.studioSceneParcel: string | null` (`STUDIO_SCENE_PARCEL`, for example `"-12,34"`)
  - `config.studioCheckoutLinkMs: 600000`
  - `manaSettingsFrom(e: Record<string, string | undefined>)`, which throws on a bad recipient. It's exported like `studioPricesFrom`.
- Produces tables (drizzle):
  - `studioCredits`: `userId` pk, `balanceCents` int (default 0), `updatedAt`.
  - `studioCreditLedger`: `id`, `userId`, `deltaCents` int, `reason` text (`hold | release | spend | refund | merge | mana_refund_request | mana_refund_declined`), `refId` text null, `createdAt`.
  - `studioPayments` gains:
    - `method` text, default `'card'` (`card | mana | credit`);
    - `creditHeldCents` int, default 0;
    - `manaAmountWei` text null, `manaUsdRate` text null, `manaTxHash` text unique null;
    - a partial unique index `studio_payments_mana_open_idx` on `manaAmountWei` where `status = 'pending'`.
  - `PaymentLine` gains `creditCents?: number`: how much of the line's charged cents credit paid.
  - `studioEntitlements` gains `method` text, default `'card'`, and `creditCents` int, default 0.
  - `studioMistakeReports` gains `creditedCents` int, default 0 (refunded as credit), and `manaCents` int, default 0 (the part that may go back as MANA).
  - `studioManaTransfers`:
    - `txHash` and `logIndex` (pk together), `fromAddress`, `amountWei` text, `blockNumber` bigint;
    - `paymentId` uuid null;
    - `status` text: `matched | unmatched | settled_by_hand | returned`;
    - `note` text null, `createdAt`.
  - `studioManaScan`: one row with id `'polygon'` and `lastBlock` bigint.
  - `studioManaRefunds`:
    - `id`, `userId`, `reportId` null, `usdCents`, `toAddress`;
    - `status`: `requested | sent | declined`;
    - `manaAmountWei` null, `txHash` unique null;
    - `createdAt`, `decidedAt`, `decidedBy`.

- [ ] **Step 1: Write failing tests.**
  - `manaSettingsFrom({})` returns `recipient: null`.
  - `manaSettingsFrom({ STUDIO_MANA_RECIPIENT: '0x01d871870cbbdde934526e17637c0cfef0b3b38b' })` returns the checksummed `0x01d871870CbBddE934526E17637c0cfEf0b3b38B`.
  - `manaSettingsFrom({ STUDIO_MANA_RECIPIENT: '0x01d871870CbBddE934526E17637c0cfEf0b3b38b' })` (bad mixed case) throws `/STUDIO_MANA_RECIPIENT/`.
  - `manaSettingsFrom({ STUDIO_MANA_RECIPIENT: 'nope' })` throws.
  - The defaults are `chainId 137`, `confirmations 30`, `quoteTtlMs 600000` and `graceMs 900000`.
  - In `studio-schema.test.ts`, inserting two `pending` payments with the same `manaAmountWei` fails with code `23505`. The same amount on one `pending` and one `expired` payment succeeds.
- [ ] **Step 2: Run the tests and confirm they fail.** Run `pnpm --filter @virvixr/server exec vitest run test/studio-mana-config.test.ts test/studio-schema.test.ts`.
- [ ] **Step 3: Implement the settings.**
  - `manaSettingsFrom` uses `getAddress` from ethers.
  - It reads `STUDIO_MANA_RECIPIENT`, `POLYGON_RPC_URL` (default `https://polygon-rpc.com`) and `STUDIO_MANA_TOKEN` (default: the token above).
- [ ] **Step 4: Implement the tables and columns** listed above.
- [ ] **Step 5: Document the new settings** in `.env.example`, commented out.
- [ ] **Step 6: Run the tests and confirm they pass.** Run them again, along with `pnpm --filter @virvixr/server typecheck`.
- [ ] **Step 7: Commit.** Message: `feat(studio): MANA, credit and studio pass settings and tables`.

### Task 2: The credit balance

**Files:**
- Create: `apps/server/src/studio/credit.ts`
- Test: `apps/server/test/studio-credit.test.ts`

**Interfaces:**
- Produces:
  - `creditBalance(userId: string, exec?: Exec): Promise<number>`
  - `addCredit(tx: Exec, userId: string, cents: number, reason: LedgerReason, refId: string | null, now: Date): Promise<void>`: upserts, adds a ledger row, and does nothing when `cents <= 0`.
  - `takeCredit(tx: Exec, userId: string, upTo: number, reason: LedgerReason, refId: string | null, now: Date): Promise<number>`: locks the row `for update`, takes `min(balance, upTo)`, records `-taken`, and returns `taken`.
  - `type LedgerReason`
- Consumes: `studioCredits`, `studioCreditLedger` (Task 1).

- [ ] **Step 1: Write failing tests.**
  - `addCredit(…, 1500, 'refund')` then `creditBalance` returns `1500`, with one ledger row of `+1500`.
  - `takeCredit(…, 2000)` on a balance of 1500 returns `1500` and leaves `0`, with a ledger row of `-1500`.
  - Two concurrent `takeCredit(…, 1000)` calls on a balance of 1500, in separate transactions, take `1000` and `500` in total. The balance never goes negative.
  - `addCredit` with 0 writes no row.
- [ ] **Step 2: Run the tests and confirm they fail.**
- [ ] **Step 3: Implement `credit.ts`.**
- [ ] **Step 4: Run the tests and confirm they pass.**
- [ ] **Step 5: Commit.** Message: `feat(studio): USD credit balance with a ledger`.

### Task 3: Credit at checkout (card), held and released like gift finalizes

**Files:**
- Modify: `apps/server/src/studio/pricing.ts` (`Quote`, a new pure `allocateCredit`)
- Modify: `apps/server/src/studio/payments.ts`: `giftsFor` gets a sibling `creditFor`; `createFinalizeCheckout`, `createTopupCheckout`, `dropPayment`, `expirePayment` and `grantPayment` change.
- Modify: `apps/server/src/routes/studio.ts` (`GET /finalize` quote)
- Test: `apps/server/test/studio-credit-checkout.test.ts`

**Interfaces:**
- Produces:
  - `allocateCredit(lines: PaymentLine[], cents: number): { lines: PaymentLine[]; usedCents: number }`. It pays lines in order: each line takes `min(remaining, chargedCents(line))` as `creditCents`, and lines with nothing charged are skipped.
  - `creditFor(userId, designId | null, now, exec?)`: the balance, plus what this user's open checkouts for this design (or open top-ups, when null) hold.
  - `Quote` gains `creditCents` (applied) and `dueCents` (`totalCents - creditCents`).
  - `GET /api/studio/designs/:id/finalize` returns them.
  - `chargedCents` doesn't change. A new `dueCentsOf(l) = chargedCents(l) - (l.creditCents ?? 0)` is what Stripe and MANA charge.

**Behaviour:**
- **Taking and holding credit:** `createFinalizeCheckout` takes credit inside its transaction, after gifts, with `takeCredit(tx, user, q.totalCents, 'hold', pay.id)`. It stores `creditHeldCents` and the allocated lines.
- **Fully covered orders:** if `dueCents === 0`, the payment gets `method 'credit'` and is granted at once, as an all-waived order is today.
- **Stripe:** Stripe line items use `dueCentsOf(l)`, and lines with 0 are left out.
- **Expired checkouts:** this design's open checkouts that hold credit are expired the same way as ones holding gifts, so their credit comes back for the new quote.
- **Releasing credit:** `dropPayment` and `expirePayment` give back `creditHeldCents` with `addCredit(…, 'release', pay.id)` in the same transaction that returns gifts, and set it to 0. Running it twice therefore returns it once.
- **Granting:** `grantPayment` writes `method` and the line's `creditCents` onto each entitlement. Once a payment is paid, its `creditHeldCents` stays as the record of what was spent.
- **Overcharges:** a grant-time overcharge on a line splits like a refund (see Task 4); the credit part goes back as credit.
- **Top-ups:** `createTopupCheckout` holds credit the same way (null design).

- [ ] **Step 1: Write failing tests.** Use `fakeStripe` and `createDesign`/`addRevision` from `test/helpers/studio.ts`.
  - **`allocateCredit` unit tests:**
    - 2000 cents over lines charging 2900 and 1900 gives `creditCents` of `2000` and `0`;
    - 4000 cents over the same lines gives `2900` and `1100`;
    - a waived line gets none.
  - **A partly covered finalize:** with a 1000-cent credit, finalizing a $29 wearable opens one Stripe line of `1900`. The balance becomes `0`. After the paid webhook, the entitlement has `creditCents 1000` and `method 'card'`.
  - **A fully covered finalize:** with a 5000-cent credit, finalizing grants at once with no Stripe session (`{ granted: true }`). The payment's `method` is `'credit'`, and the balance becomes `2100`.
  - **Expiry returns credit once:** a `checkout.session.expired` webhook returns the held 1000 cents. The same webhook again leaves the balance at 1000.
  - **A second checkout takes over the credit:** with a 1000-cent credit and a second checkout for the same design with different lines, the first session is expired through Stripe, and the new one uses the credit.
  - **Order of spending:** gifts are spent before credit. With one gift finalize and a 1000-cent credit, a design with one wearable gives a gift line and leaves the credit untouched.
  - **Top-ups:** a top-up of 1 pack with a 300-cent credit opens Stripe for `200`.
- [ ] **Step 2: Run the tests and confirm they fail.**
- [ ] **Step 3: Implement it**, following the existing `giftsHeld` code path line for line.
- [ ] **Step 4: Run the new tests and confirm they pass.** Also run `test/studio-payments.test.ts` and `test/studio-gift-codes.test.ts` to show nothing regressed.
- [ ] **Step 5: Commit.** Message: `feat(studio): spend Virvi credit at checkout`.

### Task 4: Refunds go back the way each line was paid

**Files:**
- Modify: `apps/server/src/studio/payments.ts`: `reportMistake`, `refundReport`, `approveReport`, `settleRefund`
- Test: `apps/server/test/studio-credit-refunds.test.ts`

**Interfaces:**
- Produces: `refundSplit(e: { amountCents: number; creditCents: number; method: string }): { stripeCents: number; creditCents: number; manaCents: number }`, which is pure and exported:
  - for `card`: `stripeCents = amountCents - creditCents`, with `creditCents` going back as credit;
  - for `mana`: `manaCents = amountCents - creditCents`, with all of it going back as credit;
  - for `credit`: all of it as credit.
- `reportMistake` and `approveReport` stop requiring `pay.stripePaymentIntent` unless `stripeCents > 0`. `nothing_charged` now means `amountCents === 0`.
- `refundReport` makes the Stripe refund for `stripeCents` only. The rest goes through `addCredit(tx, user, creditCents + manaCents, 'refund', reportId)` in the same transaction that marks the report `refunded`. The report stores `creditedCents` and `manaCents`.
- The response becomes `{ status: 'refunded', refundCents, creditedCents, manaCents }`.
- `settleRefund` (grant-time overcharge) on a `mana` or `credit` payment adds `refundDueCents` as credit, not through Stripe.

- [ ] **Step 1: Write failing tests.**
  - **Mixed card revision:** a card-paid $15 revision with 500 credit cents, reported, makes a Stripe refund of `1000` and gives `500` credit. The report has `creditedCents 500` and `manaCents 0`.
  - **MANA revision:** a MANA-paid revision (an entitlement with `method 'mana'`, `amountCents 1500`), reported, makes no Stripe call. The balance becomes `1500`, and the report has `manaCents 1500` and `creditedCents 1500`.
  - **Held report:** a held report on a MANA line, approved by the owner, gives the same credit result.
  - **MANA overcharge:** an overcharge found at grant time on a MANA payment gives credit, and `fakeStripe.calls.refunds` stays empty.
  - **Old payments:** pre-existing card-only payments (no `creditCents`) refund exactly as before. Run the existing `mistake reports` describe block unchanged.
- [ ] **Step 2: Run the tests and confirm they fail.**
- [ ] **Step 3: Implement it.**
- [ ] **Step 4: Run the tests and confirm they pass.** Include `test/studio-payments.test.ts` and `test/admin-studio.test.ts`.
- [ ] **Step 5: Commit.** Message: `feat(studio): refunds return to card, credit or MANA credit by how each line was paid`.

### Task 5: MANA quotes

**Files:**
- Create: `apps/server/src/studio/mana/rate.ts`, `apps/server/src/studio/mana/polygon.ts`, `apps/server/src/studio/mana/quote.ts`
- Modify: `apps/server/src/studio/payments.ts` (`createFinalizeCheckout` and `createTopupCheckout` take `method`)
- Modify: `apps/server/src/routes/studio.ts` (the bodies of `POST /finalize` and `POST /topups` accept `method: 'card' | 'mana'`, default `'card'`)
- Test: `apps/server/test/studio-mana-quote.test.ts`

**Interfaces:**
- **`rate.ts`:**
  - `type ManaRate = { usdPerMana: number; source: string; at: Date }`
  - `getManaRate(now: Date): Promise<ManaRate | null>`: null when the cached rate is older than 5 minutes and a refresh fails.
  - `setManaRateSource(fn: (() => Promise<number>) | null)`, for tests.
  - The default source is CoinGecko, `GET https://api.coingecko.com/api/v3/simple/price?ids=decentraland&vs_currencies=usd`, reading `.decentraland.usd`. It's cached for 60 seconds.
- **`polygon.ts`:**
  - An `interface PolygonReader` with:
    - `latestBlock(): Promise<number>`;
    - `receipt(txHash): Promise<{ status: 0 | 1; blockNumber: number; logs: { address: string; topics: string[]; data: string; logIndex: number }[] } | null>`;
    - `blockTime(blockNumber): Promise<Date>`;
    - `transfersTo(token, to, fromBlock, toBlock): Promise<ManaTransfer[]>`.
  - `type ManaTransfer = { txHash; logIndex; from; to; amountWei: bigint; blockNumber }`.
  - `getPolygon()` returns an ethers `JsonRpcProvider` on `config.studioMana.rpcUrl`. `setPolygon(r | null)` is for tests.
  - `parseTransfers(token, logs)`: a pure decoder of ERC-20 `Transfer(address,address,uint256)` logs.
- **`quote.ts`:**
  - `manaWeiFor(usdCents: number, usdPerMana: number, salt: bigint): bigint`. It rounds the base up to a multiple of `10n ** 12n`, then adds `salt`, where `1n <= salt < 10n ** 12n`. The low digits are left free for uniqueness, and the amount never falls below the USD price.
  - `type ManaQuote = { paymentId; amountWei: string; recipient; token; chainId: 137; usdCents; usdPerMana; expiresAt: string }`
- **Checkout with `method 'mana'`:**
  - The payment gets `method 'mana'`, `expiresAt = now + 10 min`, `manaUsdRate` and `manaAmountWei` from a random salt. On a unique-index violation (`23505`) it retries with a new salt, up to 5 times.
  - Gifts and credit are held exactly as in Task 3. Lines with nothing due are left out.
  - It returns `{ mana: ManaQuote }`, or `{ granted: true }` when nothing is due.
  - It refuses with `503 mana_unavailable` when the recipient is unset, and with `503 rate_unavailable` when `getManaRate` returns null. In both cases nothing is held or left behind.
- **Reusing an open quote:** a second MANA checkout for the same design returns the same open quote when its lines match and more than 2 minutes remain. Otherwise it expires the old one (releasing its gifts and credit) and makes a new quote.

- [ ] **Step 1: Write failing tests.**
  - **Pricing:** `manaWeiFor(2900, 0.5, 7n)` equals `58n * 10n**18n + 7n`. `manaWeiFor(2900, 0.3, 1n)` is at least `29 / 0.3` MANA, and its low 12 digits equal `000000000001`.
  - **A quote:** with a rate source returning `0.25`, finalizing a $29 wearable with `method 'mana'` returns a quote of `116` MANA plus the salt. The recipient is `0x01d871870CbBddE934526E17637c0cfEf0b3b38B`, `chainId` is 137, and `expiresAt` is 10 minutes after now.
  - **Rate down:** with the rate source throwing and no cache, the answer is `503 rate_unavailable`. No `studio_payments` row exists, and the credit is untouched. A card checkout still works.
  - **MANA off:** with the recipient unset, the answer is `503 mana_unavailable`.
  - **Distinct amounts:** two users get quotes for identically priced designs, and their `amountWei` values differ.
  - **Covered by credit:** with credit covering everything, the answer is `{ granted: true }` and no quote is made.
  - **Parsing logs:** `parseTransfers` on a hand-built `Transfer` log (topic0 `0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef`) gives back `from`, `to` and `amountWei`. A log from another contract is ignored.
- [ ] **Step 2: Run the tests and confirm they fail.**
- [ ] **Step 3: Implement `rate.ts`, `polygon.ts` and `quote.ts`, and the checkout changes.**
- [ ] **Step 4: Run the tests and confirm they pass.**
- [ ] **Step 5: Commit.** Message: `feat(studio): MANA quotes pegged to the USD price`.

### Task 6: Settling MANA payments

**Files:**
- Create: `apps/server/src/studio/mana/settle.ts`
- Modify: `apps/server/src/routes/studio.ts` (new route), `apps/server/src/studio/sweep.ts` (call the watcher)
- Test: `apps/server/test/studio-mana-settle.test.ts`, with a `fakePolygon()` added to `test/helpers/studio.ts`

**Interfaces:**
- `reportManaTx(userId: string, paymentId: string, txHash: string, now: Date): Promise<{ status: 'granted' | 'confirming' }>`. It throws `PaymentError`:
  - `404 not_found` for someone else's payment;
  - `409 tx_used` for a hash that settled another payment;
  - `409 tx_failed`, `409 tx_mismatch` (no Transfer of exactly this amount to the recipient on the MANA contract), and `409 tx_late` (mined after `expiresAt + grace`);
  - `404 tx_not_found`.
- Route: `POST /api/studio/payments/:paymentId/mana-tx` with body `{ txHash }`. The hash must match `/^0x[0-9a-fA-F]{64}$/`. It uses the `auth` preHandler and is open to the studio pass (Task 7).
- `GET /api/studio/payments/:paymentId` returns `{ status, method, expiresAt, manaTxHash }`, for the page to poll.
- `watchManaTransfers(now: Date, reader?: PolygonReader): Promise<{ matched: number; unmatched: number }>`. It's called from `sweepStudio` and errors are logged, never thrown.
  - It scans from `studioManaScan.lastBlock + 1` to `latest - confirmations`, at most 5,000 blocks per call. On the first run it starts at `latest - 2000`.
  - Each `Transfer` to the recipient is recorded once in `studioManaTransfers` (on conflict, do nothing).
  - It matches by exact amount to a `mana` payment that is `pending`, or `expired` with its block time within `expiresAt + grace`. Matched payments are granted.
  - Anything else is stored as `unmatched`.
- **Rules for reported transactions:**
  - **Confirming:** a reported transaction with fewer than 30 confirmations stores `manaTxHash` and returns `confirming`. The watcher (or a later report) grants it once it's confirmed.
  - **Claiming:** the claim is the update `set manaTxHash where manaTxHash is null`, with the unique column as the lock. A late but in-grace payment that the sweep marked `expired` is first reopened, by its gifts and credit being taken again; if the credit was spent meanwhile, it is granted with that difference recorded as `refundDueCents`, then settled as credit.
  - **Expiring:** `sweepStudio` expires a `mana` payment once `now > expiresAt + grace` with no `manaTxHash`, using the Task 3 `expirePayment`.
  - **Granting:** the grant uses `grantPayment(paymentId, null, now)` with nothing changed.

- [ ] **Step 1: Write failing tests.**
  - **Good transaction:** a confirmed transaction with the exact amount to the recipient grants. The entitlement has `method 'mana'`, and a finalize job is queued.
  - **Unconfirmed:** a transaction with 10 confirmations returns `confirming`. After the fake chain advances 30 blocks, `watchManaTransfers` grants it.
  - **Wrong amounts:** an amount 1 wei short gives `tx_mismatch`, and so does one 1 wei over. A transfer to a different address gives `tx_mismatch`. The right amount on a different token contract gives `tx_mismatch`. A reverted receipt gives `tx_failed`.
  - **Reused hash:** the same hash reported for a second payment gives `409 tx_used`. Reporting it twice for the same payment returns `granted` once, then the same result again without a second grant.
  - **Watcher only (Review Focus 2):** the page was closed after sending, so nothing was reported. The watcher finds the transfer by amount and grants.
  - **Late within grace:** a transfer mined 5 minutes after `expiresAt`, after the sweep expired the payment, still settles. The gifts and credit the expiry released are held again.
  - **Late after grace:** a transfer mined 20 minutes after expiry is stored `unmatched`, with no grant. Reporting it gives `tx_late`.
  - **Expiry:** a MANA payment with no transaction, 16 minutes after `expiresAt`, is expired by the sweep, and its held credit returns.
- [ ] **Step 2: Run the tests and confirm they fail.**
- [ ] **Step 3: Implement `settle.ts`, the routes and the sweep hook.**
- [ ] **Step 4: Run the tests and confirm they pass.** Include `test/studio-sweep.test.ts`.
- [ ] **Step 5: Commit.** Message: `feat(studio): verify and settle MANA payments on Polygon`.

### Task 7: The studio pass and the 10-minute checkout link

**Files:**
- Modify: `apps/server/src/auth/scene-from.ts` (`scenePass` config gains `studio?: true`)
- Modify: `apps/server/src/middleware/auth.ts` (`AuthUser.via` gains `'studio'`)
- Modify: `apps/server/src/auth/scene-pass.ts` (`issueStudioPass`)
- Modify: `apps/server/src/routes/auth.ts` (`/api/auth/platform`)
- Modify: `apps/server/src/routes/auth-handoff.ts`
- Modify: `apps/server/src/routes/studio.ts`: every route's options gain `config: { scenePass: { sceneFrom: () => null, studio: true } }` through one shared constant. The worker routes and render frames don't change.
- Test: `apps/server/test/studio-pass.test.ts`

**Interfaces:**
- `issueStudioPass(app, user: SessionUser, wallet: string)` returns the same shape as `issueScenePass`.
  - Claims: `{ ...sceneClaims(user, wallet, { sceneId: null, locationId: null }), via: 'studio' }`.
  - Expiry: `config.jwtAccessExpiry`, with no refresh token.
- In `/api/auth/platform`: when `config.studioSceneParcel` is set and the signed request's `signed.scene.parcel` equals it, and the request is verified and not a guest, the server resolves the user with `resolveVerifiedWalletUser(wallet, name, 'visitor')`. It replies with `{ ...issueStudioPass(...), verified: true, studio: true }`, not a scene pass.
- **Middleware (before the `kind === 'scene'` scene check):**
  - With `via === 'studio'`: a route without `scenePass.studio` gets `403 studio_pass_not_allowed`. One with it passes, and its `sceneId` check is skipped.
  - A normal scene pass on a `studio: true` route still needs its `sceneFrom` to match, and `() => null` never matches. Normal scene passes therefore stay locked out of the studio.
- **The hand-off from a studio pass:** `POST /api/auth/handoff` gains `studio: true`.
  - From a studio pass, it mints `kind 'account'`, with `expiresAt = now + config.studioCheckoutLinkMs` (10 minutes) and `passExpiresAt` null. The exchange then issues `issueWalletSession` (a full account session), which the owner accepted.
  - Codes from other passes keep the 60-second lifetime.
  - Add `studio_checkout` to the rate limiter key so it doesn't share the 5-a-minute budget with the HUD.

- [ ] **Step 1: Write failing tests.** Use the signed-fetch fixtures that `auth-platform` tests use.
  - **Issuing the pass:**
    - A signed request from parcel `"-12,34"`, with `STUDIO_SCENE_PARCEL = "-12,34"`, gets `studio: true` and a token with `via 'studio'`.
    - A guest from that parcel gets a guest token.
    - Another parcel gets a normal scene pass.
  - **What the pass opens:**
    - The studio pass can call `GET /api/studio/usage` (200) and `POST /api/studio/designs` (201). A new wallet's account is on the Free plan, so its second open design is refused as on the website.
    - It gets `403 studio_pass_not_allowed` on `PUT /api/elements/:id`, `GET /api/scenes`, `/api/admin/studio/flags` and `GET /api/auth/me`.
    - A normal scene pass gets `403 scene_pass_not_allowed` on `GET /api/studio/usage`.
  - **The link:**
    - A studio pass's `POST /api/auth/handoff` returns a code with `expiresAt` 10 minutes out. Exchanging it within 10 minutes returns an account session (`kind 'account'`, no `via`). Exchanging it again gives `410`.
    - A studio-pass code exchanged after 10 minutes and 1 second gives `410`. Use `vi.setSystemTime`.
    - A normal scene pass's code still expires after 60 seconds and still exchanges to a scene pass.
- [ ] **Step 2: Run the tests and confirm they fail.**
- [ ] **Step 3: Implement it.**
- [ ] **Step 4: Run the tests and confirm they pass.** Include `test/auth-handoff*.test.ts`, `test/hud-protocol.test.ts` and `test/studio-routes.test.ts`.
- [ ] **Step 5: Commit.** Message: `feat(studio): a studio-only pass for the Decentraland studio scene, and a 10-minute checkout link`.

### Task 8: Studio data follows the wallet when it's linked to an existing account

**Files:**
- Modify: `apps/server/src/auth/wallet-users.ts` (`absorbVisitor`)
- Create: `apps/server/src/studio/merge.ts`
- Test: `apps/server/test/studio-merge.test.ts`

**Interfaces:**
- `moveStudioData(tx: Exec, fromUserId: string, toUserId: string, now: Date): Promise<void>`. `absorbVisitor` calls it inside its transaction, before its "owns anything" check.
- **What it moves** (`userId` or `ownerId` updated to `toUserId`):
  - `studioDesigns.ownerId`, `studioPayments`, `studioEntitlements`, `studioMistakeReports`, `studioScopeEvents`, `studioFlags`, `studioManaRefunds`.
- **What it sums** (onto the target's row, then deletes the source row):
  - `studioUsageDays`, per day;
  - `studioPromptCredits`, both `balance` and `gifted`;
  - `studioFinalizeCredits`;
  - `studioCredits`, with a `merge` ledger row on each side.
- **Gift redemptions:** `studioGiftRedemptions` are moved where the target hasn't redeemed that code. Otherwise they're deleted.
- **Paused accounts:** if the source is paused, the target becomes paused too (a `studioPauses` row is copied, on conflict do nothing).
- **Shell deletion:** the visitor shell is still deleted only when nothing else references it. Since the studio rows have moved, a studio-only visitor shell is deleted.

- [ ] **Step 1: Write failing tests.**
  - **Everything moves:** a visitor shell (viewer, no email, verified wallet W) has a design, a paid entitlement, 3 prompts used today, 2 bought prompts, 1 gift finalize and 1200 credit cents. The email user E has 1 prompt used today and 300 credit cents. After `linkVerifiedWallet(E, W)` returns `'linked'`:
    - the design, entitlement and payment belong to E;
    - today's usage is 4, bought prompts 2, gift finalizes 1, and credit 1500;
    - the shell user is deleted;
    - `GET /api/studio/designs/:id/packages` as E returns 200.
  - **Open designs over the limit:** a shell with one open design, merged into a Free-plan E that also has one, leaves E with 2 open designs, and both are listed. Creating a third is refused with the open-design limit.
  - **No studio data:** a shell with no studio rows merges exactly as before. The existing wallet-link tests pass unchanged.
- [ ] **Step 2: Run the tests and confirm they fail.**
- [ ] **Step 3: Implement it.**
- [ ] **Step 4: Run the tests and confirm they pass.** Include `test/wallet*.test.ts`.
- [ ] **Step 5: Commit.** Message: `feat(studio): move studio data when a visitor's wallet joins an existing account`.

### Task 9: MANA back on request, and the owner's MANA admin

**Files:**
- Create: `apps/server/src/studio/mana/refunds.ts`
- Modify: `apps/server/src/routes/studio.ts`, `apps/server/src/routes/admin-studio.ts`
- Test: `apps/server/test/studio-mana-refunds.test.ts`

**Interfaces:**
- **The customer:** `POST /api/studio/mana-refunds` with body `{ reportId }`.
  - It's for the caller's own refunded report with `manaCents > 0` and no request yet.
  - It takes `manaCents` from the balance with `takeCredit(…, 'mana_refund_request', reportId)`. If less than `manaCents` is available, it gives `409 credit_spent` and nothing is taken (it checks first, inside the locked transaction).
  - `toAddress` is the account's verified wallet. With none, it gives `409 no_wallet`.
  - It returns `{ id, status: 'requested', usdCents }`.
- **The owner's list:** `GET /api/admin/studio/mana-refunds?status=requested` returns `{ id, user: { id, email, wallet }, usdCents, toAddress, createdAt }[]`.
- **A quote for sending:** `GET /api/admin/studio/mana-refunds/:id/quote` returns `{ amountWei, token, chainId: 137, to: toAddress, usdPerMana }` at the current rate (`manaWeiFor` with salt `0n`, rounded up), or `503 rate_unavailable`.
- **Recording a send:** `POST /api/admin/studio/mana-refunds/:id/sent` with body `{ txHash, amountWei }`.
  - The server checks with `PolygonReader.receipt` that the transaction succeeded and contains a MANA `Transfer` to `toAddress` of `amountWei`.
  - It records `sent`, `txHash`, `decidedAt` and `decidedBy`.
  - It gives `409 tx_mismatch` when the transaction doesn't match, and `409 already_decided` when the request isn't `requested`.
- **Declining:** `POST /api/admin/studio/mana-refunds/:id/decline` gives the credit back (`mana_refund_declined`) and records `declined`.
- **Payments that didn't match:**
  - `GET /api/admin/studio/mana-transfers?status=unmatched` lists unmatched transfers, each with nearby `mana` payments: same user unknown, so it shows those whose quote amount is within 5% and that were created within 24 hours.
  - `POST /api/admin/studio/mana-transfers/:txHash/:logIndex/settle` with body `{ paymentId }` grants a `pending` or `expired` mana payment by hand. It re-holds gifts and credit as in Task 6, records `settled_by_hand` and the note, and is refused when the payment is `paid`.
  - `POST /api/admin/studio/mana-transfers/:txHash/:logIndex/returned` with body `{ returnTxHash }` marks it `returned`, after the owner sent it back from their own wallet.

- [ ] **Step 1: Write failing tests.**
  - **A request:** a refunded MANA report with `manaCents 1500` and a balance of 1500 makes a request, and the balance becomes 0.
  - **Credit already spent (Review Focus 5):** a request when the balance is 400 gives `409 credit_spent`, and the balance is still 400.
  - **One request per report:** a second request for the same report gives `409`.
  - **A card report:** asking about a card-paid report gives `409 not_mana`.
  - **Sending:** the admin quote at a rate of 0.5 for 1500 cents gives `30 * 10**18` wei. A matching `sent` transaction records it. A transfer to the wrong address gives `tx_mismatch`.
  - **Declining:** a decline restores the 1500 credit, and a second decline gives `already_decided`.
  - **Admins only:** non-admins get 403 on every admin route.
  - **Settling by hand:** an unmatched transfer settled by hand against an expired payment grants it.
- [ ] **Step 2: Run the tests and confirm they fail.**
- [ ] **Step 3: Implement it.**
- [ ] **Step 4: Run the tests and confirm they pass.**
- [ ] **Step 5: Commit.** Message: `feat(studio): MANA-back requests and the owner's MANA admin`.

### Task 10: The web checkout page, with card and MANA side by side

**Files:**
- Create: `apps/web/src/lib/mana.ts`, `apps/web/src/lib/mana.test.ts`
- Create: `apps/web/src/app/(dashboard)/studio/checkout/page.tsx`, `apps/web/src/app/(dashboard)/studio/checkout/Checkout.tsx`
- Modify: `apps/web/src/lib/api.ts` (`finalizeStudio` and `buyStudioPrompts` take `method`, plus the new studio and admin calls), `apps/web/src/lib/studio.ts` (`Quote` gains `creditCents`, `dueCents`; new refusal texts)
- Modify: `apps/web/src/app/(dashboard)/studio/[designId]/Finalize.tsx` (the dialog's Pay goes to the checkout page)
- Modify: `apps/web/src/app/(dashboard)/studio/[designId]/PaidRevisions.tsx` (after a MANA refund, a "Send it back as MANA instead" button)
- Modify: `apps/web/src/lib/handoff.ts` (no change in behaviour, but it gains a test that `next=/studio/checkout?design=…` passes through `safeNextPath`)

**Interfaces:**
- **`mana.ts`:**
  - `encodeTransfer(to: string, amountWei: bigint): string`, which returns `0xa9059cbb` plus the 32-byte padded address plus the 32-byte padded amount.
  - `formatMana(wei: string): string`, for example `"116.0000…"` shown as `116.00 MANA`, with 2 decimals, rounded up.
  - `ensurePolygon(w: Eip1193Provider): Promise<void>`: `wallet_switchEthereumChain` to `0x89`. On error code `4902` it runs `wallet_addEthereumChain` with Polygon's public parameters, then switches.
  - `sendMana(w, q: ManaQuote): Promise<string>`: `eth_requestAccounts`, `ensurePolygon`, then `eth_sendTransaction` with `{ from, to: q.token, data: encodeTransfer(q.recipient, BigInt(q.amountWei)) }`. It returns the hash.
- **The checkout page `/studio/checkout`,** with `?design=<id>` and optional `&categories=a,b`, or `?topup=<packs>`:
  - **Signed in:** it relies on `(dashboard)` layout auth. The scene's link is `/auth/handoff#code=…&next=/studio/checkout?design=<id>`, so the hand-off signs the browser in first.
  - **The order:** it lists the lines, the credit applied, and what's due in USD.
  - **Pay by card:** the existing `finalizeStudio(id, { …, method: 'card' })`, then a redirect to Stripe.
  - **Pay with MANA:** shown only when the server's `manaEnabled` (from `GET /api/studio/usage`, a new `mana: boolean` field) is true and `getBrowserWallet()` is present. Without a wallet it shows "Pay with MANA needs a browser wallet like MetaMask. You can pay by card." When clicked:
    1. it requests a quote, shows the MANA amount and a 10-minute countdown;
    2. calls `sendMana`;
    3. reports the hash with `POST …/mana-tx`;
    4. polls `GET /api/studio/payments/:id` every 5 seconds until `paid`;
    5. then goes to `/studio/<id>?payment=<paymentId>` (the existing banner).
    - It shows "Waiting for Polygon confirmations…" while confirming.
    - When the quote expires before sending, "Get a new price" re-quotes.
  - **Errors:** wallet rejection (`4001`) puts the page back to idle. `tx_mismatch` and `tx_late` show "That payment didn't match this order. Contact support and we'll sort it out", with the transaction hash shown.
- **Refusal texts (`studio.ts`):**
  - `rate_unavailable`: "MANA pricing is unavailable right now. Try again in a minute, or pay by card."
  - `mana_unavailable`: "MANA payments aren't available."
  - `credit_spent`: "That credit has already been spent."
- **The credit line:** "Virvi credit" in the usage line (`usageLine`), shown as `· $15.00 credit` when the balance is above 0. `GET /api/studio/usage` gains `creditCents` and `mana`.

- [ ] **Step 1: Write failing web unit tests (`mana.test.ts`).**
  - `encodeTransfer('0x01d871870CbBddE934526E17637c0cfEf0b3b38B', 1n)` equals `'0xa9059cbb00000000000000000000000001d871870cbbdde934526e17637c0cfef0b3b38b0000000000000000000000000000000000000000000000000000000000000001'`.
  - `formatMana('116000000000000000007')` equals `'116.01 MANA'` (rounded up).
  - `ensurePolygon` with a fake provider that throws `{ code: 4902 }` on the first switch calls `wallet_addEthereumChain`, then switches.
  - `sendMana` sends `to: token` and the encoded data, and returns the hash.
  - In `studio.test.ts`: `usageLine` with `creditCents 1500` contains `$15.00 credit`, and the three refusal texts are exact.
- [ ] **Step 2: Run the tests and confirm they fail.** Run `pnpm --filter @virvixr/web test`.
- [ ] **Step 3: Implement `mana.ts`, the api and studio additions, the checkout page and the dialog change.** Also add `creditCents` and `mana` to the server's `usage()`, with a server test in `studio-routes.test.ts`.
- [ ] **Step 4: Run the tests and confirm they pass.** Run the web tests, `pnpm --filter @virvixr/web typecheck` (`rm -rf apps/web/.next` first if it fails with TS6053), and the server studio routes test.
- [ ] **Step 5: Commit.** Message: `feat(web): studio checkout page with card and MANA`.

### Task 11: The owner's MANA admin on the web

**Files:**
- Modify: `apps/web/src/app/(dashboard)/admin/studio/page.tsx` (two sections after "Mistake reports to review")
- Modify: `apps/web/src/lib/api.ts` (admin calls from Task 9)

**Behaviour:**
- **"MANA refunds to send"** lists each request with user, wallet, USD amount and date.
  - **Send:** gets the admin quote, calls `sendMana` from `mana.ts` with `{ token, recipient: to, amountWei }`, then `POST …/sent` with the hash and amount.
  - **Decline:** declines it after a typed-in confirmation in the page, not a browser `confirm()`.
- **"MANA payments that didn't match"** lists unmatched transfers, with a Polygonscan link (`https://polygonscan.com/tx/<hash>`), the sender, and the amount in MANA.
  - **Settle with payment…:** a select of the candidate payments.
  - **Mark returned:** asks for the return transaction hash.

- [ ] **Step 1: Write a failing test in `apps/web/src/lib/studio.test.ts`** for the pure helper `adminManaRows(transfers, payments)`. Each transfer gets the candidate payments within 5% of its amount, nearest first.
- [ ] **Step 2: Run it and confirm it fails.**
- [ ] **Step 3: Implement the helper and the two sections.**
- [ ] **Step 4: Run the web tests and typecheck, and confirm they pass.**
- [ ] **Step 5: Commit.** Message: `feat(web): owner's MANA refunds and unmatched payments`.

### Task 12: Docs and the full check

**Files:**
- Modify: `apps/server/src/studio/README.md`. Add a "Paying with MANA and credit" section:
  - the settings: `STUDIO_MANA_RECIPIENT`, `POLYGON_RPC_URL` (recommend a paid RPC such as Alchemy for production), `STUDIO_MANA_TOKEN` and `STUDIO_SCENE_PARCEL`;
  - the new tables, which `drizzle-kit push` creates at deploy;
  - how a MANA payment settles, the credit rules, and the owner's two admin sections.

- [ ] **Step 1: Write the README section.**
- [ ] **Step 2: Run the full server suite.** Run `pnpm --filter @virvixr/server test` with an isolated `TEST_DATABASE_URL`. It should be all green, and the count should be the previous count plus this plan's tests.
- [ ] **Step 3: Run the web tests and typecheck, and the server typecheck.** All should be green.
- [ ] **Step 4: Commit.** Message: `docs(studio): MANA, credit and the studio pass`.
