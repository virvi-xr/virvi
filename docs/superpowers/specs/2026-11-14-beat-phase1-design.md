# BEAT phase 1 (LIV-11): design

Linear: LIV-11 (Virvi BEAT). Owner decisions are in its comments of 2026-11-12 and 2026-11-13, marked **[owner]**. Calls I made are marked **[my call]**.

## Why

Hosts want a reason for people to show up, and something that proves they were there. A BEAT is a free collectible attendance token. Visitors who were at the event, and who choose to claim it, get it in their wallet. They never sign or pay anything. Virvi earns a small fee per event.

## Phase 1 scope

**In:**
- **The contract:** the shared Virvi BEAT contract, ERC-1155, one per chain. Polygon Amoy (testnet) first, then Polygon mainnet once it passes review.
- **Creating a BEAT:** the host creates one, uploads artwork, sets the window and scenes, and pays.
- **Claiming in-world:** opt-in, from the scene, by visitors with a verified wallet who were present long enough. **[owner]**
- **Minting:** a server minting service mints claims in batches, from a minter wallet. **[owner]** gives the key through 1Password. **[owner]** pays the gas.
- **Results:** the host sees how many claimed, and who.
- **Transparency:** the contract is published, verified on Polygonscan, and listed on `/transparency`.

**Out (later phases):**
- The host's own contract (from the Contracts section, LIV-164).
- Base, Arbitrum, Optimism and Solana.
- Guests claiming without a wallet.
- MANA payments for BEATs (card and credit only in phase 1). **[my call]**

## Anti-goals

- **No silent wallet collection:** a visitor's wallet is never stored unless they chose to claim.
- **No custody:** nothing anyone owns can be moved or burned by Virvi. The contract can mint new tokens and do nothing else to holders.
- **No one-way surprises:** the host knows the most they can be charged before paying.
- **No lost claims:** a busy chain or an empty gas balance never loses one. It only delays it.
- **No mainnet before review:** nothing reaches Polygon mainnet until the review below has passed.

## The contract (`contracts/VirviBeat.sol`, Foundry)

The contract is built on OpenZeppelin Contracts 5 (`ERC1155`, `AccessControl`), pinned to an exact version.

**Roles:**
- `DEFAULT_ADMIN_ROLE`: the owner's admin wallet, `0x7BC6B7cd586BeF73136e2fb9bdF2eA56D2809220` (owner decision 1). The deploy script takes it as `BEAT_ADMIN`; its key stays in the owner's 1Password and never reaches Virvi's servers.
  - It grants and revokes `MINTER_ROLE`, and sets the metadata base URI.
  - It holds no power over anyone's tokens.
- `MINTER_ROLE`: Virvi's minter wallet, the 1Password key.
  - It can only call `mintTo` and `createBeat`.

**Functions:**
- `createBeat(uint256 id, bool tradeable)`:
  - Registers a token id once. It reverts if the id already exists.
  - `tradeable` is fixed at creation and can never change.
- `mintTo(uint256 id, address[] calldata to)`:
  - Mints 1 of `id` to each address. It skips, rather than reverts on, an address that already holds one, so retries are safe and nobody gets 2.
  - At most 200 addresses per call.
- **Transfers:** a non-tradeable id can't be transferred. Any transfer where `from != 0` reverts, enforced in `_update`. Holders can still burn their own token, because `to == 0` is allowed.
- **Metadata:** `uri(id)` returns `{base}{id}.json`, where `base` is `https://api.virvi.io/api/beats/metadata/`.
- **Nothing else:** no pause, no upgrade proxy, no admin transfer of tokens, no `selfdestruct`, no payable functions, and no way to send ETH or POL into or out of the contract.

**Before mainnet:**
- Foundry unit tests and fuzz tests: roles, double mint, transfer blocking, burn allowed, the batch limit.
- A Slither run with no high or medium findings.
- An Amoy deploy with a real end-to-end run.
- The five-persona review (LIV-11, 2026-11-13). The reviewers get the code, not my conclusions: attacker, access-control auditor, gas and chain engineer, standards and marketplace reviewer, plain-language reviewer.
- The verified source on Polygonscan, with the address on `/transparency` and in the docs.

**Deploying:** a Foundry script (`contracts/script/Deploy.s.sol`) that the **owner** runs from their own machine. It takes the admin address and minter address as arguments, so neither key passes through Virvi's servers. I give the exact one-line command. **[my call]**

## Data (server)

