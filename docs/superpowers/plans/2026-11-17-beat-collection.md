# BEAT collection (LIV-185) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Collected tab on `virvi.io/beats` showing every BEAT held by the account's linked wallets, and a public page `virvi.io/w/<address>` for one wallet's BEATs, each marked Earned or Held.

**Architecture:** The server indexes the BEAT contracts' `TransferSingle`/`TransferBatch` logs (at the chain's confirmation depth) into a `beat_holdings` table, driven by the existing BEAT job. Two read endpoints join holdings with `beats` (metadata) and `beat_claims` (Earned). The website adds a Collected tab (medal grid + filters) to `/beats` and a static-export dynamic page `/w/_` served for `/w/:address`.

**Tech Stack:** Fastify + Drizzle/Postgres (apps/server), ethers v6 JsonRpcProvider, Next.js static export + Tailwind (apps/web), vitest everywhere, shared types in packages/shared.

**Spec:** docs/superpowers/specs/2026-11-17-beat-collection-design.md (read it, especially "Anti-goals" and "Settled after the builder check").

## Global Constraints

- Node 22 for every command: `export PATH=/opt/homebrew/opt/node@22/bin:$PATH`.
- Server tests share one Postgres test database: run test files **one vitest process at a time** (never two in parallel).
- New tables go in `apps/server/src/db/schema.ts` **and** as idempotent `CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS` in the BEAT block of `apps/server/entrypoint.sh` (next to `beat_reissue_requests`, ~line 526); `test/entrypoint-fallback-beats.test.ts` checks that block.
- Addresses are stored lowercase; shown checksummed (`getAddress`).
- Only the configured chain (`config.beats.chain`); Amoy BEATs never appear when the chain is `polygon`.
- The public endpoint and page contain nothing account-related: no user ids, names, emails, other wallets, claim times of unlinked claims.
- Copy: plain sentences, "BEAT"/"BEATs", "Earned", "Held", "Tradeable". No marketing words.
- Commits end with the session's Co-Authored-By / Claude-Session lines; message prefix `feat(beats): … (LIV-185)`.

## Review Focus

1. Mixed-case or checksummed addresses in URLs and logs must match the same lowercase rows (test in Task 1 and Task 2).
2. A free RPC refuses `eth_getLogs` over more than 10,000 blocks: the indexer must page in chunks of at most 2,000 (test in Task 1).
3. A reissue (old wallet → new wallet) and a sale must move the balance: old wallet 0 and gone from its page, new wallet 1 (test in Task 1 and Task 2).
4. A wallet holding a BEAT whose `beats` row is on Amoy while the chain is polygon, or a token with no `beats` row, shows nothing (test in Task 2).
5. An invalid address on the public endpoint is 404, a valid empty one is 200 `{ beats: [] }` with the same shape as a full one (test in Task 2).

---

### Task 1: Holdings index (server)

**Files:**
- Modify: `apps/server/src/db/schema.ts` (after `beatClaims`), `apps/server/entrypoint.sh` (BEAT block), `apps/server/src/beats/job.ts` (`startBeatJobs`)
- Create: `apps/server/src/beats/holdings.ts`
- Test: `apps/server/test/beat-holdings.test.ts`, extend `apps/server/test/entrypoint-fallback-beats.test.ts`

**Interfaces:**
- Produces tables:
  - `beat_holdings(chain text, contract text, token_id bigint, wallet text, balance numeric not null, updated_block bigint not null, primary key (chain, contract, token_id, wallet))`, index on `(chain, wallet)`. Rows with balance 0 are deleted.
  - `beat_index_cursors(chain text, contract text, last_block bigint not null, updated_at timestamptz not null default now(), primary key (chain, contract))`.
