# Raffle wheel (LIV-55): design

Linear: LIV-55. Decisions from the owner (2026-11-13) are marked **[owner]**. Calls I made are marked **[my call]**.

## Why

Hosts want giveaways that reward people for being at an event, run fairly and in front of the crowd. Virvi's privacy promise says visitors are stored as a per-scene pseudonym unless the owner turns on wallet visibility. So a raffle can't identify people from analytics data. Visitors opt in to each raffle, and only those who opt in are named.

The "who was here during this window, and for how long" logic is built once, so BEAT (LIV-11) can reuse it for its opt-in claims and minimum time in the scene.

## Goals

- A host creates a raffle, visitors with a verified wallet opt in from inside the scene, and the host takes snapshots of which entrants are present.
- The server draws the winners fairly, and everyone in the scene watches a wheel spin to them.
- The host gets the winners' names and wallets to deliver prizes by hand.
- Entrant data is consented to, limited to the raffle, deletable, and removed on a schedule.

## Non-goals (v1)

- Automatic prize delivery (NFTs or tokens). That comes later with BEAT's minting service. **[owner]**
- Guests (visitors without a wallet) entering. They see how to qualify. **[owner]**
- Raffles on platforms other than Decentraland (Hyperfy, AR). The server API is platform-neutral, but the v1 in-world UI is Decentraland only. **[my call]**
- Email or inbox notifications (LIV-30). The winner is told in-world and on their raffle entry.
- Reusing the old `giveaways` tables. They're an unrelated, owner-level item-claim feature, so raffles get their own tables. **[my call]**

## Anti-goals (would make it a failure even if it works)

- A visitor is named or has their wallet stored without opting in to that raffle.
- A client can influence who wins.
- One person enters more than once, or farms entries without being there.
- A raffle changes analytics' privacy behaviour, such as turning on wallet visibility.

## Who can do what

- **Run raffles** (create, edit, open, snapshot, draw, close): the scene's owner, cohosts and admins, plus editors. This uses a new scene scope, `raffle.run`. It's in `ALL_SCOPES` and `EDITOR_SCOPES` in `apps/server/src/auth/permissions.ts`, and it isn't a venue scope. Booking-grant holders and viewers don't get it. **[my call: editors already run the scene's live content]**
- **See winners' wallets:** anyone with `raffle.run`.
- **Enter:** a visitor whose scene pass is verified (not a guest), for that scene.

## Lifecycle

A raffle moves through these statuses:

`draft` → `open` (entry allowed, snapshots allowed) → `drawn` (at least one draw done; more draws allowed for re-spins) → `closed`

A draft or open raffle can be `cancelled`.

1. **Create** (`draft`), from the dashboard or the HUD. The host gives:
   - a name;
   - a prize description;
   - optional rules text, prefilled from Virvi's editable official-rules template;
   - the number of winners, 1 to 20;
   - the draw mode: `one_per_person` or `weighted`;
   - an optional minimum time present, in minutes;
   - an optional auto-snapshot interval: off, or 5, 10, 15 or 30 minutes.

   The host must also tick the host terms: free to enter, no purchase necessary, and the host is responsible for following local sweepstakes and giveaway rules. The acceptance is stored with its time. **[owner]**
2. **Open** (`open`). Everyone in the scene with the Virvi HUD runtime sees a raffle card: the name, the prize, **Enter**, and a "rules" link. Guests see "Sign in with a wallet to enter".
3. **Enter.** Before the visitor confirms, the consent text says exactly what's shared: *"Your display name will be shown on the raffle wheel to everyone in this scene, and your name and wallet will be shared with the host so they can deliver your prize. You can withdraw until the draw."* **[owner: names on the wheel]** An entry stores the wallet, display name, user id, the consent time and the consent text's version. There's one entry per wallet per raffle, enforced by a unique index. A visitor can withdraw at any time before their raffle is drawn; withdrawing deletes the entry.
4. **Presence.** While an entrant is in the scene, their runtime checks in every 30 s (`POST /api/raffles/:id/presence`). The server adds the time since the last check-in to the entry's total time present (capped at 45 s per check-in, so a gap isn't counted) and updates when it last saw them. This is the shared presence piece. See "Shared presence" below.
5. **Snapshot.** The host presses **Snapshot**, or the auto-interval fires. A snapshot records the entrants seen in the last 60 s who have also met the minimum time present. It stores who was in it, plus a count.
6. **Draw.** The host picks one or more snapshots (default: all of them) and presses **Spin**. The server:
   - builds the pool:
     - **one per person:** each entrant in any chosen snapshot, once;
     - **weighted:** one ticket for each chosen snapshot the entrant appears in;
   - leaves out anyone who has already won this raffle;
   - picks the winners with `crypto.randomInt` from a seed drawn with `crypto.randomBytes(32)`, using a deterministic, published procedure (sort the pool by entry id, then a seeded draw), so anyone can replay a draw from its record;
   - stores the draw: the snapshot ids, the mode, the pool with each entry's ticket count, the seed, the winners and the time;
   - then broadcasts the result. The animation only shows a result already decided.
