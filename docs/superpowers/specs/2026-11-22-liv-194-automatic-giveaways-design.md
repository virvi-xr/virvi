# Automatic wearable giveaways (LIV-194): design

Ticket: LIV-194. Owner decisions taken in chat on 2026-11-22 are marked **(owner)**. Calls I made are marked **(my call)**.

## Why

Virvi Drops (giveaways) today only store a giveaway and its items. Visitors can't claim anything, and nothing gets
sent. Raffles work, but the host hands out prizes by hand. Hosts want what Decentraland's own rewards tool does: a
visitor claims a wearable in the scene, and it is minted straight to their wallet while the host is away.

## How it works (owner)

Every giveaway gets **its own minting wallet**, which Virvi generates. The host:

1. adds that wallet as a **minter** on their collection in the Decentraland Builder; Virvi never holds the collection;
2. pays for gas, which depends on their plan (below).

Visitors claim in the scene, and Virvi mints from the giveaway's wallet with the collection contract's `issueTokens`.

## Goals

- A host creates a giveaway, picks items from collections they created, grants minting and funds it. All of it is on
  the Drops page, with every step checked on-chain.
- A visitor with a verified Decentraland wallet claims in the scene and gets the wearables minted to that wallet.
  There are no host clicks and no transfers of pre-minted tokens.
- Delivery is reliable: retries, gas checks, a pause when gas runs low, and a status per claim that the host can see.
- **Who pays gas (owner):**
  - **Free plan:** the host sends POL to the giveaway's wallet themselves.
  - **Paid plans (Creator, Pro, Studio):** Virvi covers gas. A Virvi "gas tank" wallet tops up the giveaway wallet
    automatically.
  - **No cap (owner):** there is no monthly limit on covered gas.
- The host can send leftover POL back to their own wallet.

## Non-goals and anti-goals

- **No key export (owner).** A giveaway wallet's private key never leaves the server, and no route returns it.
- **No transfers** of tokens the host already owns. Minting only.
- **No mainnet POL from Virvi to free-plan hosts.**
- **No other chains:** only Polygon and Amoy. Decentraland wearables live on Polygon; Amoy is for testing.
- **Anti-goal:** a visitor's wallet appearing in logs, or a key, a secret or calldata in errors (same rules as BEATs).
- **Anti-goal:** the gas tank paying for something that isn't a paid member's giveaway mint.

## Owner side (Drops page)

**A giveaway has:**

- name;
- chain: `polygon`, or `polygon-amoy` for Virvi admins only **(my call)**;
- enabled;
- optional start and end times;
- optional total claim cap;
- optional minimum minutes present in the scene;
- the scenes it shows in;
- one or more items.

**Wallet.** Created with the giveaway. The page shows:

- the address, with copy and Polygonscan buttons;
- the POL balance;
- about how many claims that covers, from the last gas estimate.

**Items:**

- Chosen from the host's own collections. These are listed through the Decentraland Marketplace API by the creator
  wallets linked to the host's account: `marketplace-api.decentraland.org` on Polygon and
  `marketplace-api.decentraland.zone` on Amoy.
- Each item is stored as `contractAddress` + `itemId`, with its name, thumbnail and rarity cached.
- The old `tokenId` field is dropped. There are no users yet, so nothing is migrated.

**Minter check, per item, read on-chain:**

- the collection is approved and completed;
- the giveaway wallet is a global minter, or holds an item minter allowance;
- remaining supply (`maxSupply - totalSupply`).

The page shows:

- "Can mint ✓";
- or "Add this address as a minter in the Builder", with a link to the collection in the Builder;
- or "Sold out".

**Funding:**

- **Free plan:** shows "Send POL to this address", with a low-balance warning when the balance covers fewer than 10
  claims.
- **Paid plans:** shows "Gas covered by your plan". If the host also sent POL, that shows as theirs.

**Send back:** sends the host's withdrawable POL to a wallet verified on their account, picked from a list. Never a
typed address. Withdrawable is:

```
max(0, balance - virviUnspent),  where virviUnspent = max(0, virviTopUps - gasSpent)
```

So gas is counted against Virvi's top-ups first, and Virvi's float is never paid out **(my call)**.

**Claims list:** status (waiting, minting, sent, failed), time, a Polygonscan link once sent. Wallets are shown short
(`0x1234…abcd`), as elsewhere. Totals at the top.

**Ending a giveaway:** disable it, or let its end time pass. Deleting a giveaway with POL left over is refused until
the balance is sent back, or is too small to be worth sending (under the gas of one transfer).

## Visitor side (in the scene)

This follows the BEAT card: same pass, verified wallet and platform checks, consent pattern and anti-bot limits.

1. While a giveaway linked to the scene is open (enabled, inside its window, supply and cap left, minting possible),
   the scene shows a giveaway card: the items' names and thumbnails, and what's needed to claim.
2. The visitor needs a verified Decentraland wallet with a profile. Blocked wallets and the per-network new-wallet
   limit apply, as for BEATs.
3. **Notice and consent:** "Virvi will mint these to your wallet <short>. The host sees that this wallet claimed."
   Agreeing is recorded with a consent version.
4. If a minimum time is set, the card counts down using the same presence check-ins BEATs use, then enables Claim.
5. Each wallet claims a giveaway once, whichever Virvi account it's on.
6. Claim → "On its way" → "Sent ✓" with a link. A failure that will be retried shows "Still sending". A final failure
   shows a short reason.

**One claim = one of every item (owner),** in a single `issueTokens` call, with the visitor's wallet repeated once
per item. If any item can no longer be minted (sold out, minter removed), the giveaway closes for new claims. Claims
already queued fail with a clear reason instead of minting part of the set **(my call)**.

