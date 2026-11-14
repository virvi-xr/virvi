---
title: BEATs
description: Give the people at your event a free token that shows they were there.
---

A **BEAT** is a free token that shows a visitor was at your event. Visitors who were in your scene long enough, and who choose to claim one, get it in their wallet. They never sign or pay anything. You pay a small fee per event.

**Words used here:**
- **Wallet:** a visitor's account on the blockchain, with an address starting `0x`. Visitors sign in to Decentraland with one.
- **Polygon:** the blockchain BEATs live on. A record of every BEAT is kept there in public.
- **Mint:** create a BEAT and put it in a visitor's wallet.

BEATs are being tested on Polygon Amoy, Polygon's practice network, and only Virvi admins can create them for now. Test BEATs are free.

## Creating a BEAT

1. In the dashboard, go to **BEATs** and choose **New BEAT**, or open a scene and choose **New BEAT** there.
2. Fill in:
   - **Name** (up to 60 characters) and **Description** (up to 500 characters).
   - **Artwork:** a square image, at least 512 × 512.
   - **Starts** and **Ends:** the event's time. It must start in the future and can run for up to 31 days.
   - **Minimum minutes present:** how long a visitor must be in the scene to claim. The default is 5 minutes; the most is 120.
   - **Scenes:** where the event happens. You need to be able to run events in each one. A scene can have one BEAT at a time.
   - **Supply cap:** the most BEATs that can be claimed, from 1 to 5,000. The default is 100.
   - **Tradeable:** whether holders can send their BEAT to another wallet. This can never change once you pay.
3. Review the price and pay by card, or with Virvi credit if you have enough to cover it.

## The price

The price covers your supply cap, and you see it before you pay. It's $5.00 for up to 100 BEATs, plus $0.02 for each one over 100. For example, a cap of 500 costs $13.00.

**Unclaimed BEATs aren't refunded.** You pay for the cap up front, whether or not everyone claims.

## After paying

- **Edit:** before the event starts, and before any BEAT is minted, you can change the name, description, artwork, times, scenes and minimum time.
- **Raise cap:** you can raise the supply cap at any time before the event ends. You pay the difference. The cap can't be lowered.
- **Cancel:** only before the event starts. You get a full refund: to your card, or as credit if you paid with credit.
- **End early:** once the event has started, it can't be cancelled, but you can end it now. Claims already made are still sent.

## What visitors see and agree to

Visitors in your scene see your BEAT on a card from 30 minutes before it starts. Only visitors signed in with a verified wallet can take part; a visitor without one is told once to connect a wallet. When a visitor presses **Track my attendance**, before anything is stored, they see and must agree to:

> To track your attendance for the {name} BEAT, Virvi stores your wallet address and display name for this BEAT. The hosts of this event will see them, and your wallet is needed to send you the token. You can stop tracking at any time before you claim.

`{name}` is your BEAT's name. Nothing is stored for visitors who don't agree.

Time only counts while the event runs, and time in all of the BEAT's scenes adds up. Once a visitor reaches the minimum time, they can press **Claim your BEAT** until 24 hours after the event ends. Their BEAT is then sent to their wallet, usually within a few minutes. A visitor can press **Stop tracking** at any time before they claim, which deletes what was stored.

## What you see

Open the BEAT in the dashboard to see how many have been claimed, are being sent, have arrived (minted), or failed, and the cap. The list of claimants shows each one's display name, wallet and status, with a link to the record on Polygonscan, Polygon's public explorer, once it arrives. **Copy wallets** copies every wallet address.

You and anyone who can run events in one of the BEAT's scenes can see this.

## Locked once minted

Once the first BEAT is minted, Virvi locks its name, description and artwork: neither you nor Virvi's dashboard can change them. (They're served by Virvi, not stored on the blockchain; see [The BEAT contract](#the-beat-contract).) Your artwork is copied when you pay, so deleting the original from your media library doesn't affect it.

## The BEAT contract

Every BEAT is made by one public Virvi contract on Polygon: a program on the blockchain that anyone can read. Its address is on the [Transparency page](/transparency/).

**What it does:**
- It sends each BEAT to a wallet **only once, ever**. Sending the same list again is safe: Virvi never sends anyone a second one. (If your BEAT is tradeable, a holder can still pass theirs to a wallet that already has one.)
- A BEAT that isn't tradeable can't be moved to another wallet by anyone.
- Only the holder can burn (destroy) their own BEAT.
- A BEAT can be closed by Virvi, after which no more of it can be minted. BEATs already in wallets stay where they are.

**What Virvi's admin can do:**
- Change the web address where every BEAT's name and image are looked up, including BEATs already given out. Names and images aren't stored on the blockchain, so how a BEAT looks can change. Who owns it can't.
- Add or remove the wallets that can create and send BEATs.
- Hand the admin role to another wallet. This takes two steps, with a wait (one day now) between them.

**What nobody can do:**
- Nobody but the holder, not Virvi and not you, can move, burn or take back a BEAT that's in someone's wallet.
- The contract can't be paused, upgraded or deleted, and it can't be paid or pay anyone out: sending POL to it fails.

The contract has been checked with an automatic tool, but no independent auditor has reviewed it.

## Deleting data

A visitor who deletes their Virvi data, or their account, loses everything stored for BEATs they haven't been sent yet. A BEAT that has already been minted stays in their wallet: the blockchain is public and can't be changed, so the token and its wallet stay visible to anyone. Virvi removes the link to their Virvi account and their display name. Their wallet address stays in your claimant list and on Polygon, because it's on the public blockchain. See [Privacy](/docs/privacy/).