7. **Re-spin.** The host can draw again, for example when a winner has left or doesn't claim. Each draw is its own record, and earlier winners stay excluded. **Close** ends the raffle (`closed`).
8. **After.** On the dashboard the host sees:
   - every draw, with the winners' names and wallets;
   - a copy button for each wallet;
   - each draw's record, viewable as JSON.

   On their own raffle entry, the winner sees "You won". They're also told in-world at the moment of the draw.

## Shared presence (for BEAT too)

A small module, `apps/server/src/presence/attendance.ts`, with a table of entrant check-ins. Raffles use it now and BEAT will later.

- `recordCheckIn(subjectId, now)`: updates `lastSeenAt` and adds the capped interval to `secondsPresent`.
- `presentAt(subjects, now, { withinMs, minSeconds })`: the subjects seen within `withinMs` who have at least `minSeconds` of total time present.

It's stored as columns on the opted-in row (`raffle_entries` now, BEAT claims later), not as a separate presence log. Only opted-in people are tracked.

**[my call] Why check-ins rather than the realtime room's clients:**
- The server has no list across instances of who is connected, with their wallet.
- Analytics sessions only hold wallets when wallet visibility is on, and the raffle mustn't depend on that.
- A check-in is a verified, signed request from the scene, so it's as trustworthy as any other scene request.

**Limit:** someone could script signed requests without standing in the scene. The same is true of analytics and of BEAT. To reduce it, a check-in is only accepted while the raffle is open, at most once every 20 s per entry. It's only accepted from a pass for this raffle's scene. The host also sees the time present. It's documented on the privacy and docs pages as "present according to your scene's check-ins".

## In-world (Decentraland), new SDK 2.15.0 and runtime v14

Today visitors get no HUD. v1 adds a minimal **visitor overlay** to the runtime, separate from the host HUD:
- A **raffle card** in the corner while a raffle is open: the name, the prize, and the entry count. It has three states:
  - **Enter** opens the consent text, then **Confirm**.
  - **Entered ✓ · Withdraw** once entered.
  - **Sign in with a wallet to enter** for guests.
- The **wheel**, a full-width overlay shown to everyone in the scene for about 8 s:
  - Its slices are the pool's display names (up to 60; beyond that, a sample that always includes the winners, plus "+N more").
  - It spins and slows down onto the winner, which was chosen before the spin, then shows "🎉 Name wins!". With several winners, it spins once for each.
  - The winner also sees "You won! The host will contact you about your prize."
- Host controls go in the host HUD as a new **Raffle** tab. It shows the current raffle's status, the entry count and time present, and has **Open**, **Snapshot**, **Spin** (all snapshots) and **Close**. Creating and editing a raffle stay on the dashboard.

Messages:
- `raffle_changed` travels on the venue bus (`apps/server/src/realtime/bus.ts`), reaching every instance's scene room, for open, close, cancel and entry-count updates (debounced to once every 2 s).
- `raffle_draw` carries the draw: the pool names, the winners and the draw id.

Rooms forward both to their clients. A visitor who joins late, or has just reconnected, gets the current raffle with `GET /api/scenes/:id/raffle/current` (scene pass).

## Dashboard

A **Raffles** tab on the scene page (`apps/web/src/app/(dashboard)/scenes/[sceneId]/client.tsx`):
- The raffle list.
- A create and edit form, with the rules template and the host terms checkbox.
- A raffle's page: entries (names, time present, wallets), snapshots, Snapshot and Spin buttons, the draws with their winners and records, and Close and Cancel.

The tab is locked for trial scenes, like other host tabs. **[my call]**

## API (all authenticated; scene pass where marked)

