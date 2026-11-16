---
title: BEATs
description: Give the people at your event a free token that shows they were there.
---

A **BEAT** is a free token that shows a visitor was at your event. Visitors who stay in your scene long enough, and who choose to claim one, get it in their wallet. They never sign or pay anything. You pay a small fee per event.

**Words used here:**
- **Wallet:** a visitor's account on the blockchain, with an address starting `0x`. Visitors sign in to Decentraland with one.
- **Polygon:** the blockchain BEATs live on. A record of every BEAT sent is kept there in public, for good.
- **Send (mint):** create a BEAT and put it in a visitor's wallet. The page calls a BEAT that has arrived **Delivered**.

BEATs are being tested on Polygon Amoy, Polygon's practice network, and only Virvi admins can create them for now. Test BEATs are free, and show the badge **Test BEAT (practice network)**. A host who can't create BEATs yet sees "Only Virvi can create BEATs for now. Contact us to try one:" with our support address.

## What a BEAT proves

A BEAT shows that **a wallet that signed in from the scene and stayed connected for the minimum time** claimed it. It doesn't prove that a real, single person was there: someone can make many wallets, and Decentraland can't tell Virvi for certain where an avatar really is.

To make faking it harder, Virvi:
- counts time only while the visitor's scene is connected to Virvi's live room for that scene, not just while their wallet checks in;
- needs the wallet to have a Decentraland profile (an avatar);
- allows only a few claims per network (currently 3) for each BEAT (a network is one internet address, or one block of addresses for IPv6);
- allows at most 10 new wallets (ones Virvi first saw in the last day) per network per hour to track or claim BEATs;
- lets you check claims before they are sent, and remove any you don't recognise (see [Checking claims before they are sent](#checking-claims-before-they-are-sent)).

If your BEAT gives people something valuable (a whitelist place, a prize), check the claims before you send them.

## Creating a BEAT

1. In the dashboard, go to **BEATs** and choose **New BEAT**, or open a scene and choose **New BEAT** there.
2. Fill in:
   - **Name** (up to 60 characters) and **Description** (up to 500 characters). The description is public once the BEAT starts and stays with the token, so don't put anyone's personal details in it.
   - **Artwork:** "Square, at least 512 × 512". Choose **Pick image** to pick one from your media library.
   - **Starts** and **Ends:** the event's time. It must start in the future and can run for up to 31 days.
   - **Minimum minutes present:** how long a visitor must be in the scene to claim. The default is 5 minutes; the most is 120. "0 means anyone who agrees can claim once it starts."
   - **Scenes:** where the event happens. You need to be able to run events in each one. A scene can have one BEAT at a time.
   - **Where is it?:** **In my Virvi scenes** (the default: the token names your scene, with its World name or coordinates), **Online, on another platform** (a **Platform name** and an **Event link**), or **In person** (a **Venue name**, **City or region**, **Country**, and optionally a **Street address** and a **Map link**). Links must start with `https://` or `http://`. For online and in-person events the form says: "People claim this BEAT in your Virvi scene. Ways to claim in person or on other platforms are coming."
   - **Supply cap:** from 1 to 5,000, 100 by default. "The most BEATs that can be claimed. You pay for this many up front. You can raise it later, never lower it."
   - **Tradeable:** "Holders can send it to other wallets. You can't change this once the BEAT starts."
   - **Check claims before they are sent:** "Claims wait for you to press Send on this page, so you can remove any you don't recognise first. If you don't, they're sent anyway 24 hours after the end."
3. Choose **Review**. The review step sums up what is fixed once the BEAT starts (for example "Supply cap 500 · Tradeable: No · 3 scenes · Starts …"), then shows the price. Pay with **Pay with card**, or **Use credit** if your Virvi credit covers it. When it doesn't, the page says how much credit you have. A test BEAT has **Create test BEAT** instead.

A BEAT you haven't paid for shows as **Draft**, with a **Pay** button.

## The price

The price covers your supply cap, and you see it before you pay. It's $5.00 for "Up to 100 BEATs", plus $0.02 for each one over 100 (for example "400 more BEATs"). A cap of 500 costs $13.00. Raising the cap shows as "Raise from 100 to 200 BEATs".

Card payments start at $0.50, so a small raise by card is refused with how many more BEATs to add; Virvi credit pays any amount.

**Unclaimed BEATs aren't refunded.** You pay for the cap up front, whether or not everyone claims.

### Back from Stripe

- "Payment received. Confirming it…" while Stripe tells Virvi, then "Payment received."
- "Payment cancelled. You haven't been charged. Choose Pay to try again."
- After 5 minutes without a confirmation: "Stripe hasn't confirmed your payment yet. This can take a few minutes. If it is still waiting after 10 minutes, contact support@virvi.io and quote this BEAT's name. Don't pay again."