**Shipping:** Virvi-built scenes get the card from a runtime version bump on their next redeploy. Scenes that install
`@virvixr/dcl` themselves need a package release, which the owner publishes.

## Minting job

A background job on one instance, behind an advisory lock, modelled on the BEAT job (`apps/server/src/beats/job.ts`).

**Per giveaway wallet, at most one transaction open at a time.** Each pass:

1. **Reconcile** the open transaction: receipt with confirmations, a nonce taken by a hash we lost, a crash before
   broadcast, a reprice.
2. **Batch** waiting claims into one `issueTokens` call, up to a limit per transaction. Write the signed raw
   transaction before broadcasting, so a crash never loses a nonce.
3. **Check gas** before signing: the wallet needs the estimated cost plus headroom.
   - **Paid owner:** ask the gas tank for a top-up first. The tank tops the wallet up to a small float (about 50
     claims' worth); it never sends large amounts.
   - **Free owner:** pause the giveaway as `low_gas`, and show it on the Drops page.
4. **Results:** read the receipts' `Issue` logs and mark each claim sent, with its token id and transaction hash.
   - A revert pauses the giveaway with a reason: `not_minter`, `sold_out`, `not_approved`.
   - An RPC failure counts toward a pause, as for BEATs.

**Gas tank:**

- One Virvi wallet per chain, key `GIVEAWAY_GAS_KEY`.
- Top-ups happen only while the giveaway owner's subscription is active on a paid tier. Admins count as paid.
- Every top-up is recorded (giveaway, amount, tx hash).
- When the tank's balance drops below a floor (`GIVEAWAY_GAS_TANK_MIN_POL`), Virvi admins are warned through the job
  failures they already see, and top-ups stop rather than drain the tank to zero.

**Hosts who stop paying:** when a host's subscription ends, their giveaways fall back to free-plan funding. Virvi's
unspent float stays in the wallet and is never withdrawable by the host.

## Keys and secrets

- Each giveaway wallet's private key is generated server-side. It is stored encrypted with AES-256-GCM under
  `GIVEAWAY_WALLET_SECRET`, using the same pattern as Hyperfy admin codes (`hyperfy/hosting.ts`). Only the address
  is in plain text.
- **The owner sets both Railway secrets (owner):** `GIVEAWAY_WALLET_SECRET` and `GIVEAWAY_GAS_KEY`. Losing
  `GIVEAWAY_WALLET_SECRET` loses every giveaway wallet's POL, so it must be backed up (1Password).
- **Without `GIVEAWAY_WALLET_SECRET`:** automatic giveaways are off. The Drops page says so, and the server starts
  normally.
- **Without `GIVEAWAY_GAS_KEY`:** paid hosts fall back to funding their own giveaway wallet, with a note on the page.
- Decrypted keys live only inside an ethers `Wallet` while signing.

## Assistant

The show job's wearable step offers an automatic giveaway in place of the raffle stand-in. It creates the giveaway
and links it to the scene. It shows the minter address and the Builder step for the owner to do. It never moves POL.

## Settled after the builder check (my calls)

1. **Scenes.** A giveaway links to scenes directly, through a new `giveaway_scenes` table modelled on `beat_scenes`.
   That's how the scene runtime finds an open giveaway. The `event_giveaway_links` table and its uses stay as they
   are.
2. **Organisations.** Whoever created the giveaway (`ownerId`) decides everything:
   - their plan decides whether the tank tops up;
   - their linked creator wallets list the collections;
   - their verified wallets are where "Send back" can pay out.

   An org member on a paid plan is covered. A giveaway created by a free member is not.
3. **Who paid for each transaction.** Each mint transaction records whether its gas was covered: the owner was
   paying when it was signed and the tank had topped up.
   - **Covered gas** comes out of Virvi's float. **Uncovered gas** comes out of the host's POL first.
   - **Withdrawable:** `balance − virviUnspent`, where `virviUnspent = max(0, topUps − coveredGas)`.
   - **When a giveaway is deleted:**
     1. The host's withdrawable POL must be sent back first. Deletion is refused until it has been, unless it's
        under one transfer's gas.
     2. The job then returns Virvi's unspent float to the tank.
     3. Only then is the row soft-deleted and its encrypted key wiped.
   - **When a giveaway ends:** the same return to the tank happens after its last claim settles.
4. **Pauses:**
   - **Pauses that recover:** `not_minter` (minter removed or allowance used up), `not_approved`, `low_gas`,
     `rpc_down`. Claims already queued stay waiting and mint once it's fixed. Visitors see "Still sending".
   - **Sold out is final.** Claims queued past the remaining supply fail with "Sold out".
   - **Supply is held back** for queued claims, so the card never takes more claims than the supply allows.
5. **The card while paused.** The card keeps taking claims during the recoverable pauses: they queue and show "On its
   way". It hides only when the giveaway is disabled, outside its window, at its cap or sold out.
   - **Before the first mint:** a giveaway can only be switched on once every item passes the on-chain minter check.
     Until then the card doesn't show.
6. **Assistant.** An automatic giveaway sits beside the raffle as a choice, and the assistant recommends it when the
   host has a collection.
   - It creates the giveaway switched off, with the show's detected wearable as the item, and links it to the
     scene.
   - It tells the host the minter address and the Builder step.
   - The host switches it on from the Drops page once the check passes. The assistant can't skip that check.

## Left to the builder

- Table and column names, batch size, confirmations and reprice timings (BEAT values are the default).
- The card's exact layout, as long as it matches the BEAT card's look.
- How the Marketplace item list is cached.

## Checks before release

- A spike on Amoy: a test collection, the giveaway wallet added as a minter, one `issueTokens` claim end to end.
- The full server and web suites.
- A whole-branch review.
