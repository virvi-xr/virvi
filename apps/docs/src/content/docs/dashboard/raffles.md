---
title: Raffles
description: Run a free raffle in your scene, pick winners with a draw anyone can replay, and deliver the prizes.
---

A **raffle** lets visitors in your scene enter for a prize, then picks winners on a wheel that everyone in the scene sees. Raffles are free to enter. The scene's host, co-hosts and editors can run one, from the **Raffles** tab of the scene in the dashboard.

## Running a raffle

1. Open the scene and go to **Raffles**, then choose **New raffle**.
2. Fill in:
   - **Name** (up to 80 characters) and **Prize** (up to 200 characters).
   - **Winners**: 1 to 20.
   - **Mode**: **One entry per person**, or **Weighted by time present** (see below).
   - **Minimum minutes present**: how long an entrant must have been in the scene to qualify. The default is 5 minutes; the most you can set is 120.
   - **Auto-snapshot**: off, or every 5, 10, 15 or 30 minutes.
   - **Rules**: a template is filled in for you. Edit it to match your giveaway.
3. Tick the host terms: *This raffle is free to enter and needs no purchase. I'm responsible for following the giveaway and sweepstakes rules where I and my entrants live, and for delivering prizes.*
4. Create the raffle, then press **Open**. A scene can have one running raffle (open or drawn) at a time; close it before opening another.

You can edit a raffle while it is a draft or open: open it and press **Edit**. The fields are the same as when you created it. The mode can't change once a snapshot exists.

### Snapshots and the minimum time

While the raffle is open, entrants' scenes check in every 30 seconds. A snapshot records who is **present right now**: entrants who checked in within the last minute and have been present at least the minimum time. Time present is counted from check-ins, and each check-in adds at most 45 seconds, so someone who goes quiet doesn't keep earning time.

Press **Snapshot** whenever you want to record who is there, or use auto-snapshots. **A spin only counts entrants who appear in a snapshot.** If there are no snapshots, or nobody in them qualifies, the spin is refused with "Nobody qualifies for this draw" and nothing is picked.

### Drawing

Press **Spin**. Every visitor in the scene sees the wheel land. The wheel shows up to 60 names (always including the winners), and the rest of the pool is shown as a count. The first spin picks all of the raffle's winners and closes entry. You can spin again, for example when a winner doesn't claim their prize: a re-spin picks **one** replacement by default, and earlier winners are left out. A spin within 15 seconds of the last is refused. Before a spin you can change **Winners this spin** (1 up to the raffle's number of winners). The in-world Raffle tab always uses the default.

- **One entry per person:** every qualifying entrant has one ticket.
- **Weighted by time present:** each entrant has one ticket for every snapshot they were in, counting only the snapshots chosen for that spin.

By default a spin uses all snapshots; untick any under **Snapshots to draw from** to leave them out. Entrants who withdrew are never drawn.

### Closing

Press **Close** when you are finished, or **Cancel** for a raffle you will not draw. Both ask you to confirm first. A raffle left running is closed for you 7 days after its last draw, or 30 days after it opened.

## What entrants see and agree to

Only visitors who are signed in with a verified wallet can enter, and only from inside the scene. Guests can watch but not enter. Before entering they see and must agree to:

> Your display name (or a shortened wallet address if you have no name) will be shown on the raffle wheel to everyone in this scene, and your name and wallet will be shared with the host so they can deliver your prize. You can withdraw until the draw.

They can also read your rules. Names are cleaned up to at most 40 characters. Entrants can withdraw while the raffle is open or drawn, and a withdrawn entry is deleted. A withdrawn winner stays in that draw's record, shows as "Removed entrant" and is left out of later draws.

## Delivering prizes

Open the raffle in the dashboard. Winners are listed with their name and wallet address, with a **Copy** button for the wallet. Delivering each prize is up to you; the default rules promise delivery within 30 days. Winners also see that they won in the scene.

A raffle's entries, with their names and wallets, are deleted 30 days after the raffle ends, so deliver and save what you need before then.

## Verifying a draw

Every draw keeps a record. In the raffle's **Draws** list, choose **View record** to see the algorithm version, the seed, the mode, the snapshots used, the pool (each entry id with its tickets) and the winners. The seed is chosen at random at the moment of the draw and is only recorded with the result. You can share the record with your entrants. The record uses anonymous entry ids, not names, and keeps working after entrants are deleted (they show as "Removed entrant").

### Algorithm v1

The pool is a list of `(entryId, tickets)` sorted by entry id (plain string comparison). One-per-person gives every entry 1 ticket; weighted gives each entry one ticket per snapshot it was in (counting only the snapshots chosen for the spin). Entries of earlier winners, and withdrawn entries, are removed first.

To pick winners, repeat for `k = 0, 1, 2, ...` until you have the number of winners the spin asked for or the pool is empty (to check a record, use the length of its `winnerEntryIds`):

1. Compute `HMAC-SHA256(key = seed bytes, message = "virvi-raffle:<drawId>:<k>")`. The seed is 32 bytes, given as hex in the record. The draw id is the record's `id`.
2. Read the first 8 bytes as an unsigned big-endian integer `r`.
3. Let `total` be the tickets left in the pool. If `r >= floor(2^64 / total) * total`, discard this `k` and move to the next (rejection sampling, so there is no modulo bias).
4. Otherwise let `x = r mod total`. Walk the pool in order, subtracting each entry's tickets from `x`; the first entry where `x` is less than its tickets wins.
5. Remove the winner and all of its tickets from the pool, and continue.

Winners are in draw order (the first is the one the wheel lands on). The `k` counter keeps going up, including after a rejection.

**Test vector:** seed `0000000000000000000000000000000000000000000000000000000000000000` (32 zero bytes), draw id `d1`, pool `a:1, b:1, c:1`, 3 winners gives **b, a, c**.
