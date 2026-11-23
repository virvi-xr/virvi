---
title: Drops
description: Give away wearables automatically. A visitor claims in your scene and the wearable is sent to their wallet while you are away.
---

A **Drop** is a giveaway of wearables from your own Decentraland collection. A visitor in your scene claims it, and the wearable is sent straight to their wallet. You don't have to be there, and you never hand anything over yourself.

**Words used here:**
- **Wallet:** an account on the blockchain, with an address starting `0x`.
- **Minter:** a wallet that is allowed to create (mint) new copies of your wearables.
- **Polygon:** the blockchain Decentraland wearables live on. **POL** is the coin used to pay the small network fee (called gas) for each send.
- **Builder:** the Decentraland Builder, where you manage your collections.

Wearables are only created when someone claims, so nothing is sent ahead of time and nothing you already own is moved.

## How it works

Every giveaway gets **its own wallet**, made by Virvi when you create it. Your collection stays yours. You do two things:

1. Allow the giveaway's wallet to mint your wearables.
2. Make sure it can pay the network fee (see [Paying the fee](#paying-the-fee)).

When a visitor claims, Virvi mints one of each item in the giveaway to that visitor's wallet. The giveaway's private key never leaves Virvi, and nobody can export it.

## Creating a giveaway

1. In the dashboard, go to **Drops** and create a giveaway.
2. Set:
   - **Name.**
   - **Items:** choose the wearables to give away, from collections you created. They are found through the wallets linked to your account, so link the wallet that created the collection first. A visitor gets **one of every item** in the giveaway.
   - **Starts** and **Ends** (optional). Leave them empty to start when you switch it on and run until you switch it off.
   - **Claim limit** (optional): the most people who can claim. Leave it empty for no limit.
   - **Minimum minutes in the scene** (optional): how long a visitor must stay in your scene before they can claim.
   - **Scenes:** the scenes where visitors see the giveaway.
3. Add the giveaway's wallet as a minter (next section), fund it if you need to, then switch the giveaway on.

## Letting the giveaway mint

The giveaway's page shows its wallet address, with buttons to copy it and to open it on Polygonscan. Next to each item you see whether it can be minted:

- **Can mint:** ready.
- **Add 0x1234…abcd as a minter in the Builder** (with the giveaway wallet's short address): the giveaway can't mint this item yet.
- **Sold out:** all copies of the item have been minted.

To add the minter:

1. Copy the giveaway's address from its page.
2. Choose **Open the Builder** next to the item to go to the collection.
3. In the collection's settings, add the address as a minter for the item (or for the whole collection) and confirm in your wallet.
4. Back on the giveaway's page, choose **Check again**.

The collection must be published and approved. You can switch a giveaway on only once every item shows **Can mint**. Until then visitors don't see it.

If you later take the minter right away, or it runs out, the giveaway pauses (see [Pauses](#pauses)).

## Paying the fee

Each send costs a little POL. How it's paid depends on your plan.

- **Free plan:** you send POL to the giveaway's wallet address yourself. The page shows the balance and about how many claims it covers. It warns you when the balance covers fewer than 10 claims.
- **Paid plans (Creator, Pro and Studio):** Virvi covers the fee. It keeps the giveaway's wallet topped up for you, with no monthly limit. The page says **Gas is covered by your plan.** If you also send POL, it stays yours.

If your paid plan ends, the giveaway goes back to the free-plan way: you fund it. POL that Virvi put in remains Virvi's and can't be sent back to you.

## Sending POL back

POL you sent that is left over can be returned. Choose **Send back** on the giveaway's page. It goes to a wallet you have verified on your account, picked from a list; you can't type an address. Link a wallet to your account first if you have none.

Only your own POL can be sent back. Fees Virvi covered are never part of it.

You can't delete a giveaway that still holds your POL. Send it back first (or leave it if it's too small to be worth sending).

## What visitors see

When a giveaway is open in a scene (switched on, inside its dates, with claims and wearables left), a **giveaway card** appears. It shows the items' names and pictures and what the visitor needs.

1. **Wallet:** the visitor needs a verified Decentraland wallet with a profile. Wallets Virvi has blocked can't take part, and very new wallets are limited per network, as for [BEATs](/docs/dashboard/beats/).
2. **Consent:** before anything is tracked the card says that Virvi will mint the wearables to the visitor's wallet (shown short, like `0x1234…abcd`) and that you can see that this wallet claimed. The visitor chooses **Agree and continue**.
3. **Minimum time:** if you set one, the card counts down the minutes while the visitor stays in the scene, then **Claim** becomes available.
4. **Claim:** after **Claim** the card shows **On its way**, then **Sent** with a link to the transaction.
5. **Stop tracking:** until they claim, the visitor can choose **Stop tracking** to go back to the consent step.

Each wallet can claim a giveaway once, however many accounts it uses. If a send fails for good, the card shows a short reason, such as "this giveaway ran out."

Virvi-built scenes get the card the next time they are redeployed. A scene you build yourself with `@virvixr/dcl` needs version 2.18.0 or later.

## Following claims

The giveaway's page lists every claim with its status: waiting, minting, sent or failed. Sent claims have a Polygonscan link. Wallets are shown short. Totals are at the top.

## Pauses

Virvi pauses a giveaway rather than lose claims. The giveaway's status reads **Paused**, with the reason:

- **Paused: not enough POL for gas:** the wallet has too little POL. Send more. This also happens on a paid plan when the server has no gas cover set up yet; the page then says "Gas cover isn't set up on this server yet" and you fund the wallet yourself.
- **Paused: an item needs the minter step:** the giveaway's wallet can't mint an item. Add it as a minter in the Builder.
- **Paused: an item is waiting for curation:** the collection isn't approved yet. The page says **Waiting for curation**.
- **Paused: Polygon isn't answering:** the blockchain connection kept failing. Virvi keeps trying.

During these pauses visitors can still claim. Claims wait, the card shows **On its way**, and they are sent once the problem is fixed.

**Sold out** is final. If any item runs out, the giveaway closes to new claims, and claims still waiting fail with "Sold out" rather than sending part of the set.

## Ending a giveaway

Switch it off, or let its end date pass. When it ends, anything still waiting is sent first. Deleting it needs your leftover POL sent back first, and any claims still waiting are cancelled, so visitors' pending sends don't arrive.

## Not available

On a self-hosted server, automatic giveaways are off until the server has a wallet secret set. See [Environment variables](/docs/self-hosting/environment-variables/#wearable-giveaways).
