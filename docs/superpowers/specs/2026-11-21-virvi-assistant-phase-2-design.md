# Virvi Assistant phase 2: making things, setting up shows, running them

Parent: LIV-65. Phase 1 (LIV-155) is live for admins: `docs/superpowers/specs/2026-11-09-virvi-assistant-design.md` is the base design, and its rules, the owner decisions of 2026-11-09 and 2026-11-19, and the phase 1 code all stay in force unless this document says otherwise.

## Why

Phase 1 can read an account and make small private changes. The first real request the owner gave it was "make me a rooftop club", and it couldn't do it. The next one the owner described was "help me set up an event with a wearable giveaway and a BEAT token giveaway". Phase 2 makes both of those work from one conversation, safely, and then opens the assistant to paid plans.

## Goals

- **Make things (2a).** Create a scene and start a Studio design (wearable, emote, or building and furniture: Studio kind `scene`), keep refining it with prompts, and take it to finalize through the normal checkout.
- **Set up a show (2b).** One request sets up an event and everything around it: scene links, showings, a raffle with a wearable prize, and a BEAT. The wearable can be one the user already published on Decentraland or a new Studio design.
- **Run things (2c).** Redeploy a scene to the destinations it already has, explain deploy failures in plain words, and manage scene collaborators.
- **Assistant activity** in Settings: everything the assistant has done, across conversations, with Undo where it still applies.
- After 2b ships, the assistant can open to paid plans (`ASSISTANT_AUDIENCE=paid`, set by the owner).

## Non-goals

- Deleting scenes, designs, events or anything else. Deletes stay links to the page where the user does it.
- New deploy destinations, and anything that needs the user's wallet signature beyond handing the signing step to the existing UI.
- The assistant paying for anything. Payment always happens in the normal checkout or Pay flow, pressed by the user.
- Automatic wearable giveaways. Giveaways today store items but have no claim or delivery flow. That is its own ticket (see "Follow-ups"). Phase 2 uses raffles for wearable prizes.
- Memory between conversations. A show job is a record, like the event it belongs to, not memory.

## Anti-goals (a failure even if it works)

- Anything public, paid or destructive happening without its own card that says exactly what will happen, pressed by the user.
- A plan or job that quietly runs a paid or public step because an earlier approval covered "the whole plan".
- The assistant promising something the platform can't do: delivering a wearable automatically, or adding a wearable to a prize before it exists on Decentraland.
- Studio prompts that spend from the user's allowance without the user seeing which pot they come from first.

## Effects and cards

Phase 1's effects were `read` and `write`. Phase 2 uses the base design's other three, with these cards (base design, "Confirmation model"):

| Effect | Examples in phase 2 | What the user sees |
|---|---|---|
| `write` (private) | create a scene, create an event, create a draft BEAT, create a draft raffle, link a scene to an event | Runs directly (one per turn) or as a plan step, with Undo where it can be undone. Unchanged from phase 1. |
| `public` (visitors or other people see or are told) | open a raffle, or schedule it to open; add a collaborator; redeploy | Its own card every time, with the exact change. Never covered by a plan approval. |
| `paid` (spends money, credits or Studio prompts) | send a Studio prompt, finalize a design, pay for a BEAT | Its own card every time. For prompts: which pot it comes from and what's left (below). For money: the server's quote, then a button into the existing checkout or Pay flow. |
| `destructive` | none in phase 2 | Not offered. |