- Produces in `holdings.ts`:
  - `type BeatTransfer = { contract: string; tokenId: bigint; from: string; to: string; value: bigint; blockNumber: number }`
  - `interface BeatLogReader { latestBlock(): Promise<number>; transfers(contract: string, fromBlock: number, toBlock: number): Promise<BeatTransfer[]>; txBlock(hash: string): Promise<number | null> }`
  - `rpcLogReader(provider: JsonRpcProvider): BeatLogReader` (decodes TransferSingle and TransferBatch via `beatInterface`; batch → one BeatTransfer per id)
  - `applyTransfers(chain: BeatChain, transfers: BeatTransfer[]): Promise<void>` (one transaction; zero address is never a holder; subtract from `from`, add to `to`)
  - `indexBeatHoldings(chain: BeatChain, reader: BeatLogReader): Promise<{ contracts: number; transfers: number; toBlock: number | null }>`
  - `INDEX_CHUNK_BLOCKS = 2000`
- Indexed contracts: distinct `beats.contract_address` for the chain where `token_id is not null`. A contract's first run starts at `txBlock` of its earliest `created_on_chain_tx`; if that's null, skip the contract this round. Each run reads `(cursor+1) … min(cursor + INDEX_CHUNK_BLOCKS, latest − BEAT_CHAIN_INFO[chain].confirmations)`, applies, advances the cursor in the same transaction; loops chunks until caught up or 20 chunks done.

- [ ] **Step 1: Write failing tests** in `test/beat-holdings.test.ts` with a fake `BeatLogReader` (an array of transfers, a settable latest block, `txBlock` returning 100):
  - `a mint then a transfer leaves the buyer with 1 and the seller with no row` — transfers `0x0→A (token 7, 1)` at 105 and `A→B (token 7, 1)` at 110, latest 200; after `indexBeatHoldings('polygon', reader)` holdings for A: none, B: balance 1; addresses lowercase.
  - `only reads up to latest minus confirmations and pages in 2000-block chunks` — latest 100 + 30 + 5000; assert every `transfers()` call has `toBlock - fromBlock < 2000` and the last `toBlock` is `latest - 30`; a transfer at `latest - 10` is not applied.
  - `the cursor makes a second run read only new blocks` — run twice; second run's first `fromBlock` is previous `toBlock + 1`; balances not doubled.
  - `a batch transfer moves every id`.
  - `checksummed addresses in logs land on the lowercase row`.
  - `a contract whose create tx block is unknown is skipped, not indexed from 0`.
  - Seed a `beats` row (`chain 'polygon'`, `contractAddress`, `tokenId 7`, `createdOnChainTx '0xabc'`) like `test/beat-visitor.test.ts`'s `seed()`.
- [ ] **Step 2: Run** `cd apps/server && npx vitest run test/beat-holdings.test.ts` — expect FAIL (module not found).
- [ ] **Step 3: Implement** the schema, `holdings.ts`, and the entrypoint SQL (add a test case in `entrypoint-fallback-beats.test.ts` asserting both `CREATE TABLE IF NOT EXISTS beat_holdings` and `beat_index_cursors` appear in the BEAT block). In `startBeatJobs`, run `indexBeatHoldings(config.beats.chain, rpcLogReader(provider))` after each `runBeatTick` (same `running` guard, its own try/catch logging `[beats] holdings index failed:`), using the chain's RPC URL from config (the same one `beatChainClient` uses); skip when the chain has no RPC URL.
- [ ] **Step 4: Run** the test file, `test/entrypoint-fallback-beats.test.ts`, `test/beat-job.test.ts`, then `npx tsc --noEmit -p .` — all pass.
- [ ] **Step 5: Commit** `feat(beats): index who holds each BEAT from the contract's transfer logs (LIV-185)`.

### Task 2: Collection API (server + shared types)

**Files:**
- Modify: `packages/shared/src/beats.ts` (types), `apps/server/src/beats/routes.ts`
- Create: `apps/server/src/beats/collection.ts`
- Test: `apps/server/test/beat-collection.test.ts`