- **`beats`:**
  - `id`, `token_id` (bigint, unique per chain), `chain` (`'polygon-amoy' | 'polygon'`)
  - `owner_user_id`, `name` (≤60), `description` (≤500), `image_url`
  - `starts_at`, `ends_at`, `min_present_seconds` (default 300), `supply_cap` (default 100, maximum 5000), `tradeable` (default false)
  - `status`: `draft | paid | live | ended | cancelled`
  - `created_on_chain_tx`, `payment_id`, `created_at`
- **`beat_scenes`:** (`beat_id`, `scene_id`), one or more scenes.
- **`beat_claims`:**
  - `id`, `beat_id`, `user_id`, `wallet`, `consent_version`, `seconds_present`, `last_seen_at`
  - `status`: `present | claimed | minting | minted | failed`
  - `mint_tx`, `claimed_at`, `minted_at`
  - Unique on (`beat_id`, `wallet`) and on (`beat_id`, `user_id`).
- **`beat_payments`:** a copy of the `studio_payments` shape for card and credit: `pending | paid | expired`, a Stripe session id, the amount and the lines.
- **`beat_mint_batches`:**
  - `id`, `chain`, `token_id`, `wallets` (text[]), `nonce`, `tx_hash`
  - `status`: `sending | sent | confirmed | failed`
  - `attempts`, `last_error`, `created_at`
  - It records every transaction the minter sends, so it can be reconciled after a crash.

## Flow

