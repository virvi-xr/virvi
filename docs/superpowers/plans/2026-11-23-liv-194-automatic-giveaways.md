# Automatic Wearable Giveaways (LIV-194) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Visitors claim a giveaway's wearables in a scene, and Virvi mints them to the visitor's wallet. It mints from a per-giveaway wallet that the host made a minter on their Decentraland collection. Gas comes from the host (free plan) or from a Virvi gas tank (paid plans).

**Architecture:** A new `apps/server/src/giveaways/` module, modelled on `apps/server/src/beats/`:
- `keys.ts`: encrypted per-giveaway keys;
- `chain.ts`: the Decentraland collection client;
- `host.ts`: host service;
- `visitor.ts`: visitor service;
- `job.ts`: minting, top-up and return job;
- `routes.ts`.

The old `routes/giveaways.ts` is replaced. In the scene, a giveaway card mirrors the BEAT card (`packages/adapter-dcl/src/beat/`). The Drops page is rewritten around the new API.

**Tech Stack:** TypeScript, Fastify, Drizzle (push, plus entrypoint fallback SQL), ethers v6, vitest, foundry/anvil for the contract test, Next.js static export (web), Decentraland SDK7 React-ECS (adapter-dcl).

**Spec:** `docs/superpowers/specs/2026-11-22-liv-194-automatic-giveaways-design.md`. Read it fully, including "Settled after the builder check".

## Global Constraints

- **Privacy:**
  - Never log a wallet, a display name, a private key, `GIVEAWAY_WALLET_SECRET`, `GIVEAWAY_GAS_KEY` or calldata. Logs carry giveaway ids, tx ids and counts only (same rule as `beats/job.ts`).
  - No route ever returns a private key or the encrypted key column.
- **Wallets shown to hosts** are short (`0x1234…abcd`). Reuse the existing short-wallet helper; find it with `grep -rn "shortWallet" apps/server/src packages/shared/src`.
- **Chains:** `polygon` and `polygon-amoy` only. Creating an Amoy giveaway is Virvi-admin only (use `isVirviAdmin`).
- **Collection calls:**
  - Minting is `issueTokens(address[] beneficiaries, uint256[] itemIds)` on the item's collection contract. One claim puts the visitor's wallet once per item.
  - A batch only contains items from one collection contract. A giveaway's items may span contracts, so a claim becomes one `issueTokens` per contract. All of a claim's calls must confirm before it is `sent`.
- **Who decides funding:** the giveaway's `ownerId` user. "Paid" means:
  - an active subscription on a paid tier, decided exactly as `assistant/access.ts` does (`getSubscription`, `PAID_TIERS`, status `active`);
  - or a Virvi admin;
  - or billing disabled (`!config.billingEnabled`, self-hosted).
- **Owner only:** the gas tank never sends to a giveaway whose owner isn't paid at that moment.
- **Accounting:** `withdrawable = max(0, balance − virviUnspent)`, where `virviUnspent = max(0, topUps − coveredGas)`.
  - All amounts are in wei, as `numeric(78,0)` columns, read as bigint.
  - A mint transaction is `covered` when the owner was paid at signing AND the giveaway has had at least one confirmed top-up.
- **Keys:**
  - AES-256-GCM under `GIVEAWAY_WALLET_SECRET`, a 32-byte hex string. Format `v1:<iv b64>:<tag b64>:<ciphertext b64>`.
  - Without the secret, automatic giveaways are off: `config.giveaways.enabled === false`. The server starts normally.
- **Gas tank:** `GIVEAWAY_GAS_KEY` is optional. Without it, paid owners fund their own wallet and the page notes it.
- **New env vars:** only `GIVEAWAY_WALLET_SECRET`, `GIVEAWAY_GAS_KEY`, `GIVEAWAY_GAS_TANK_MIN_POL` and `GIVEAWAY_JOB_EVERY_MS`. All of them go in `docs/` environment-variables page and in `.railway/railway.ts` with `preserve()`.
- **Schema:**
  - Every new table and column goes in `apps/server/src/db/schema.ts` AND in the entrypoint fallback SQL (`apps/server/entrypoint.sh`), matched by a fallback test like `test/entrypoint-fallback-beats.test.ts`.
  - The old `giveaway_claims` table is renamed to `giveaway_claims_legacy` in `scripts/pre-push-upgrade.mjs` when it lacks a `consent_version` column. It is never dropped.
- **User-facing copy** is plain, sentence case, and says "giveaway" (the product name is Drops). Visitor card strings are fixed in Task 7.
- **Breaking changes to giveaways are fine** (no users yet), but `event_giveaway_links` stays as it is.
- **Tests:**
  - Node 22: `export PATH=~/.nvm/versions/node/v22.23.3/bin:$PATH`.
  - Server tests use a private DB: `TEST_DATABASE_URL=postgres://vlm:vlm_dev@localhost:5432/vlm_test_liv194`.
  - Run single files with `pnpm --filter virvi-server exec vitest run test/<file>`. Check the package name in `apps/server/package.json`.

## Review Focus