Host:
- `GET/POST /api/scenes/:sceneId/raffles`
- `GET/PATCH /api/raffles/:id`
- `POST /api/raffles/:id/open|close|cancel|snapshot|draw`
- `GET /api/raffles/:id/draws/:drawId` (the record)

Visitor (scene pass, bound to the raffle's scene):
- `GET /api/scenes/:sceneId/raffle/current`
- `POST /api/raffles/:id/entry` (enter, with the consent version)
- `DELETE /api/raffles/:id/entry` (withdraw)
- `POST /api/raffles/:id/presence`
- `GET /api/me/raffle-entries` (my entries and wins; normal sign-in)

The host routes accept the host HUD's scene pass (owner or editor passes), so the HUD tab works. Every new route goes into the cross-account walk and the scene-pass guard lists. Every `:param` route is in CASES.

## Data

- `raffles`:
  - `id`, `scene_id` (cascades on delete), `created_by`
  - `name`, `prize`, `rules`
  - `winners_count`, `mode`, `min_present_seconds`, `auto_snapshot_minutes`
  - `status`
  - `host_terms_accepted_at`, `opened_at`, `closed_at`, `created_at`
- `raffle_entries`:
  - `id`, `raffle_id` (cascade), `user_id`, `wallet`, `display_name`
  - `consent_version`, `consented_at`
  - `seconds_present`, `last_seen_at`
  - Unique on (`raffle_id`, `wallet`).
- `raffle_snapshots`:
  - `id`, `raffle_id`, `taken_at`, `trigger` (`manual` or `auto`)
  - `entry_ids` (a uuid array)
- `raffle_draws`:
  - `id`, `raffle_id`, `snapshot_ids`, `mode`
  - `pool` (jsonb: `[{entryId, tickets}]`), `seed` (hex), `winner_entry_ids`
  - `drawn_by`, `drawn_at`

Each new table also needs its fallback `CREATE TABLE IF NOT EXISTS` block in `apps/server/entrypoint.sh`, with its entrypoint fallback test.

## Retention and deletion

- **After the raffle:** 30 days after a raffle is closed or cancelled, its entries' wallets and names are deleted, and draws keep only entry ids. That's long enough to deliver prizes. The daily job runs through `registerDailyJob` and the advisory-lock runner. **[my call: 30 days, from the ticket]**
- **On request:** `POST /api/analytics/me/delete` also deletes the caller's raffle entries in any status, and they're counted in its response. A drawn record then shows "deleted entrant" in place of that person.
- **Docs:** the privacy page and the docs get a Raffles section.

## Auto-snapshots

A sweep runs every 30 s from the lifecycle sweep. For each open raffle whose auto-interval is due, it takes a snapshot. It stays safe across instances with a conditional claim (`update raffles set next_auto_snapshot_at = … where id = … and next_auto_snapshot_at = old returning`), the same way the preset schedule sweep (LIV-86) does. That needs a `next_auto_snapshot_at` column on `raffles`.

## Testing

- Server routes:
  - permissions: host, editor, viewer, grant, other account;
  - consent required;
  - one entry per wallet;
  - guests refused;
  - withdrawing before the draw only.
- The presence cap and the 20 s throttle.
- Snapshots: only recent entrants who meet the minimum time.
- Draws:
  - one-per-person and weighted pools;
  - no repeat winners;
  - an empty pool is refused;
  - more winners asked for than are in the pool gives every entrant;
  - a replay from the stored seed matches.
- The auto-snapshot sweep claims once across two concurrent runs.
- Retention scrubbing and the deletion endpoint.
- The guard lists, cross-account cases, and the entrypoint fallback test.
- The adapter: card states and the consent flow, and a wheel test that the winner slice is the one the server sent.
- The runtime v14 test checks for the raffle overlay strings.

## Release

- Server and dashboard ship first, with the raffle API and the dashboard tab.
- Then `@virvixr/dcl` 2.15.0 and runtime v14 with the visitor overlay and the host tab. The owner publishes to npm.
- Scenes get raffles in-world once they're redeployed. The scene page's "behind" notice from 2.14.0 already prompts that.

## Left to the builder

- The exact layout and animation easing of the card and the wheel.
- The wording of the official-rules template, which must be plain and short and include eligibility, how winners are picked, and how prizes are delivered.
- Internal module boundaries within the files above.

## Settled details (from the builder check)

Where this section and the text above differ, this section wins.

1. **Status and what's allowed when:**

   | | `open` | `drawn` |
   |---|---|---|
   | Entry | yes | no (entry closes at the first draw, per the ticket) |
   | Check-ins | yes | yes |
   | Snapshots (manual or auto) | yes | yes |
   | Draws | yes | yes |

   So a re-spin can use a fresh snapshot of who's still there. Withdrawing is allowed in both. A withdrawn entry leaves later pools; past draw records keep its id and show "withdrawn entrant".
2. **Entering counts as the first check-in.** It sets `last_seen_at` and leaves `seconds_present` at 0.
   - The minimum time present defaults to **5 minutes**. The host can set 0 to 120.
   - A snapshot needs `last_seen_at` within 60 s and `seconds_present` ≥ the minimum.
   - Entry needs a signed request from the scene, so the visitor is in the scene at that moment.
3. **The visitor pass already exists.**
   - Verified visitors sign in through `virvi.authenticate` (`packages/adapter-dcl/src/index.ts`, `connectContentOnly`).
   - The pass is renewed by `Virvi.renewPass`, a signed request with no new sign-in flow.
   - The overlay uses that client.
   - Guests have no pass and see the sign-in message.
   - Hyperfy, AR and studio passes are refused on raffle routes; their `scenePass` flags are left unset.
4. **Display name:**
   - It's the name from Virvi's sign-in: the Decentraland name, or the shortened wallet `0x1234…abcd` when the request wasn't body-signed.
   - It's copied at entry.
   - The consent text says "your display name (or a shortened wallet address if you have no name)".
5. **One person:** unique on (`raffle_id`, `wallet`) **and** (`raffle_id`, `user_id`).
6. **The draw algorithm:**
   - **Pool:** the stored pool, sorted by entry id: `[{entryId, tickets}]`.
     - One-per-person: each entrant has 1 ticket.
     - Weighted: each entrant has 1 ticket per chosen snapshot they appear in.
   - **Randomness:** for k = 0, 1, 2…:
     - `r_k` = the first 8 bytes of `HMAC-SHA256(seed, "virvi-raffle:" + drawId + ":" + k)`, read as an unsigned big-endian integer.
     - Use rejection sampling to get a uniform value in `[0, totalTickets)`: reject `r_k` ≥ `floor(2^64 / total) * total`, and move to the next k.
     - Walk the pool's cumulative tickets to find the winner.
   - **Several winners:**
     - After a pick, remove all of that entrant's tickets and continue with the next k. N winners are drawn without replacement, and nobody wins twice, even in weighted mode.
     - If N ≥ the number of entrants, everyone in the pool wins, in draw order.
   - **Replay:** a replay runs this on the **stored** pool, so it matches even after entrants are deleted.
   - **Docs:** the algorithm goes in the docs, and `GET …/draws/:drawId` returns the seed, the pool and the algorithm version (`v1`).
7. **Concurrent draws:**
   - A draw locks the raffle row (`SELECT … FOR UPDATE`).
   - A draw within 15 s of the previous one is refused (`draw_in_progress`), which covers a double-click and a wheel still spinning.
   - The wheel spins once, about 8 s, and lands on the first winner. With several winners, a card listing all of them follows for 6 s. The overlay never runs longer than about 15 s.
8. **Who can run raffles:** "editors" means every holder of `EDITOR_SCOPES`, both collab and role editors. Cohosts and admins get it through `ALL_SCOPES`. Viewers and grant holders never see entrant names or wallets.
9. **Host routes with the host HUD's pass:** these use the existing pattern. That's `config.scenePass.sceneFrom` plus `getSceneAccess`/`hasScope`, as on `PUT /api/scenes/:sceneId` (`routes/scenes.ts`). Raffle-id routes resolve the scene with a `fromRaffle` resolver, like `fromPreset`.
10. **Scope of a raffle:**
    - A raffle belongs to a **scene**, across all its locations.
    - At most one raffle per scene is `open` or `drawn`. That's enforced by a unique partial index on `scene_id` where the status is in (`open`, `drawn`).
    - `raffle_changed` and `raffle_draw` go to every room of that scene.
11. **Ending and retention:**
    - `ended_at` is set on close or cancel.
    - A raffle still `open` or `drawn` closes itself 7 days after its last draw, or 30 days after it opened, whichever comes first.
    - The scrub runs 30 days after `ended_at`.
