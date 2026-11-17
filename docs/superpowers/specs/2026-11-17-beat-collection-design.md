# BEAT collection: what you hold, and a public page per wallet

Status: approved in conversation 2026-11-17 (layout A). Part of LIV-11.

## Why

BEATs exist to prove someone was at an event and to be a keepsake of it. Today a visitor can only see a BEAT in their
wallet app or on Polygonscan, and Virvi's `/beats` page shows only the BEATs a person **hosts**. People want to:

- admire their collection in one place, across every wallet they've linked to Virvi;
- prove to someone else that they were at an event (a public link);
- see which wallet ended up with which BEAT (people sign in with more than one wallet).

## Goals

1. **Collected tab** on the signed-in `virvi.io/beats` page: every BEAT held by any wallet linked to the account.
2. **Public wallet page** `virvi.io/w/<address>`: the BEATs one wallet holds, open to anyone, signed in or not.
3. Each BEAT shows whether it was **Earned** (claimed through Virvi by attending) or **Held** (reached the wallet any
   other way: bought, transferred, reissued from elsewhere).
4. Filters on the Collected tab: **wallet** (all or one), **date** (the event's date range), **kind** (Basic or
   Custom contract), and **Earned only**.
5. A clear visual difference between BEATs you **collected** and BEATs you **host**.

## Non-goals

- Custom-contract BEATs themselves (hosts deploying their own contract is a later LIV-11 phase). The Kind filter
  exists now with Custom as an empty choice, so nothing changes in the UI when they arrive.
- Other networks than Polygon mainnet. Amoy (test) BEATs are not shown on mainnet, as elsewhere.
- Selling, sending or otherwise acting on a BEAT from these pages. They are read-only.
- Showing the person's other wallets or Virvi identity on the public page.

## Anti-goals (would make it a failure even if it "works")

- **The public page links wallets together or to a Virvi account.** Wallets being on chain is public; which wallets
  belong to the same person is not. The public page is one wallet, and nothing on it (names, counts, links, page
  source, API response) reveals the account or the person's other wallets.
- **"Earned" on a BEAT nobody earned.** Earned must come from Virvi's own claim records for that wallet and token, not
  from holding it. A bought tradeable BEAT is Held, never Earned.
- **Holdings that drift from the chain.** If a tradeable BEAT is sold, it must leave the seller's page and appear on the
  buyer's. A reissued BEAT moves from the old wallet to the new one.
- **Collected and Hosting looking alike.** A host should never mistake a BEAT they run for one they own, or vice versa.

## Decisions (the owner's)

- **Layout A:** `virvi.io/beats` gets two tabs, **Collected** and **Hosting**. Hosting is today's management list,
  unchanged. Collected is a shelf of round "medal" tiles (the BEAT's image in a circle). The medal look is used only
  for collected BEATs.
- **Show everything a wallet holds**, and mark the ones it earned.
- **The public page is per wallet** and open to anyone.

## Calls made in the conversation (Claude's, accepted by the owner)

- Collected is the default tab for everyone; Hosting is one click away. *(A host who mainly manages events may want
  Hosting first: revisit if hosts complain.)*
- The date filter is the **event's** date (the BEAT's start), not the date the token arrived.
- Holdings come **from the chain**; Earned comes **from Virvi's claim records**.
- The public page works for **any** wallet address, including one that never used Virvi (BEATs are public on chain).

## What each tile shows