## Statuses

- **Draft:** "Created, not paid for yet. Choose Pay when you're ready."
- **Paid:** "Paid, waiting for its start."
- **Live:** "Running now."
- **Ended:** "Over. Visitors who stayed long enough can still claim for 24 hours."
- **Cancelled:** "Cancelled and refunded."

## After paying

- **Edit:** before the event starts you can change the name, description, artwork, times, scenes, place, minimum time, Tradeable and **Check claims before they are sent**. The supply can't be changed after paying: "To allow more BEATs, use Raise cap."
- **Raise cap:** at any time before the event ends. You pay the difference. The cap can't be lowered.
- **Cancel:** before the event starts. You get a full refund, and the page says "Cancelled. Your refund is on its way: to your card (it can take a few days), or straight back to your Virvi credit if you paid with credit." Cancelling deletes what visitors' tracking stored. A draft can be deleted (**Cancel**, "Delete this draft?") at any time.
- **End early:** once the event has started it can't be cancelled, but you can end it now. Claims already made are still sent. The token keeps the time you scheduled as its end and adds the time it really ended.
- **Send claimed BEATs** and **Remove:** see [Checking claims before they are sent](#checking-claims-before-they-are-sent).
- **Change image:** if Virvi can't use your image for the token, the page says "We couldn't use this BEAT's image for the token: it may have been deleted, or it can't be read. Pick another image with Change image. Nothing is sent until it works." This is the only change allowed after the start.

## Locked once it starts

When the event starts, the BEAT goes on Polygon and "its name, description, Tradeable setting, location and times are locked: they're part of the token now." Neither you nor Virvi's dashboard can change them after that. (They're served by Virvi, not stored on the blockchain; see [The BEAT contract](#the-beat-contract).)

Your artwork is copied when you pay, and again if you change it, as a WebP image of at most 1024 × 1024. Deleting the original from your media library doesn't affect it, and while a BEAT is paid for or running its artwork can't be deleted from the library: "This image is the artwork of a BEAT that is paid for or running, so it can't be deleted until that BEAT has ended."

## What the token shows

Wallets and marketplaces show each BEAT's name, artwork and description, and these details:
- **Starts** and **Ends** (and **Ended early** when you ended it early);
- **Tradeable** (Yes or No) and **Transfers** ("Transferable", or "Non-transferable (soulbound)");
- **Location type** ("Virtual" for scene and online events, "In person") and **Location** (the place's short label);
- **Supply**, **Minimum minutes** and **Network**.

The description gets a "Where:" line with the place, and a BEAT that isn't tradeable ends with "This BEAT can't be sold or transferred. It stays in the wallet it was sent to." Marketplaces may still show a Sell button for it; selling or sending it fails.

## What visitors see and agree to

Visitors in your scene see your BEAT on a card from 30 minutes before it starts. The card says "Stay for 5 minutes to earn the BEAT." (or "Be there to earn the BEAT." for 0 minutes), and before the start "It starts at 6:00 PM UTC, and your time counts once it starts." Times on the card are in UTC. A test BEAT adds "This is a practice BEAT."

Only visitors signed in with a verified wallet can take part. A visitor without one is told once: "Sign in to Decentraland with a wallet to earn this BEAT. Guests can't."

When a visitor presses **Track my attendance**, before anything is stored, they see this and choose **I agree** or **Cancel**:

> To track your attendance for the {name} BEAT, Virvi stores your wallet address, your display name and how long you're here. The scene checks in every 30 seconds while you're in it. The hosts of this event will see your name, wallet and time. If you claim, your wallet, this BEAT and the time it was sent are recorded on Polygon, a public blockchain: anyone can see that record, and nobody can delete it. You can stop tracking at any time before you claim, which deletes what was stored.

`{name}` is your BEAT's name. Nothing is stored for visitors who don't agree.

**Your scene needs `@virvixr/dcl` 2.17.0 or later** to track BEATs, because it shows the text above. In a scene built with an older version, every **Track my attendance** is refused: visitors see "This BEAT's terms have changed. Reload the scene and try again." (newer scenes say "This scene needs an update before you can claim. Ask the host to update it."). Reloading doesn't help. Update the package and redeploy the scene before your BEAT's card appears. Scenes Virvi deploys for you get the new version when they're redeployed.

Time only counts while the event runs ("Time counts while the event is running."), and time in all of the BEAT's scenes adds up. Once a visitor reaches the minimum, the card says "You've been here long enough. Claim your BEAT before {date and time}." and offers **Claim your BEAT** until 24 hours after the event ends. **Stop tracking** stays on the card until they claim, including when the BEAT is sold out or over; then the card also says "Your wallet and name are still saved for this BEAT. Stop tracking to delete them."

After a claim the card says one of:
- "Sending your BEAT. This usually takes a few minutes, and you can leave the scene."
- When you check claims first: "The host checks claims before they're sent. Your BEAT is sent once they do, by {date and time} at the latest. You can leave the scene."
- "Your {name} BEAT is in your wallet", with **See it on Polygonscan**.
- "We couldn't send your BEAT yet. We'll keep trying, so check back later."
- When it will never work (for example a wallet that can't accept BEATs): "We couldn't send this BEAT to your wallet, and we've stopped trying. Please ask the event host for help."
- When you removed the claim: "The event host removed your claim, so this BEAT won't be sent to you. Ask the host if you think this is a mistake."

## What you see

Open the BEAT in the dashboard to see **When**, **Claiming** ("Visitors can claim until …"), **Minimum time in scene**, **Where**, **Scenes**, **Tradeable** and **Check claims first**, and the counts: **Claimed (waiting to send)**, **Sending**, **Delivered**, **Failed** and **Cap**, with "N of M used". "Failed claims are retried automatically. A wallet that can't accept BEATs stays failed."

The list is headed "Attendees (N): X claimed, Y still attending". It shows each visitor's display name, wallet and status (**Attending**, **Claimed**, **Waiting for your Send**, **Sending**, **Delivered**, **Failed** or **Removed by you**), with a **View** link to the record on Polygonscan, Polygon's public explorer, once it's delivered. A BEAT that Virvi sent again to a visitor's new wallet, because their old one was lost or stolen, is marked **Reissued**, with a **Reissue** link. **Copy wallets that claimed** copies the wallet of everyone who claimed, one per line; visitors still attending aren't included.

You and anyone who can run events in one of the BEAT's scenes can see this. Visitors' wallets show here even when the scene's wallet visibility (for analytics) is off, because they agreed to it for the BEAT.

## Checking claims before they are sent

With **Check claims before they are sent** on, claims wait for you. Once the BEAT has started the page says how many are "waiting for your Send". Remove any you don't recognise with **Remove** (that wallet can't claim this BEAT again, and the BEAT goes back into the supply), then press **Send claimed BEATs**. A Send covers the claims made so far; later claims wait for another Send. Claims you don't send go out anyway 24 hours after the end.

## The BEAT contract

Every BEAT is made by one public Virvi contract on Polygon: a program on the blockchain that anyone can read. Its address is on the [Transparency page](/transparency/).

**What it does:**
- It sends each BEAT to a wallet **only once, ever**. Sending the same list again is safe: Virvi never sends anyone a second one. (If your BEAT is tradeable, a holder can still pass theirs to a wallet that already has one.)
- A BEAT that isn't tradeable can't be moved to another wallet by anyone.
- Only the holder can burn (destroy) their own BEAT.
- A BEAT can be closed by Virvi, after which no more of it can be minted. BEATs already in wallets stay where they are.

**What Virvi's admin can do:** on Polygon the admin is a Safe multisig: two of its three signers must approve every change.
- Change the web address where every BEAT's name and image are looked up, including BEATs already given out. Names and images aren't stored on the blockchain, so how a BEAT looks can change. Who owns it can't.
- Add or remove the wallets that can create and send BEATs.
- Send a BEAT again to a new wallet when a visitor's old one was lost or stolen (a reissue). The old copy stays in the old wallet but can never move again.
- Hand the admin role to another wallet. This takes two steps, with a wait (one day now) between them.

**What nobody can do:**
- Nobody but the holder, not Virvi and not you, can move, burn or take back a BEAT that's in someone's wallet.
- The contract can't be paused, upgraded or deleted, and it can't be paid or pay anyone out: sending POL to it fails.

The contract has been checked with an automatic tool, but no independent auditor has reviewed it.

## A lost or stolen wallet

A visitor whose wallet was lost or stolen can ask Virvi to move their BEATs to a new wallet, in **Settings**, under **Move my BEATs to a new wallet**. They must sign in with their new wallet or their email (not the old wallet), the new wallet must already be linked to their account, and a BEAT can only be moved after its event has ended. A person at Virvi checks every request. Approving blocks the old wallet from Virvi and removes the account's API keys and paired devices. The move is recorded on Polygon in public. While a request is open, deleting their data or their account is refused from a session signed in with the old wallet, or from an API key: "You can't do this while signed in this way. Sign in another way, with your new wallet or your email, and try again."

## Deleting data

A visitor who deletes their Virvi data, or their account, loses everything stored for BEATs they haven't been sent yet. A BEAT that has already been sent stays in their wallet: the blockchain is public and can't be changed, so the token and its wallet stay visible to anyone. Virvi removes the link to their Virvi account, their display name and how long they were there. Their wallet address stays in your list and on Polygon, because it's on the public blockchain.

Data of visitors who tracked but never claimed is deleted 30 days after the BEAT ends. See [Privacy](/docs/privacy/).