A plan (phase 1's `propose_plan`) can now contain `public` and `paid` steps. Approving the plan runs the private steps; when a `public` or `paid` step is reached the plan stops on that step's card, and continues only when the user presses it. A card is rendered from the server's pending action record, never from model text, and carries the same single-use, argument-bound token as phase 1's plan approval.

### What a Studio prompt costs

Every Studio prompt costs exactly one prompt. The server already reports the user's prompts (`GET /api/studio/usage`), and the card says which pot the prompt will come from, in the order `studio/quota.ts` uses them:

1. The plan's daily prompts (reset at midnight UTC): "Uses 1 of your 8 prompts left today."
2. Gifted prompts, which never expire: "Uses 1 gifted prompt (3 left)."
3. Bought prompts, which never expire: "Uses 1 bought prompt (20 left)."

With none left, the card says so and links to buying more instead of offering to send. A "fix what the checker found" prompt costs nothing and its card says so. A prompt that ends in an error is given back, as today. The hidden daily cost ceiling can still refuse a prompt; the assistant passes on the server's message. Assistant-started prompts use the Studio allowance, not the assistant budget (base design); the tokens the assistant spends writing the prompt use the assistant budget, as for any turn.

### Finalizing

A finalize card shows the server's own quote for the design (`GET /api/studio/designs/:id/finalize`), including any free finalizes the plan gives, and its button opens the existing finalize dialog with the same pieces ticked. The assistant never calls `POST …/finalize` itself.

## 2a: making things

- New tools:
  - `create_scene`: `write`, wraps `POST /api/scenes`.
  - `create_design`: `write`, wraps `POST /api/studio/designs` with kind `wearable`, `emote` or `scene`, a name, and the agent (the route requires `agent`; the assistant uses the Studio default from `GET /api/studio/defaults` unless the user names one).
  - `send_studio_prompt`: `paid` (Studio prompt), wraps `POST /api/studio/designs/:id/prompts`.
  - `get_design`, `list_designs`, `get_studio_usage`: `read`.
  - `get_finalize_quote`: `read`.
  - `open_finalize`: hands the user to the finalize dialog; no server write.
- The phase 1 clarifying rule stays: "make me a rooftop club" asks whether the user means a new building designed in Studio, a setup of an existing scene, or one model added to the library. A Studio building, once finalized, lands in the asset library and can then be added to a scene with phase 1's tools.
- The assistant reports a revision when it finishes: it reads the design's revisions on the user's next message, or when the user asks. Phase 2 doesn't push notifications.
- **Assistant activity (Settings).** Every assistant action the user has, newest first, across conversations: what, which organization, when, status, and Undo while it still applies (phase 1's undo rules and 7-day window). It reads the existing `assistant_actions` rows.

## 2b: setting up a show

### The show job

A show is set up by one **job**: a durable checklist, approved once, saved with the event, visible on the event's page and in the assistant panel. It differs from a phase 1 plan in three ways:

- It doesn't expire after 10 minutes once approved. Unapproved, it expires like a plan.
- A step can **wait** on something outside the conversation: a payment confirming, or a wearable appearing on Decentraland.
- It can be picked up from any later conversation ("how's my show going?"), because it belongs to the user and is linked to its event once step 1 has created it (my call: the job is the user's record, with the event id filled in when the event exists, and the conversation it came from kept for reference).

The steps a show job can hold:

1. Create the event with name, description, times and time zone (`write`). Events have no draft or published state: an event is private to its owner today, so creating one is an ordinary private write. (My call: no draft state is added.)
2. Link scenes to the event (`write`).
3. Create showings (`write`, phase 1's `create_showing`).
4. Create a BEAT as a draft, with the event's name, times and scenes (`write`), then a `paid` step whose card shows the server's quote (`GET /api/beats/:beatId/quote`) and opens the BEAT's existing Pay flow (card or Virvi credit). The job waits until the BEAT is paid.
5. Create a raffle in one scene with the wearable as the prize text, as a draft (`write`; only a draft raffle can be opened), then a `public` step to open it (`POST /api/raffles/:raffleId/open`). When the event has several scenes, the assistant asks which one holds the raffle (my call: one raffle per show). The raffle card says "You'll send the wearable to the winners yourself, from the raffle's winners list."

   **Scheduled opening (owner, 2026-11-21: least friction for user and host).** The raffle's `public` card is pressed during setup and schedules the raffle to open at the event's start, so nobody has to be there to open it. This adds scheduled opening to raffles for everyone, not only the assistant: an optional open time on a draft raffle, set and cleared through the raffle's own routes and the Raffles tab, and the existing raffle sweep opens raffles whose time has come. A scheduled raffle can still be opened early or unscheduled by hand. Drawing stays live and manual, as today.
6. If the wearable is new: one "Design the wearable" step that creates the Studio design (2a) and clears when the design is finalized. Prompts are sent as single `paid` cards while that step is open, not as job steps of their own, and finalizing is its own `paid` card (my call). Then a **wait** step: "Publish it on Decentraland". The user does that in the Builder; it isn't a Virvi action. The step clears when the user pastes the item's Marketplace link or contract and item id; the server checks only its shape (my call: no Decentraland lookup in phase 2), and the raffle's prize text then names the item. The prize text is shown again on the open card, so a wrong item is seen before visitors see it.

An already-published wearable is given the same way: the user pastes its link (phase 2 has no route that lists a user's Decentraland items).

### Telling the user the timeline

When the wearable is new, the assistant says so before the job is approved, in plain words. For example: "I'll set up the event and the raffle now. Making the wearable takes a few days in Studio, then Decentraland curation, so I can't name it as the prize until it's published. I'll keep it on the checklist." If the event starts sooner than a reasonable curation time (the builder sets the threshold, documented in the job's copy), the assistant says it may not be ready and suggests one of the user's published wearables instead.

### Waiting and resuming

- A paid BEAT clears its wait when the existing payment confirmation marks the BEAT paid.
- A wearable wait clears when the user gives the item. Phase 2 doesn't watch Decentraland for it.
- A waiting job never runs a later `public` or `paid` step on its own. Each still needs its card pressed. A raffle's scheduled opening counts as pressed when the user pressed its card at setup.
- Events can't be cancelled, only edited or deleted. If the event is deleted outside the job, the job shows its remaining steps as skipped, with why. A BEAT has no link to an event (only to scenes), so the job keeps the BEAT id itself.

## 2c: running things

- `redeploy_scene`: `public`, one card naming each of the scene's current destinations, which then calls the existing per-destination deploy (`POST /api/dcl/destinations/:id/deploy`) for each. A destination that returns a payload to sign stops with a link to the deploy page, where the user signs.
- `get_deploy_status` and `explain_deploy_failure`: `read`. They read the deployment and its log, and explain the failure in plain words with the next thing to try.
- `add_scene_collaborator`: `public`, wraps `POST /api/scenes/:sceneId/roles`. `remove_scene_collaborator` is destructive and not offered; the assistant links to the page.

## Constraints

- Every tool wraps an existing route through `app.inject` as the user (phase 1). Where a route is missing (the show job's own routes), it is added as an ordinary route with its own authorization, never as assistant-only logic.
- Phase 1's records need widening: `assistant_actions.effect` is `'read' | 'write'` and status has no waiting value, and plans have a fixed 10-minute expiry. Phase 2 adds the `public` and `paid` effects, a waiting status, and the job record.
- Fix found while checking: `POST /api/events` never sets `orgId` and `GET /api/events` filters on the owner only (`routes/events.ts`), so an event's organization can't be named. 2b fixes that before the assistant writes events, since every assistant action names its organization.
- Every new `:param` route goes in the cross-account walk test.
- `public` and `paid` cards are never batched. Each has its own token, bound to the exact tool and arguments, single-use.
- The never-tools list from phase 1 stands: API keys, auth, billing, account or organization deletion, purges, admin.
- Copy follows the docs voice: sentence case, plain verbs, the server's own messages passed on when a route refuses.
- Each half ships on its own, admins first, then the owner opens it to paid plans after 2b.

## Follow-ups (own tickets)

- Automatic wearable giveaways: visitors claim in the scene and the wearable is sent without the owner. It needs Virvi to hold or mint the wearables, which touches money and keys. When it exists, the show job offers it in place of a raffle.
- Watching Decentraland for a newly published item, so the wearable wait clears by itself.

## Left to the builder

- Exact tool names, schemas and summaries.
- The show job's tables, and whether a job generalises phase 1's plan record or sits beside it.
- The card layouts within the panel's existing style.
- How long before an event counts as "too soon" for curation.
- The Assistant activity page's layout and paging.
- Whether 2c's tools ship with 2b or after.