1. **Two claims racing past the remaining supply or the cap.** Claims are counted under a row lock (`SELECT … FOR UPDATE` on the giveaway, like `lockBeat`), so the last unit is taken once. Test in Task 5.
2. **The process crashes between signing and broadcast, or the RPC loses the hash.** The tx row is written with `raw_tx` before broadcast and re-broadcast on the next tick, so no claim is minted twice and no nonce is skipped. Test in Task 6.
3. **The host removes the minter while claims are queued.** The giveaway pauses as `not_minter`, queued claims stay `waiting`, and they mint after the minter is re-added. Test in Task 6.
4. **The owner's plan lapses mid-giveaway.** No more top-ups, later mints are uncovered, and withdrawable grows only by what the host deposited. Test in Task 4 (accounting) and Task 6 (no top-up).
5. **Send-back to a wallet that isn't the owner's.** Refused unless it's in `verifiedWalletsOf(ownerId)`. Test in Task 4.

---

### Task 1: Shared types, config, schema

**Files:**
- Create: `packages/shared/src/giveaways.ts`, and export it from `packages/shared/src/index.ts`
- Modify: `apps/server/src/config.ts`, `apps/server/src/db/schema.ts`, `apps/server/entrypoint.sh`, `apps/server/scripts/pre-push-upgrade.mjs`
- Test: `apps/server/test/giveaway-config.test.ts`, `apps/server/test/entrypoint-fallback-giveaways.test.ts`, `packages/shared` test next to `beats-shared.test.ts` (in `apps/server/test/giveaways-shared.test.ts`)

**Interfaces:**
- Produces, in `@virvixr/shared`:
  - `GIVEAWAY_CHAINS = ['polygon', 'polygon-amoy'] as const`, `type GiveawayChain`.
  - `GIVEAWAY_CONSENT_VERSION = 1`.
  - `GIVEAWAY_CLAIM_STATUSES = ['present', 'waiting', 'minting', 'sent', 'failed'] as const`, `type GiveawayClaimStatus`. `present` means consented and earning minutes; `waiting` means claimed and queued.
  - `GIVEAWAY_PAUSE_REASONS = ['low_gas', 'not_minter', 'not_approved', 'rpc_down'] as const`, `type GiveawayPauseReason`.
  - `GIVEAWAY_FAIL_REASONS = ['sold_out', 'reverted', 'ended'] as const`.
  - `GIVEAWAY_GAS_PER_ITEM = 120_000n`: the estimate per minted token, used for "claims covered".
  - `GIVEAWAY_MAX_CLAIMS_PER_TX = 40`.
  - `GIVEAWAY_JOB_EVERY_MS_DEFAULT = 15_000`.
  - `giveawayTxUrl(chain, hash)`: Polygonscan or Amoy Polygonscan, like `beatTxUrl`.
  - `giveawayMarketplaceApi(chain)`: `https://marketplace-api.decentraland.org` or `https://marketplace-api.decentraland.zone`.
  - `giveawayBuilderUrl(chain, contract)`: `https://decentraland.org/builder/collections/…` or `.zone`. Look up the Builder collection URL shape from the Builder site; if it can't be confirmed, link `https://decentraland.org/builder/collections`.
  - Types:
    - `VisitorGiveaway = { id; name; items: {name; thumbnail: string|null; rarity: string|null}[]; endsAt: string|null; minPresentSeconds: number; test: boolean; claim: null | { status: GiveawayClaimStatus; secondsPresent: number; txUrl: string|null; failReason: string|null } }`
    - `HostGiveaway`: every host-visible field from Task 4's `hostView`.
- Produces, `config.giveaways`:
  - `{ enabled: boolean; walletSecret: Buffer|null; gasKey: string|null; tankMinWei: bigint; jobEveryMs: number; rpc: Record<GiveawayChain,string> }`.
  - `rpc` reuses `config.beats.rpc` values (same env vars).
  - `tankMinWei` defaults to 5 POL on polygon. Make it per chain if simple; Amoy defaults to 0.05.
  - A bad `GIVEAWAY_WALLET_SECRET` (not 64 hex characters) or `GIVEAWAY_GAS_KEY` throws at startup. Use `validDeployKey` for the gas key.