- The BEAT's image (round), name, the event's place (scene or world name, as in the token's metadata) and date.
- **Earned** (accent colour) or **Held** (neutral) tag.
- Signed-in Collected tab only: which wallet holds it, as `0x1234…abcd`, with copy. Public page: no wallet column
  (it's all the one wallet).
- **Tradeable** shown when the BEAT is tradeable (non-tradeable is the norm).
- Quantity when a wallet holds more than one of the same token (possible for tradeable BEATs).
- Opens the BEAT's detail: the token's metadata (name, image, description, place, dates), a link to the token on
  Polygonscan, and, if earned, when it was claimed and the mint transaction.

## Public page `virvi.io/w/<address>`

- Header: the short address (with copy and a Polygonscan link), the number of BEATs and how many were earned.
- The same medal grid, newest event first. Filters: date and Earned only (kind once Custom exists). No wallet filter.
- An empty wallet says so plainly ("This wallet doesn't hold any BEATs yet") and links to `/beats` (the explainer).
- An invalid address is a not-found page.
- The signed-in Collected tab links to each of your wallets' public pages ("Share" next to each wallet in the filter).
- `virvi.io/w/` pages should be indexable and have share previews (title "BEATs held by 0x1234…abcd").

## Data

- **Held:** the balance of each BEAT token per wallet on the shared Virvi contract (`0x2ca6…F0d3` on Polygon), plus
  later each custom contract. It must reflect transfers, sales and reissues. The builder chooses how (see below).
- **Earned:** a minted claim in `beat_claims` for that BEAT whose wallet is this wallet. A reissued claim (moved to a
  new wallet after a lost/stolen request) counts as Earned for the **new** wallet, since the person did attend.
- **Kind:** Basic = the shared Virvi contract; Custom = any other contract Virvi knows about (none yet).
- **Linked wallets:** the account's wallet sign-in methods (`user_auth_methods` of type wallet).

## Constraints

- Public, unauthenticated endpoint for the wallet page: rate-limited per IP like other public endpoints, and cached.
  It must not be a way to enumerate Virvi accounts.
- No new paid services required. `POLYGON_RPC_URL` is Alchemy (mainnet), and the server already reads the contract.
  Free RPC tiers limit log ranges (dRPC: 10,000 blocks per `eth_getLogs` on the free plan).
- Works on phone width; follows the dashboard's existing look (Tailwind, the components in `apps/web/src/components`).
- The website is a static export (`output: 'export'`), so `/w/<address>` needs a client-side route pattern like the
  existing `/u/[code]` and `/s/[code]` pages.
- Test and dev installs (Amoy) behave the same against their own contract; mainnet hides Amoy BEATs as today.

## Left to the builder

- **How holdings are read.** Options: (a) index the contract's `TransferSingle`/`TransferBatch` events into a table
  (backfilled from the deploy block, then followed by the BEAT job), which keeps every page a database read; (b) ask
  Alchemy's NFT API per wallet on demand, with caching; (c) `balanceOfBatch` per wallet over all known token ids.
  Recommended: (a), since it's provider-independent and makes the public page cheap; whichever is chosen must handle
  the free-RPC log-range limit and reorgs (Polygon confirmations are already defined per chain).
- API shape, caching times, pagination (expect tens, not thousands, per wallet), empty and error states, exact copy.
- Exact medal styling within the anti-goal "Collected and Hosting never look alike".

## Settled after the builder check (Claude's calls; the owner can change any)

1. **Which contracts.** Every contract Virvi has used as the shared contract on the configured chain counts as
   **Basic**, including retired ones (a BEAT row's `contract_address`). Retired BEATs still show in collections: the
   tokens still exist and people still hold them. Index the set of contract addresses found in `beats` for the chain
   (today one on mainnet), each from its own first BEAT's block. **Custom** stays empty until host contracts exist.
2. **Which tokens show.** Only tokens that have a `beats` row on that contract (Virvi only mints for its own rows, so a
   token without one shouldn't exist; skip it if it does). Any status counts once a token exists (live, ended,
   closed, cancelled after minting): holding is a fact on chain.
3. **Earned after a claim is unlinked** (privacy deletion of a minted claim). The row keeps its `wallet` (it's public
   on chain), so the BEAT still shows as **Earned** for that wallet, but the detail shows no claim time and nothing
   personal. This leaks nothing new: a BEAT minted straight to a wallet by Virvi's minter is visible on Polygonscan
   anyway.
4. **Quantity above 1.** One tile per token per wallet: Earned if that wallet has a minted claim for it, with the
   quantity shown (for example Earned ×2).
5. **Index lag and reissues.** The held index follows Transfer events at the chain's confirmation depth (the same one
   minting and the reissue watcher use), so a reissue shows up as the old wallet's balance going to 0 and the new
   one's going up. A lag of up to a few minutes between chain and page is fine. A reissued claim is Earned for the
   new wallet (its `wallet` is the new one after the reissue).
6. **Public endpoint responses.** Any well-formed address returns 200 with its BEATs (possibly none); the response is
   the same shape whether or not the wallet belongs to a Virvi account, and contains nothing account-related (no
   names, no user ids, no other wallets). Earned is shown regardless: as in 3, it's derivable from public mints.
7. **Dates.** A from/to range on the event's start (`starts_at`); newest event first everywhere.
8. **Network.** The configured chain only (`BEAT_CHAIN`); no chain in the URL. Amoy BEATs never show on mainnet.