1. **Create (dashboard, new BEATs page and a section on a scene's page).**
   - The host gives a name, description, artwork (an image upload, square, at least 512 px, using the existing media upload), the window, the scenes, the minimum time present (0 to 120 minutes, default 5), the supply cap (1 to 5000, default 100) and tradeable (default off).
   - The host must be able to run the scene for every scene chosen: the `raffle.run` scope, renamed in code to an `events.run` alias with the same holders. **[my call]**
   - A review step shows the full price before paying.
2. **Pay.**
   - Price: **$5 for the first 100 of the cap, then $0.02 for each one after**, so price = 500 + 2 × max(0, cap − 100) cents. The cap is the most the host can be charged.
   - Paid up front by card (a Stripe one-off checkout, the studio-payments pattern) or by Virvi credit if the account has any. **[my call]**
   - Unclaimed mints aren't refunded in phase 1. The review step says so. **[owner decision 2]**
   - Prices are server settings: `BEAT_PRICE_BASE_CENTS=500`, `BEAT_INCLUDED_MINTS=100`, `BEAT_PRICE_EXTRA_MINT_CENTS=2`.
3. **Create on chain.** When payment is confirmed, the minting service calls `createBeat(tokenId, tradeable)` and the status becomes `paid`, then `live` at `starts_at`. The token id is a server sequence per chain.
4. **Presence (in-world, during the window).**
   - Visitors with a verified wallet in any of the BEAT's scenes see a small card: "Attend for N minutes to earn the {name} BEAT."
   - Presence is only tracked after the visitor taps **Track my attendance**. That's the opt-in, with consent text naming exactly what's stored: their wallet, for this BEAT, so the token can be sent.
   - After that, check-ins use the raffle's shared helpers (`checkInDelta`, every 30 s, a 45 s cap, a 20 s minimum gap) on their `beat_claims` row, with status `present`.
   - **[my call, why opt-in comes first]** Tracking presence without consent would mean storing a wallet before the visitor agreed. Opting in first keeps the owner's "opt-in like the raffle" decision exact.
5. **Claim.**
   - When `seconds_present` reaches the minimum during the window, the card changes to **Claim your BEAT**. One tap sets the status to `claimed`.
   - A visitor who opted in but leaves before tapping isn't claimed. They can tap later, until the window ends plus 24 hours, from any of the BEAT's scenes. **[my call]**
   - Each claim needs supply left (claimed + minted < cap). After that the card says "All claimed".
6. **Mint.**
   - A job runs every 60 s across all chains, locked so only one instance runs it: a session advisory lock, like `errors/jobs.ts`, so no transaction stays open while waiting on the chain.
   - For each live or ended BEAT, it takes up to 200 `claimed` claims, marks them `minting`, records a batch, and sends `mintTo` from the minter wallet with an explicit nonce.
   - It waits for the receipt with the chain's confirmations: 5 on Amoy and 30 on Polygon, as `studioMana` uses.
   - Then it marks the batch confirmed and the claims `minted`.
   - **Failures:**
     - A failed send is retried with backoff; after 5 attempts the claims become `failed` and admins are alerted (the job failure records the existing jobs use).
     - Low gas (the minter's POL below a threshold) pauses minting and shows on the admin page. Claims wait; none are lost.
     - **Crash recovery:** a batch left `sending` or `sent` is reconciled by its nonce and tx hash before anything new is sent.
7. **In-world result.** When the claim is minted, the card shows "Your {name} BEAT is in your wallet", with a link to the token on Polygonscan.
8. **Host results.** The BEAT's page shows claimed and minted counts against the cap, and the list of claimants: shortened wallets, display names, and a copy button.

## Privacy and retention

- **Stored data:** only people who opted in have a `beat_claims` row with their wallet.
- **Delete-my-data** (`POST /api/analytics/me/delete`) deletes `present` and `claimed` rows. A `minted` row's wallet is already on-chain, publicly, so the row is kept but its link to the Virvi account is removed: `user_id` is set to null. The docs say so.
- **Opted in but never claimed:** deleted 30 days after the BEAT ends.
- **Privacy page and docs:** both get a BEATs section.

## Admin

An admin BEATs page shows:
- the minter wallet address and its POL balance per chain;
- pending, minting and failed claims;
- recent batches with links to Polygonscan;
- a **Retry failed** button.

BEATs ship dark behind `BEAT_ENABLED` (default off) and a per-chain `BEAT_CONTRACT_<CHAIN>` address. The dashboard hides BEATs when the server reports them off, the way billing availability works.

## Secrets

- `BEAT_MINTER_KEY` is loaded with `validDeployKey`, never logged, and only its address is ever exposed.
- The owner sets it from 1Password with a one-line `! railway variables --set "BEAT_MINTER_KEY=$(op read 'op://…')"` command that I give. Claude never handles the value.
- RPC: `POLYGON_RPC_URL` (exists) and a new `POLYGON_AMOY_RPC_URL`.

## Release order

1. The contract, its tests and Slither. Deploy to Amoy (the owner runs the script).
2. Server, dashboard and in-world, all against Amoy with `BEAT_ENABLED` on in staging, or on in prod for admins only. **[my call: admin-only in prod until mainnet]**
3. The five-persona review, with fixes.
4. Mainnet deploy (the owner), Polygonscan verification, `/transparency`, then on for everyone.

The in-world parts ship as `@virvixr/dcl` 2.16.0 and runtime v15.

## Owner decisions (2026-11-14)

1. **Admin:** separate from the minter. **Updated 2026-11-15:** on Polygon mainnet the admin is a **Safe multisig, 2 of 3**, with the signers `0x7BC6B7cd586BeF73136e2fb9bdF2eA56D2809220`, `0x01d871870CbBddE934526E17637c0cfEf0b3b38B` and `0x2319A029D05e52043f077c0684e3C0BF6d1c3dbB` (the deploy refuses anything else on chain 137). On Amoy the admin stays the ordinary wallet `0x7BC6B7cd586BeF73136e2fb9bdF2eA56D2809220` (an EOA). The admin also holds the reissuer role. The mainnet runbook is `contracts/README.md`, step 4.
2. **Unclaimed mints:** not refunded in phase 1.

## Later decisions (2026-11-15)

These came after the design above and win where they differ.

3. **Reissue.** A person whose wallet was lost or stolen can ask (Settings, "Move my BEATs to a new wallet") for their BEATs to be sent again to a new, linked wallet. A Virvi admin reviews it, with red flags and the account's wallet history. The person says whether the old wallet was lost or stolen (for the reviewer; both end the same way). Approval blocks the old wallet from BEATs on every account (it can never track, claim or be a reissue's new wallet) and from the account it was taken from (its sessions there end, it can't sign in to it or be linked back; once unlinked it can sign up as a new, separate account: the owner's call, 2026-11-16, instead of a block from all of Virvi), and removes the account's API keys and paired devices; the admin prepares Safe Transaction Builder files (one Safe transaction each, non-tradeable BEATs together and each tradeable one alone), the Safe's signers send them, and the server moves the claims once they land at depth. A BEAT can only be reissued after it ends. Built in `apps/server/src/beats/reissue.ts` and the contract's `reissue`.
4. **Anti-bot protections.** A BEAT proves only that a wallet signed in from the scene and stayed connected for the minimum time. To make faking it harder: time counts only while the scene holds a live Virvi room connection; a Decentraland wallet needs a profile; at most `BEAT_CLAIMS_PER_IP` (3) claims of each BEAT per network, counted under a keyed per-BEAT hash; at most `BEAT_NEW_WALLETS_PER_IP_HOUR` (10) new wallets per network per hour; and an optional host review ("Check claims before they are sent") with Send and Remove, where held claims go out anyway at the end plus 24 hours.
5. **Location.** Each BEAT has a location that locks at go-live with the rest of the metadata: `scene` (the default, labelled from its scenes: the scene's name with its World name or Genesis City coordinates), `online` (a platform and its URL) or `in_person` (a venue, city or region, country, and optionally a street address and a map URL). URLs are http(s) only and every field is capped. The token gets `Location type` (Virtual or In person) and `Location` attributes and a "Where:" line in its description. Claiming still happens only in Virvi scenes.
6. **Consent version 2.** The consent text now names the 30-second check-ins and the permanent public record on Polygon (wallet, BEAT and time). A test ties the version to the text.
7. **Go-live.** The BEAT goes on chain, and its name, description, Tradeable, location and times lock, at its start (not at payment or first mint). The art is copied at payment and again on each image change; after the start only the image can change, and only until the BEAT is on chain.

## Left to the builder

- Card layout and copy.
- The exact admin page layout.
- The internal module split.
- The token id sequence implementation.

## Settled details (from the builder check)

Where this section and the text above differ, this section wins. All are **[my call]**.

1. **Metadata.**
   - Each chain's contract has its own base: `https://api.virvi.io/api/beats/metadata/{chain}/` (`polygon-amoy` or `polygon`). Token ids are a sequence per chain.
   - **Frozen at first mint:** once any claim of a BEAT is minted, its name, description and image can't change.
   - **Image copy:** at payment, the artwork is copied to `beats/{chain}/{tokenId}-{imageMediaId}.{ext}` in public storage. The host can't delete that copy, and deleting the original upload doesn't affect it.
   - **What the docs say:** the admin can change the base URI, which is where wallets look up names and images, but can never move, burn or change anyone's tokens.
2. **After paying.**
   - **Before `starts_at` and before any mint,** the host can edit the name, description, artwork, window, scenes and minimum time.
   - **Raising the cap** charges the difference at the per-mint price through a top-up checkout, with the same pattern. It can be raised at any time before `ends_at`, and never lowered.
   - **Cancel only before `starts_at`.** It's a full refund to the card through Stripe, following the studio's refund path. After `starts_at` there's no cancel. The host can **End early**, which sets `ends_at = now`; claims already made still mint.
3. **Who sees claimants.**
   - The creator, and anyone with `events.run` on any of the BEAT's scenes.
   - **Consent text:** *"To track your attendance for the {name} BEAT, Virvi stores your wallet address and display name for this BEAT. The hosts of this event will see them, and your wallet is needed to send you the token. You can stop tracking at any time before you claim."*
   - The display name is cleaned (`cleanDisplayName`) and stored at opt-in, in a new `display_name` column on `beat_claims`.
4. **Delete-my-data and account deletion** (both do the same):
   - `present`, `claimed` and `failed` rows are deleted.
   - `minting` rows get `delete_requested = true`. When their batch settles, the job deletes the row if it failed. If it was minted, the job removes the account link and name (`user_id`, `display_name` → null) and keeps the wallet, which is public on chain.
   - `minted` rows get `user_id` and `display_name` nulled.
   - `beat_mint_batches.wallets` is cleared 30 days after a batch is confirmed or failed; the tx hash is kept.
5. **The cap** counts `claimed + minting + minted + failed`. A failed claim still holds its place, and **Retry failed** sends it again. The cap check runs under a row lock on the BEAT.
6. **Fairness of time.**
   - Check-ins only add time between `starts_at` and `ends_at`. The minimum is total time across all the BEAT's scenes, on one row per visitor; the 20 s minimum gap stops double counting from two scenes at once.
   - A visitor who reached the minimum during the window can still tap **Claim** until `ends_at + 24 h`.
   - Stopping tracking before claiming deletes the row.
7. **Before mainnet.**
   - The chain is a server setting, `BEAT_CHAIN`, defaulting to `polygon-amoy`.
   - While it's Amoy, BEATs are admin-only and free: no Stripe, recorded as a payment of 0 with method `test`.
   - After the switch to mainnet, Amoy BEATs stay visible only to admins, marked "Test".
8. **The contract never mints twice.** A minted-once flag per (id, address), `mapping(uint256 => mapping(address => bool))`. A holder who burns or transfers their token can't get another one.