**Interfaces:**
- Consumes: `beat_holdings` (Task 1).
- Produces in `packages/shared/src/beats.ts`:
  ```ts
  export type BeatKind = 'basic' | 'custom'
  export interface CollectedBeat {
    tokenId: string; contract: string; chain: BeatChain; kind: BeatKind
    wallet: string            // checksummed holder
    quantity: number
    earned: boolean
    name: string; imageUrl: string | null; place: string | null
    startsAt: string; endsAt: string; tradeable: boolean
    tokenUrl: string          // beatTokenUrl(...)
    mintTxUrl: string | null  // only when earned
    claimedAt: string | null  // only when earned and the claim isn't unlinked; never on the public endpoint
  }
  export interface BeatCollection { wallets: string[]; beats: CollectedBeat[] }   // signed-in
  export interface WalletBeats { wallet: string; beats: CollectedBeat[] }          // public
  ```
- Produces in `collection.ts`: `collectionFor(wallets: string[], opts: { includeClaimTimes: boolean }): Promise<CollectedBeat[]>` (newest `startsAt` first); `kind` is `'basic'` for every contract Virvi uses as its shared contract (all of today's), `place` is what the token metadata's "Where" uses (reuse the helper in `beats/metadata.ts`).
- Routes:
  - `GET /api/beats/collection` (signed-in, not a scene pass or trial): `{ wallets, beats }` for the account's wallet auth methods (`user_auth_methods.type = 'wallet'`), `includeClaimTimes: true`.
  - `GET /api/wallets/:address/beats` (public, `config: { rateLimit: { max: 60, timeWindow: '1 minute' } }`, header `cache-control: public, max-age=60`): `{ wallet, beats }` with `includeClaimTimes: false`; 404 `{ error: 'not_found' }` when the address isn't a valid EVM address. Must work with BEATs disabled-for-hosts; only refuse when `config.beats.enabled` is false (as other BEAT routes do).

- [ ] **Step 1: Write failing tests** in `test/beat-collection.test.ts` (seed beats, holdings rows directly, claims):
  - `the signed-in collection lists every linked wallet's BEATs with the holder, Earned or Held, newest first`.
  - `Earned needs a minted claim by that same wallet; a bought BEAT is Held` (claim on wallet A, holding on B → B's tile `earned: false`).
  - `a reissued claim is Earned for the new wallet`.
  - `an unlinked minted claim is still Earned but has no claimedAt`.
  - `Amoy BEATs and tokens without a beats row never show on polygon`.
  - `the public page: mixed-case address works, an invalid one is 404, an empty wallet is 200 with beats [] and the same keys as a full one` — assert `Object.keys(body).sort()` equal for both; assert the JSON string contains no `userId`, no account email, no other linked wallet, and every `claimedAt` is null.
  - `the public response is cacheable and rate limited` (cache-control header present).
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement** types, `collection.ts`, routes.
- [ ] **Step 4: Run** this file, `test/beat-visitor.test.ts`, `test/beat-metadata.test.ts`, `npx tsc --noEmit -p .` in apps/server and packages/shared — pass.
- [ ] **Step 5: Commit** `feat(beats): collection endpoints for your wallets and a public one per wallet (LIV-185)`.

### Task 3: Collected tab (web)

**Files:**
- Modify: `apps/web/src/lib/api.ts` (`getBeatCollection()`, `getWalletBeats(address)`), `apps/web/src/lib/beats.ts`, `apps/web/src/app/(dashboard)/beats/page.tsx`
- Create: `apps/web/src/components/beats/BeatMedal.tsx`, `apps/web/src/components/beats/CollectedBeats.tsx`
- Test: `apps/web/src/lib/beats.test.ts`

**Interfaces:**
- Consumes: `BeatCollection`, `CollectedBeat`, `BeatKind` (Task 2).
- Produces in `lib/beats.ts`:
  - `type CollectedFilter = { wallet: string | 'all'; from: string | null; to: string | null; kind: BeatKind | 'all'; earnedOnly: boolean }` (`from`/`to` are `YYYY-MM-DD`, inclusive, compared on `startsAt` in UTC)
  - `filterCollected(items: CollectedBeat[], f: CollectedFilter): CollectedBeat[]`
  - `shortWallet(a: string): string` → `0x1234…abcd` (reuse an existing helper if `lib/beats.ts` has one)
  - `walletPageHref(address: string): string` → `/w/<checksummed>`
- Produces `BeatMedal({ beat, showWallet }: { beat: CollectedBeat; showWallet: boolean })`: round image (circle, accent ring) with name, place and date, an **Earned** (accent) or **Held** (neutral) tag, `×N` when quantity > 1, "Tradeable" when tradeable, wallet line when `showWallet`; click opens a small detail panel (metadata, Polygonscan token link, mint tx link and claim time when present). Task 4 reuses it.

- [ ] **Step 1: Write failing tests** for `filterCollected` (each filter alone, combined, inclusive date ends, `kind: 'custom'` returns none today), `shortWallet`, `walletPageHref` (lowercase input → checksummed path).
- [ ] **Step 2: Run** `cd apps/web && npx vitest run src/lib/beats.test.ts` — FAIL.
- [ ] **Step 3: Implement.** `/beats` (no `?id=`) for a signed-in user shows tabs **Collected** (default) and **Hosting** (today's list, unchanged), tab in the URL as `?tab=hosting` so it survives reloads. Collected: filters row (wallet select with "All wallets" and each wallet, a "Share" link to its `walletPageHref`; From/To date inputs; Kind select All/Basic/Custom; Earned only checkbox), then the medal grid, or an empty state: no wallets linked → "Sign in with a wallet to collect BEATs"; none held → "No BEATs yet. Go to an event with a BEAT and claim it.". Hosting rows keep their current look (no medals there). Phone width: grid wraps, filters wrap.
- [ ] **Step 4: Run** web tests, `npx tsc --noEmit -p .`; then run `NEXT_PUBLIC_API_URL=https://api.virvi.io npx next dev -p 3999` only if a controller asks for a visual check.
- [ ] **Step 5: Commit** `feat(beats): a Collected tab of the BEATs your wallets hold (LIV-185)`.

### Task 4: Public wallet page (web + server route)

**Files:**
- Create: `apps/web/src/app/w/[address]/page.tsx` (`generateStaticParams` → `[{ address: '_' }]`, like `app/u/[code]/page.tsx`), `apps/web/src/app/w/[address]/client.tsx`
- Modify: `apps/server/src/app.ts` (next to the `/u/:code` routes ~line 418: `/w/:address` and `/w/:address/` → `w/_/index.html`)
- Test: `apps/web/src/lib/beats.test.ts` (address parsing), `apps/server/test/` existing static-route test if one covers `/u/:code` (extend it), else a new `test/wallet-page-route.test.ts`

**Interfaces:**
- Consumes: `getWalletBeats(address)` (Task 3), `BeatMedal`, `filterCollected`, `shortWallet` (Task 3).
- Produces in `lib/beats.ts`: `walletFromPath(pathname: string): string | null` — the checksummed address from `/w/<address>` or `/w/<address>/`, null when invalid.

- [ ] **Step 1: Write failing tests:** `walletFromPath` (lowercase, checksummed, trailing slash, invalid → null, `/w/_` → null); the server route serves `w/_/index.html` for `/w/0xAbc…` (mirror how `/u/:code` is tested, if it is).
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement.** Page (no sign-in, same public look as `/transparency`): "← Back to Virvi", header with the short address (copy button, Polygonscan address link via `beatAddressUrl`), "N BEATs · M earned", date from/to and Earned-only filters, the medal grid without wallet lines, newest first. States: loading; invalid address → "That isn't a wallet address." with a link to `/beats`; empty → "This wallet doesn't hold any BEATs yet." with a link to `/beats`; error → "Couldn't load this wallet's BEATs. Try again." Set `document.title` to `BEATs held by 0x1234…abcd`. (Per-address share previews aren't possible in a static export: the page's built-in title and description stay generic, "BEATs held by a wallet". Noted as a known limit, not a task.)
- [ ] **Step 4: Run** web tests + typecheck, server route test.
- [ ] **Step 5: Commit** `feat(beats): a public page of the BEATs a wallet holds (LIV-185)`.