- Produces, tables in `schema.ts`:
  - `giveaways`, adding: `chain text not null default 'polygon'`, `walletAddress text`, `walletKeyEnc text`, `startsAt`, `endsAt` (timestamptz, nullable), `claimCap integer` (nullable), `minPresentSeconds integer not null default 0`, `pausedReason text`, `pausedAt timestamptz`, `deletedAt timestamptz`, `deleteState text` (null | `'returning'`).
    - Keep `enabled`. Change the `enabled` default to `false`.
    - Drop `claimLimit` from schema.ts, and leave the DB column alone: push may drop it, and it holds nothing.
  - `giveawayItems`, adding: `itemId text`, `rarity text`, `mintState text` (last `mintCheck` state), `remaining integer` (last read supply left) and `checkedAt timestamptz`. `contractAddress` is stored checksummed. Keep `tokenId` and `metadata` columns, unused. `mintCheck` (Task 4) writes the three cache columns every time it runs.
  - `giveawayScenes`: (`giveawayId`, `sceneId`), PK both, cascade, index on `sceneId`. Same shape as `beatScenes`.
  - `giveawayClaims`, redefined: `id`, `giveawayId` (cascade), `userId uuid → users set null`, `wallet text not null`, `consentVersion int not null`, `consentedAt`, `secondsPresent int default 0`, `lastSeenAt`, `status text default 'present'`, `failReason`, `claimedAt`, `sentAt`, `createdAt`.
    - Unique (`giveawayId`, `wallet`) and partial unique (`giveawayId`, `userId`) where `userId` is not null.
  - `giveawayClaimMints`: (`claimId`, `contractAddress`), status per contract (`waiting`|`minting`|`sent`|`failed`), `txId → giveawayTxs set null`, `tokenIds text[]`. PK both.
  - `giveawayTxs`:
    - Identity and kind: `id`, `giveawayId` (set null), `chain`, `kind` (`mint`|`topup`|`withdraw`|`return`), `fromAddress`, `toAddress`, `contractAddress` (mint only).
    - Transaction: `nonce bigint`, `rawTx`, `txHash`, `txHashes text[] default '{}'`, `status` (`sending`|`sent`|`confirmed`|`failed`), `valueWei numeric(78,0) default 0`, `feeWei numeric(78,0)` (from the receipt), `covered boolean default false`.
    - Retries and times: `attempts`, `lastError`, `sentAt`, `confirmedAt`, `nextAttemptAt`, `createdAt`.
    - Index (`fromAddress`, `status`).
  - Relations for the new tables.

- [ ] **Step 1: Write failing tests.**
  - `giveaway-config.test.ts`:
    - `giveawaysFrom({})` gives `enabled: false`;
    - a 64-hex secret gives `enabled: true` and a 32-byte Buffer;
    - `GIVEAWAY_WALLET_SECRET='abc'` throws `/GIVEAWAY_WALLET_SECRET must be 64 hex/`;
    - a bad gas key throws `/GIVEAWAY_GAS_KEY/`.

    Export the parser as `giveawaysFrom(env)`, like `beatsFrom` if one exists; check config.ts for the BEAT parser's name.
  - `entrypoint-fallback-giveaways.test.ts`: copy the approach of `entrypoint-fallback-beats.test.ts` for the new tables and columns.
  - `giveaways-shared.test.ts`:
    - `giveawayTxUrl('polygon','0xab')` is `'https://polygonscan.com/tx/0xab'`;
    - the Amoy one is `'https://amoy.polygonscan.com/tx/0xab'`;
    - the marketplace API per chain.
- [ ] **Step 2: Run them, expect FAIL.**
- [ ] **Step 3: Implement the shared module, config and schema.**
  - Add fallback SQL in entrypoint.sh beside the BEAT tables: `CREATE TABLE IF NOT EXISTS …`, `ALTER TABLE giveaways ADD COLUMN IF NOT EXISTS …`.
  - Add the legacy rename to pre-push-upgrade.mjs: if `giveaway_claims` exists without `consent_version`, `ALTER TABLE giveaway_claims RENAME TO giveaway_claims_legacy`.
- [ ] **Step 4: Run the tests, then `pnpm --filter @virvixr/shared build` and server `tsc --noEmit`, expect PASS.** Fix compile errors in the old `routes/giveaways.ts` minimally; Task 4 replaces it.
- [ ] **Step 5: Commit** `feat(giveaways): shared types, config and schema (LIV-194)`.

### Task 2: Giveaway wallet keys

**Files:**
- Create: `apps/server/src/giveaways/keys.ts`
- Test: `apps/server/test/giveaway-keys.test.ts`

**Interfaces:**
- Produces:
  - `newGiveawayWallet(): { address: string; keyEnc: string }`: a random ethers Wallet; address checksummed.
  - `giveawaySigner(keyEnc: string, provider?: Provider): Wallet`: decrypts; throws `GiveawayError(500,'key_unreadable', 'This giveaway wallet can't be used.')` on a bad tag. The message never includes key material.
  - `class GiveawayError extends Error { status; code; details? }`, in `apps/server/src/giveaways/errors.ts`, same shape as `BeatError`.
- Consumes: `config.giveaways.walletSecret`. It throws when null; callers check `enabled` first.

- [ ] **Step 1: Failing tests.**
  - Round trip: `giveawaySigner(newGiveawayWallet().keyEnc).address` equals the address.
  - Two wallets differ.
  - `keyEnc` starts with `v1:` and doesn't contain the hex key.
  - A tampered ciphertext throws code `key_unreadable`.
  - A different secret (override config in the test) can't decrypt.
- [ ] **Step 2: Run, FAIL.**
- [ ] **Step 3: Implement.** Use AES-256-GCM, 12-byte iv, as in `hyperfy/hosting.ts`.
- [ ] **Step 4: Run, PASS.**
- [ ] **Step 5: Commit.**

### Task 3: Collection chain client and test contract

**Files:**
- Create:
  - `contracts/src/test/MockDclCollection.sol`: a minimal ERC721CollectionV2 look-alike, test only;
  - `apps/server/src/giveaways/abi.ts`;
  - `apps/server/src/giveaways/chain.ts`.
- Test: `apps/server/test/giveaway-chain.test.ts` (fake provider), `apps/server/test/giveaway-chain-anvil.test.ts` (skipIf no anvil or artifact, like `beat-chain-anvil.test.ts`)

**Mock contract.** Matches the real collection's signatures:
- `creator()`, `isApproved()`, `isCompleted()`, `globalMinters(address) → bool`, `itemMinters(uint256,address) → uint256`;
- `items(uint256) → (string rarity, uint256 maxSupply, uint256 totalSupply, uint256 price, address beneficiary, string metadata, string contentHash)`;
- `setMinters(address[],bool[])` and `setItemsMinters(uint256[],address[],uint256[])`, creator only;
- `setApproved(bool)` and `addItem(maxSupply)`, test helpers;
- `issueTokens(address[] _beneficiaries, uint256[] _itemIds)`:
  - requires approved and completed;
  - requires the caller to be the creator, a global minter, or hold an item allowance > 0 (decrements unless it's `type(uint256).max`);
  - requires `totalSupply < maxSupply`;
  - emits `Issue(address indexed _beneficiary, uint256 indexed _tokenId, uint256 indexed _itemId, uint256 _issuedId, address _caller)`, with `tokenId = itemId << 216 | issuedId`.

Revert messages copy the real contract's strings: `"issueToken: CALLER_CAN_NOT_MINT"`, `"_issueToken: ITEM_EXHAUSTED"`, `"issueTokens: MINT_NOT_ALLOWED"`. Check the real ones in decentraland/wearables-contracts `ERC721BaseCollectionV2.sol` and use them verbatim.

**Interfaces:**
- Produces `createGiveawayChainClient(chain: GiveawayChain, rpcUrl?: string): GiveawayChainClient` and a cached `giveawayChainClient(chain)`. The client offers:
  - `balanceWei(address): Promise<bigint>`
  - `nonce(address, tag): Promise<number>`
  - `feeData(): Promise<{maxFeePerGas; maxPriorityFeePerGas; baseFeePerGas|null}>`
  - `itemState(contract, itemId, minter): Promise<{ approved: boolean; completed: boolean; canMint: boolean; remaining: bigint; rarity: string }>`. `canMint` is global minter, or item allowance > 0.
  - `signMint(signer: Wallet, contract, wallets: string[], itemIds: string[], nonce, fees?, gasLimit?): Promise<{raw; hash; gasLimit; fees}>`. Estimates gas and adds 20% when no gasLimit is given.
  - `signTransfer(signer, to, valueWei, nonce, fees?): Promise<{raw; hash; fees}>`, with gasLimit 21000.
  - `broadcast(raw): Promise<void>`. "Already known" and "nonce too low with this hash on chain" count as success, as in `beats/chain.ts`.
  - `receipt(hash): Promise<{ ok; blockNumber; feeWei: bigint; issues: {beneficiary; tokenId: string; itemId: string}[] } | null>`
  - `latestBlock(): Promise<number>`
  - `revertReason(e): 'not_minter' | 'sold_out' | 'not_approved' | null`. Maps the revert strings above.
- Errors never carry calldata or RPC payloads. Reuse `beats/chain.ts`'s error-sanitising approach; import its helpers if exported, otherwise copy the pattern.

- [ ] **Step 1: Write the mock contract and `forge build`** (`cd contracts && forge build`). The artifact goes to `contracts/out/MockDclCollection.sol/MockDclCollection.json`.
- [ ] **Step 2: Failing tests.**
  - **Fake provider:** `revertReason` maps each string. A receipt's Issue logs parse into beneficiaries and item ids.
  - **Anvil:**
    1. Deploy the mock and add an item with maxSupply 2.
    2. `itemState` before minters: `canMint: false`.
    3. After `setMinters([giveaway],[true])`: `canMint: true`, `remaining: 2n`.
    4. `signMint` + `broadcast` + `receipt` gives 2 issues to the two wallets.
    5. A third mint's estimate reverts and maps to `sold_out`.
    6. `setApproved(false)` maps to `not_approved`.
    7. Removing the minter maps to `not_minter`.
    8. `signTransfer` moves POL.
- [ ] **Step 3: Run, FAIL. Implement abi.ts and chain.ts. Run, PASS.**
- [ ] **Step 4: Commit.**

### Task 4: Host service and routes

**Files:**
- Create: `apps/server/src/giveaways/host.ts`, `apps/server/src/giveaways/funding.ts`, `apps/server/src/giveaways/marketplace.ts`, `apps/server/src/giveaways/routes.ts`
- Delete: `apps/server/src/routes/giveaways.ts`. Register `giveaways/routes.ts` in `app.ts` instead.
- Test: `apps/server/test/giveaways.test.ts` (rewrite), `apps/server/test/giveaway-funding.test.ts`

**Interfaces:**
- `funding.ts`:
  - `ownerIsPaid(ownerId: string): Promise<boolean>`: the Global Constraints rule.
  - `accounting(giveawayId): Promise<{ topUpsWei; coveredGasWei; virviUnspentWei }>`: sums confirmed `topup` tx values and the `feeWei` of confirmed mint txs with `covered`.
  - `withdrawableWei(balance: bigint, acc): bigint`.
  - `fundingView(g): Promise<{ balanceWei: string; withdrawableWei: string; claimsCovered: number; covered: boolean; tankMissing: boolean; lowGas: boolean }>`:
    - `claimsCovered = balance / (GIVEAWAY_GAS_PER_ITEM × itemCount × maxFeePerGas)`;
    - `covered` means the owner is paid and a gas key is configured;
    - `tankMissing` means the owner is paid but there's no gas key;
    - `lowGas` means not covered and `claimsCovered < 10`.
- `marketplace.ts`: `creatorItems(chain, wallets: string[]): Promise<{ contractAddress; itemId; name; thumbnail; rarity; available: number }[]>`.
  - Calls `GET {api}/v1/items?creator={w}&category=wearable&first=100` per wallet (also emotes: `category=emote`).
  - Reuse `readCapped` and the timeout from `assistant/show-wearables.ts`; export them if they aren't.
  - Only items with `isOnSale`-agnostic `reviewedAt` set, i.e. published.
  - Cached 60 s per (chain, wallet).
- `host.ts`. Every function takes `caller: { userId; admin: boolean }`. Owner or admin only; 404 for others, as BEATs do.
  - `createGiveaway(caller, { name, chain? })`: makes the wallet; `enabled: false`; Amoy only for admins (403 otherwise).
  - `updateGiveaway(caller, id, patch: { name?, startsAt?, endsAt?, claimCap?, minPresentSeconds?, enabled? })`:
    - `enabled: true` runs `mintCheck` and refuses with 409 `not_ready` (details: the failing items) unless every item passes.
    - It also needs at least one item and one scene.
    - `minPresentSeconds` is 0..7200. `claimCap` is ≥1 or null. `endsAt` must be after `startsAt`.
  - `setItems(caller, id, items: {contractAddress, itemId}[])`:
    - 1..10 items. Each must be in `creatorItems(chain, verifiedWalletsOf(ownerId))`; otherwise 400 `not_your_item`.
    - Caches name, thumbnail and rarity.
    - Refused (409 `has_claims`) once any claim is past `present`.
  - `setScenes(caller, id, sceneIds)`: the caller must be able to run events in each scene. Reuse `mayRunBeatsIn` from beats, or its underlying permission check.
  - `mintCheck(g): Promise<{ itemId; contractAddress; state: 'ready'|'not_minter'|'not_approved'|'sold_out'; remaining }[]>`: uses `itemState`.
  - `hostView(caller, id)`: the giveaway, its items with mint check, scenes, `fundingView`, the wallet address, `builderUrl`, and counts by claim status. Never `walletKeyEnc`.
  - `listGiveaways(caller)`: the owner's giveaways, not deleted, with light fields.
  - `listClaims(caller, id, cursor?)`: 50 per page; short wallet, status, `claimedAt`, `sentAt`, tx url.
  - `sendBack(caller, id, toWallet)`:
    - `toWallet` must be in `verifiedWalletsOf(ownerId)` (400 `not_your_wallet`).
    - Amount = withdrawable − the transfer's gas. If ≤ 0: 409 `nothing_to_send`.
    - Writes a `withdraw` tx row in `sending`. The job broadcasts it, so there's one sender path.
    - Refused while another tx from this wallet is open: 409 `busy`, "Try again in a minute."
  - `deleteGiveaway(caller, id)`:
    - If withdrawable > one transfer's gas: 409 `send_back_first`.
    - Otherwise sets `enabled false`, `deleteState 'returning'`, and `deletedAt` once the job has returned the float (Task 6).
    - The route answers 202.
- **Routes:**
  - `/api/giveaways` GET, POST
  - `/api/giveaways/:id` GET, PATCH, DELETE
  - `/api/giveaways/:id/items` PUT
  - `/api/giveaways/:id/scenes` PUT
  - `/api/giveaways/:id/claims` GET
  - `/api/giveaways/:id/send-back` POST
  - `/api/giveaways/creator-items?chain=` GET

  Rules:
  - All authenticated. Scene, Hyperfy, AR and studio passes are refused, as BEAT writes are.
  - Trials are refused (403).
  - When `!config.giveaways.enabled`, every route answers 503 `giveaways_off` with "Automatic giveaways aren't switched on for this server yet.", except `GET /api/giveaways/availability`, which returns `{ enabled, gasCovered }`.
  - Errors are `{ error: code, message }`, as BEATs do.

- [ ] **Step 1: Failing tests.** Mock `itemState`, `creatorItems` and `balanceWei` by injecting the chain client, through a `setGiveawayChainClientForTests` or vi.mock.
  - Create gives an address and no key in the response (assert the JSON has no `keyEnc` or `walletKeyEnc`).
  - A non-owner gets 404.
  - Amoy as a non-admin gets 403.
  - Enable with a not-minter item gets 409 `not_ready`; with all ready, 200.
  - `setItems` with someone else's item gets 400.
  - **Accounting** (giveaway-funding.test.ts):
    - topUps 1 POL, coveredGas 0.3, balance 2 → withdrawable 1.3 POL;
    - topUps 0.2, coveredGas 0.5, balance 1 → withdrawable 1;
    - balance 0.5 with unspent 0.7 → 0.
  - **Send-back:** to an unverified wallet → 400; to a verified one → a `withdraw` tx row with value = withdrawable − 21000 × maxFee.
  - Delete with 1 POL withdrawable → 409 `send_back_first`.
  - Plan lapse: `ownerIsPaid` false after the subscription is cancelled.
- [ ] **Step 2: FAIL. Implement. PASS.** Also run the existing `events` tests, so event links still work.
- [ ] **Step 3: Commit.**

### Task 5: Visitor service and routes

**Files:**
- Create: `apps/server/src/giveaways/visitor.ts`, adding the visitor routes in `giveaways/routes.ts`
- Test: `apps/server/test/giveaway-visitor.test.ts`

**Interfaces:**
- `currentGiveaway(sceneId, userId): Promise<VisitorGiveaway | null>`.
  - Picks the scene's open giveaway, the oldest `startsAt` first. **Open** means:
    - not deleted, `enabled`;
    - now inside its window;
    - claims past `present` below `claimCap`;
    - every item's remaining supply (last mint check, cached on the item row as `remaining` when the job reads it) above the claims queued;
    - the chain matches the server's mode: Amoy giveaways are hidden unless their owner is an admin.
  - Returns null otherwise.
  - The caller's own claim is included even once the giveaway closes, so "Sent ✓" stays visible until it ends.
- `trackGiveaway(sceneId, id, caller: VisitorCaller, consentVersion)`:
  - Checks, as `beats/visitor.ts` does: a verified wallet is required (403 `wallet_required`, "Connect a wallet to claim."), `platformCheck`, the profile requirement, `isWalletBlocked`, and `checkNewWallet` with the BEAT network limit.
  - `consentVersion` must equal `GIVEAWAY_CONSENT_VERSION` (400 `consent_outdated`).
  - Inserts a `present` claim.
  - The same wallet on another account gets 409 `already_claimed`, "This wallet already claimed this giveaway."
- `checkInGiveaway(sceneId, id, userId)`: uses `checkInDelta` from `presence/attendance.ts`.
- `claimGiveaway(sceneId, id, { userId, platform, ip })`:
  - Locks the giveaway row.
  - Needs `secondsPresent ≥ minPresentSeconds` (409 `too_soon` with `secondsLeft`).
  - Re-checks open, cap and supply under the lock (409 `sold_out` or `closed`).
  - Sets `waiting`, `claimedAt`, and one `giveawayClaimMints` row per distinct contract.
- `stopGiveaway(sceneId, id, userId)`: deletes a `present` claim only.
- Routes under `/api/scenes/:sceneId/giveaway/…`: `current` GET, `:id/track` POST/DELETE, `:id/checkin` POST, `:id/claim` POST. Same pass rules as the BEAT visitor routes (`sceneScoped`, `inScene`).
- **Realtime:** join messages announce `giveaway_available` the same way `beat_available` is sent. Find where `beat_available` is sent in `apps/server/src/realtime` and add the giveaway one beside it, for guests.

- [ ] **Step 1: Failing tests.**
  - The happy path to `waiting`, with mint rows per contract.
  - `too_soon` before the minimum time.
  - A wallet without verification → 403.
  - The same wallet twice → 409.
  - **Cap 1, two concurrent claims:** run `Promise.all` of two claims from two users; exactly one `waiting`, the other 409 `closed`.
  - The window ended → `current` is null.
  - A disabled giveaway → null.
  - A deleted one → null.
  - A paused (`low_gas`) giveaway still returns the card and accepts claims.
  - A visitor on scene B can't see a giveaway linked only to A.
- [ ] **Step 2: FAIL. Implement. PASS.**
- [ ] **Step 3: Commit.**

### Task 6: Minting job

**Files:**
- Create: `apps/server/src/giveaways/job.ts`. Start it in `apps/server/src/index.ts` beside the BEAT job.
- Test: `apps/server/test/giveaway-job.test.ts`. Use a fake `GiveawayChainClient` that records signed and broadcast calls, like `beat-job.test.ts` does.

**Interfaces:**
- `runGiveawayJob(now = new Date(), deps = { client: giveawayChainClient }): Promise<void>`: one pass on one instance, behind `withLock('giveaway-minter', …)`.
- `startGiveawayJob(): () => void`: every `config.giveaways.jobEveryMs`, only when enabled.

**Per pass:**
1. **Reconcile every open tx (`sending`/`sent`), per `fromAddress`:**
   - `sending` with `rawTx`: broadcast, then `sent`.
   - `sent`: read the receipt.
     - **Confirmed** (receipt plus 3 blocks on Polygon, 1 on Amoy): store `feeWei`, then apply by kind:
       - **mint:** set each claim's mint row `sent` with token ids from the issues. A claim with all mint rows `sent` becomes `sent` with `sentAt`.
       - **topup:** nothing more.
       - **withdraw/return:** nothing more.
       - **return:** completes a delete.
     - **Reverted:** a mint maps `revertReason` → pause the giveaway (`pausedReason`), and the claims go back to `waiting`. `sold_out` instead fails the claims the remaining supply can't cover, with `failReason 'sold_out'`.
   - Reprice after 3 minutes unconfirmed: same nonce, fees +15%, the same gasLimit. Mirror `beats/job.ts`.
   - On RPC errors, count failures in memory per chain. After 10, pause the chain's giveaways as `rpc_down` and `recordJobFailure`.
2. **Per enabled giveaway with `waiting` claims and no open tx from its wallet:**
   - Check `mintCheck` for the contracts involved. On failure, set `pausedReason` and skip. On success, clear any pause.
   - Take up to `GIVEAWAY_MAX_CLAIMS_PER_TX` claims for one contract. Their mint rows become `minting`.
   - `need = gasLimit × maxFee`. If `balance < need × 1.2`:
     - **Paid owner and tank configured:** create a `topup` tx from the tank to the giveaway wallet for `need × 50 claims' worth − balance`, capped at 5 POL. Only if the tank's balance after the top-up stays ≥ `tankMinWei`; otherwise `recordJobFailure('giveaway_tank_low')` once per hour and pause `low_gas`.
     - **Otherwise:** pause `low_gas`.
     - Skip this giveaway this pass.
   - Otherwise sign, and write the tx row with `rawTx`, `covered = ownerIsPaid && hasConfirmedTopUp`, and the nonce from `nonce(address,'pending')`. Then broadcast.
3. **Withdraw rows** created by `sendBack` are signed the same way: the row starts with no rawTx; sign and write before broadcasting.
4. **Ends and deletes:**
   - A giveaway past `endsAt` with no `waiting`/`minting` claims, or with `deleteState 'returning'`, and `virviUnspent > transfer gas`: create a `return` tx to the tank address for `min(virviUnspent, balance) − gas`.
   - Once nothing is left to return: if `deleteState 'returning'`, set `deletedAt` and null out `walletKeyEnc`.
   - `present` claims of ended giveaways are deleted.
5. **Logs** carry only ids and counts.

- [ ] **Step 1: Failing tests,** one each, with the fake client:
  1. **Happy path:** two waiting claims → one mint tx signed with both wallets → after the receipt, both `sent` with token ids.
  2. **Crash between sign and broadcast:** a row `sending` with rawTx and no broadcast → the next pass broadcasts the same raw (assert one sign call total).
  3. **Not minter:** `itemState.canMint=false` → `pausedReason 'not_minter'`, claims stay `waiting`. Then minter restored → minted, pause cleared.
  4. **Sold out:** remaining 1 with 2 waiting → one minted, one `failed` `sold_out`.
  5. **Low gas, free owner:** paused `low_gas`, no tank tx.
  6. **Low gas, paid owner:** a `topup` tx from the tank, then a mint marked `covered: true` on a later pass.
  7. **Plan lapsed:** no top-up, paused `low_gas`.
  8. **Tank below its floor:** no top-up, a job failure recorded.
  9. **Two contracts:** a claim with items on two contracts is `sent` only after both mints confirm.
  10. **Delete:** with Virvi unspent 0.5 → a return tx to the tank → `deletedAt` set and the key nulled.
  11. **Withdraw row:** signed and broadcast, amount as stored.
- [ ] **Step 2: FAIL. Implement. PASS.**
- [ ] **Step 3: Commit.**

### Task 7: In-scene giveaway card

**Files:**
- Modify: `packages/client/src/http.ts` and `packages/core/src/Virvi.ts`, adding:
  - `currentGiveaway()`, `trackGiveaway(id)` (sends `GIVEAWAY_CONSENT_VERSION`), `giveawayCheckIn(id)`, `claimGiveaway(id)`, `stopGiveaway(id)`;
  - `onGiveawayAvailable(listener)`.
- Create: `packages/adapter-dcl/src/giveaway/card.ts`, `connect.ts`, `GiveawayOverlay.tsx`
- Modify: `packages/adapter-dcl/src/index.ts`. Call `startSceneGiveaways` beside each `startSceneBeats` call.
- Modify: `apps/server/src/services/dcl/runtime.ts`: `DCL_RUNTIME_VERSION = 17`. Update the runtime files the way the last bump did; check `git log -p --follow apps/server/src/services/dcl/runtime.ts` for the v16 bump.
- Test: `packages/adapter-dcl/test/giveaway-card.test.ts`, `giveaway-connect.test.ts`, `packages/core/test/giveaway-client.test.ts`

**Card states and exact copy:**

| State | Text | Button |
| --- | --- | --- |
| Guest | "Connect a wallet to claim {name}." | none; 15 s notice like the BEAT guest notice |
| Not consented | "{name}: free {item names joined with ', '}." Notice: "Virvi will mint these to your wallet {short}. The host sees that this wallet claimed." | "Agree and continue" |
| Present, waiting on time | "Stay {m:ss} more to claim." | none |
| Ready | (none) | "Claim" |
| `waiting` or `minting` | "On its way." | none |
| `sent` | "Sent ✓" | "View" (opens the tx url) |
| `failed` | "Couldn't send: {reason text}" | none |

Reason texts:
- `sold_out`: "this giveaway ran out."
- otherwise: "something went wrong."

Error codes map to short messages, as `beatError` does.

Behaviour mirrors `beat/connect.ts`:
- polls `current` on connect and every `CHECKIN_INTERVAL_MS`;
- checks in while `present`;
- one request at a time;
- guests use `onGiveawayAvailable`.

The card sits under the BEAT card when both show. Reuse the `card-column.tsx` stacking.

- [ ] **Step 1: Failing tests.** Card state from each `VisitorGiveaway` shape gives the exact strings above. Connect: polling, check-in while present, a claim button press, no HTTP for guests. Client: each method hits the right path.
- [ ] **Step 2: FAIL. Implement. PASS.** `pnpm --filter @virvixr/adapter-dcl test`, plus a typecheck of packages/dcl.
- [ ] **Step 3: Commit.**

### Task 8: Drops page

**Files:**
- Rewrite: `apps/web/src/app/(dashboard)/drops/page.tsx`. Split the detail out into `apps/web/src/components/drops/` (`GiveawayDetail.tsx`, `ItemPicker.tsx`, `FundingCard.tsx`, `ClaimsTable.tsx`).
- Modify: `apps/web/src/lib/api.ts` (new methods matching Task 4's routes), `apps/web/src/lib/demo/fixtures.ts` and `store.ts` (the demo's giveaways use the new shape).
- Test: `apps/web/src/lib/drops.test.ts` for the pure helpers: POL formatting from a wei string with 4 decimals, the claims-covered label, the minter-step label.

**Page:**

- **List:** name, chain badge ("Test" for Amoy), status (Off / On / Paused: {reason text} / Ended), claims sent.
- **Create:** a name field, plus a chain selector for admins only.
- **Detail, in order:**
  1. **Status bar** with an On/Off switch. Turning it on shows the `not_ready` items when refused.
  2. **Wallet:** the address with Copy and "View on Polygonscan".
  3. **Items:** "Choose items" opens a picker from `creator-items`. Each item row has its mint state:
     - ready: "Can mint ✓";
     - not minter: "Add {short address} as a minter in the Builder", with a link from `giveawayBuilderUrl`;
     - not approved: "Waiting for curation";
     - sold out: "Sold out".

     A "Check again" button.
  4. **Funding:**
     - covered: "Gas is covered by your plan." If the host has their own POL, add "You also have {x} POL here."
     - tank missing (paid): "Gas cover isn't set up on this server yet. Send POL to the address above."
     - free: "Send POL to the address above. It covers about {n} claims." With `lowGas`, a warning: "Running low: about {n} claims left."
     - "Send back {x} POL": pick a verified wallet from a select. Disabled when withdrawable is 0.
  5. **Rules:** start/end, cap, minimum minutes (number input, 0 = none).
  6. **Scenes:** multi-select of the host's scenes.
  7. **Claims table:** short wallet, status, time, View link. Totals.
  8. **Delete.** On `send_back_first`, the message is "Send back the POL first."
- **When availability says off:** a notice, "Automatic giveaways aren't switched on yet.", and the create button is hidden.

- [ ] **Step 1: Failing helper tests. Implement. `pnpm --filter web test`, `tsc`, `next build` pass.**
- [ ] **Step 2: Commit.**

### Task 9: Assistant

**Files:**
- Modify: `apps/server/src/assistant/tools/shows-tools.ts` and `assistant/shows.ts` (the show job's wearable step), the assistant prompt (`assistant/prompt.ts`), and `docs` assistant page
- Create: a tool `create_giveaway` in `apps/server/src/assistant/tools/giveaways.ts`, registered where other tools are
- Test: extend `apps/server/test/assistant-tools*.test.ts` and `assistant-shows.test.ts`

**Interfaces:**
- `create_giveaway({ name, sceneId, items?: {contractAddress, itemId}[] })`:
  - A normal (non-paid) write card. Calls `createGiveaway`, then `setItems` and `setScenes`.
  - Always leaves it switched off.
  - The result text includes the wallet address and "Add it as a minter on your collection in the Builder, then switch the giveaway on in Drops."
  - Never moves POL or enables. There's no tool for enable, send-back or delete.
- **Show job wearable step:**
  - When the show's detected wearable (`found`) exists and giveaways are enabled, offer "automatic giveaway" first, with the found item prefilled; a raffle is the other choice.
  - When giveaways are off, only the raffle is offered (current behaviour).

- [ ] **Step 1: Failing tests:**
  - The tool creates a giveaway switched off, with the items and scene.
  - The result text has the address and the Builder step.
  - The show step offers both choices when enabled, and only the raffle when off.
- [ ] **Step 2: FAIL. Implement. PASS.**
- [ ] **Step 3: Commit.**

### Task 10: Docs, env and release wiring

**Files:**
- Modify:
  - `.railway/railway.ts`: `preserve()` the four new vars, with no values;
  - the docs environment-variables page (find it with `grep -rl "BEAT_MINTER_KEY" apps/docs`);
  - the docs Drops page (create `apps/docs/src/content/docs/dashboard/drops.md` if none). Write it for hosts: grant minter in the Builder, funding by plan, send back, what visitors see;
  - `packages/dcl/package.json` and `packages/shared/src/hud-protocol.ts`: `2.18.0`;
  - `packages/dcl` changelog, if one exists.

- [ ] **Step 1:** Make the edits. Run the docs build (`pnpm --filter docs build`, if that's the package name) and the shared tests that check `DCL_HUD_VERSION` equals the dcl package version.
- [ ] **Step 2: Commit.**
