# Virvi Assistant phase 2b (setting up a show) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One request ("set up an event with a wearable raffle and a BEAT") becomes a saved show checklist. The assistant then works through it: private steps are approved once, raffles and paid BEATs each get their own card, and the checklist waits on the wearable being published. Raffles can be scheduled to open by themselves.

**Architecture:** A **show** is a user-owned record (`assistant_shows`) holding a checklist of typed items. Each item's done/waiting state is **computed on read** from the real rows it points at (event, scene link, raffle, BEAT, design, pasted wearable), so nothing gets out of sync and the checklist survives any conversation. The assistant creates things with ordinary tools and plans, attaches what it made to the show's items, and reads the show to see what's left. Phase 2a's card machinery gains the `public` effect for raffle creation (which accepts the host terms) and scheduling. Raffles get an optional `opens_at`, opened by the existing raffle sweep.

**Tech Stack:** Fastify, Drizzle (Postgres), zod 4, Vitest; Next.js static export, React, Tailwind.

**Spec:** `docs/superpowers/specs/2026-11-21-virvi-assistant-phase-2-design.md` ("Effects and cards", "2b", "Constraints"), on top of `docs/superpowers/specs/2026-11-09-virvi-assistant-design.md` and the phase 2a code.

## Global Constraints

- Every tool wraps an existing or new ordinary route through `app.inject` as the user. A new route has its own authorization and goes in `test/cross-account-walk.test.ts` CASES.
- Creating a raffle accepts Virvi's raffle host terms (`RAFFLE_HOST_TERMS` in `packages/shared/src/raffles.ts`, sent as `acceptHostTerms: true`). The assistant only ever does this through a `public` card whose detail shows that exact text; pressing Confirm is the user accepting it.
- `public` and `paid` cards: never batched, never inside `propose_plan`, single-use, argument-bound (phase 2a's `proposeCard`).
- The assistant never pays. A BEAT's payment is the existing Pay flow on `/beats/{id}`; the assistant offers it as a link whose detail is the server's quote.
- A show job is a record, not memory. It belongs to its user. Item states come from the database, never from model text.
- Curation warning threshold: an event starting in fewer than **7 days** with a wearable still to be designed gets the warning (my call, constant `CURATION_DAYS = 7`).
- Timeline copy when a new wearable is in the show (the assistant says this before the show is approved; the tool returns it as `timeline`): "Making the wearable takes a few days in Studio, then Decentraland curation, so I can't name it as the prize until it's published. I'll keep it on the checklist."
- Too-soon copy (returned as `warning`): "This event starts in fewer than 7 days. A new wearable may not be through Decentraland curation by then. A wearable you've already published would be safer."
- Copy: sentence case, plain verbs; routes' refusals passed on in plain words.
- Schema changes: `apps/server/src/db/schema.ts` plus the `apps/server/entrypoint.sh` fallback block for that area (`ADD COLUMN IF NOT EXISTS` / `CREATE TABLE IF NOT EXISTS`), with the matching fallback test updated.
- Commands: from `apps/server`, export Node 22 PATH (`export PATH="$(dirname $(ls -d ~/.nvm/versions/node/v22*/bin/node | tail -1)):$PATH"`), `npx vitest run <files>`; `npx tsc --noEmit -p .` in server and web; rebuild `packages/shared` with `npx tsc` after changing it. Use a private test database (`TEST_DATABASE_URL=postgres://vlm:vlm_dev@localhost:5432/vlm_test_<task>`) so runs never drop the shared `vlm_test`; drop it when done.

## Review Focus

1. A scheduled raffle whose scene already has a raffle running at the open time: the sweep leaves it a draft, clears nothing silently, and records why (`open_error`), shown in the Raffles tab. (Task 2 test.)
2. A show item pointing at a row the user can no longer see, or that was deleted: the item shows `skipped` with "This was deleted.", never an error for the whole show. (Task 6 test.)
3. Another user's show id in any show route or tool: 404, and no show data leaks. (Task 6 cross-account case.)
4. Raffle `opens_at` in the past, or on a raffle that isn't a draft: 400 with plain words. (Task 2 test.)
5. A pasted wearable link that isn't a Decentraland Marketplace item or `0x…` contract plus item id: refused with an example of the right shape, the show unchanged. (Task 6 test.)

---

### Task 1: Events record their organization

**Files:** Modify `apps/server/src/routes/events.ts`. Test: `apps/server/test/events.test.ts` (or the existing events test file).

**Interfaces:** Produces: `POST /api/events` stores `orgId = request.user.orgId ?? null` (the caller's active organization). Listing and access stay owner-based (no change to who can see an event).

- [ ] **Step 1: Failing tests:** an event created with an active org token has that `orgId`; one created on a personal token has `orgId: null`; another member of the same org still can't read it (unchanged access).
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run, expect PASS** (events tests + cross-account walk).
- [ ] **Step 5: Commit** `fix(events): an event records the organization it was made in`.

### Task 2: Scheduled raffle opening (server)

**Files:** Modify `apps/server/src/db/schema.ts` (raffles), `apps/server/entrypoint.sh`, `apps/server/src/raffles/service.ts`, `apps/server/src/raffles/routes.ts` (only if the body passes through), `apps/server/src/raffles/sweeps.ts`, `packages/shared/src/raffles.ts` (host view type). Test: the existing raffles tests and the raffle entrypoint fallback test.

**Interfaces:**
- Produces: `raffles.opens_at TIMESTAMPTZ NULL` and `raffles.open_error TEXT NULL`.
- `opensAt` is accepted by create and PATCH: an ISO time in the future, or `null` to clear. Only a draft may have one (PATCH on a non-draft with `opensAt` → 400 `not_draft`, "Only a raffle that hasn't opened can be scheduled."). A past time → 400 `opens_at_past`, "Pick a time in the future." Setting or clearing clears `open_error`.
- The host view includes `opensAt: string | null` and `openError: string | null`.
- `runRaffleSweep` first opens due drafts (`status = 'draft' AND opens_at <= now`) through the same `openRaffle`. On `raffle_already_active` it keeps the draft, sets `opens_at = null` and `open_error` to the error's message. Any other error is logged and retried on the next sweep. It returns `{ opened, snapshots, closed }`.
- Opening by hand clears `opens_at`.

- [ ] **Step 1: Failing tests:** create with `opensAt` stores it; PATCH sets and clears it; past time → 400 `opens_at_past`; PATCH on an open raffle → 400 `not_draft`; the sweep at `opens_at` opens it (status `open`, `openedAt` = sweep time, `opens_at` null); the sweep with another raffle already active leaves it a draft with `open_error` = "This scene already has a raffle running. Close it first." and `opens_at` null; manual open clears `opens_at`; the entrypoint fallback has both columns.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run raffle tests + fallback test + server tsc, expect PASS.**
- [ ] **Step 5: Commit** `feat(raffles): schedule a raffle to open by itself`.

### Task 3: Scheduled opening in the Raffles tab, and docs

**Files:** Modify `apps/web/src/app/(dashboard)/scenes/[sceneId]/Raffles.tsx`, `apps/web/src/lib/raffles.ts`, `apps/docs/src/content/docs/dashboard/raffles.md`. Test: `apps/web/src/lib/raffles.test.ts` (or the existing raffles test).

**Interfaces:** Consumes Task 2's `opensAt` / `openError`.
- The create and edit form for a draft gets an optional **Open at** date-time field (local time, sent as ISO). It's empty by default; there's a **Clear** button when it's set.
- A scheduled draft shows "Opens {date, time}" next to its status. A draft with `openError` shows "Didn't open at {time}: {openError}".
- Validation copy in `raffles.ts`: a past time gives "Pick a time in the future."
- Docs: a "Scheduling a raffle" section with the field, what happens at the time, opening early or clearing it, and the clash case.

- [ ] **Step 1: Failing tests** for the form-to-body mapping (empty → no `opensAt`, a cleared time → `null`, a time → ISO) and the past-time validation.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Web vitest, web tsc, `npx next build`, docs build, expect PASS.**
- [ ] **Step 5: Commit** `feat(web): schedule a raffle's opening in the Raffles tab`.

### Task 4: The `public` effect

**Files:** Modify `packages/shared/src/assistant.ts`, `apps/server/src/assistant/actions.ts`, `apps/server/src/assistant/loop.ts`, `apps/server/src/assistant/tools/run.ts`, `apps/server/src/assistant/conversations.ts`, `apps/server/src/routes/assistant.ts` (activity filter), `apps/web/src/components/assistant/*` (only if copy depends on the effect). Test: `apps/server/test/assistant-actions.test.ts`, `assistant-loop.test.ts`, `assistant-routes.test.ts`.

**Interfaces:**
- `AssistantEffect = 'read' | 'write' | 'paid' | 'public'`.
- Everything phase 2a does for `paid`, it does for `public`:
  - `proposeCard` accepts it.
  - The loop turns it into a card.
  - `proposePlan` refuses it with the same "needs its own confirmation" message.
  - The approval turn refuses it.
  - It shows in history and activity.
  - `preview()` is required.
- Card copy is unchanged: Confirm / Cancel.

- [ ] **Step 1: Failing tests** mirroring the 2a paid tests with a stub `public` tool: one card each in actions, loop and history, plus the plan refusal and activity listing.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement** by treating `public` everywhere `paid` is checked: one shared `needsCard(effect)` helper in `tools/types.ts`, used at every check.
- [ ] **Step 4: Run assistant tests, both tsc, expect PASS.**
- [ ] **Step 5: Commit** `feat(assistant): public effect uses confirmation cards`.

### Task 5: Event, raffle and BEAT tools

**Files:** Create `apps/server/src/assistant/tools/shows-tools.ts` (event, raffle, BEAT tools). Modify `tools/index.ts`, `tools/local.ts` (open_beat_pay), `loop.ts` (link emission for open_beat_pay, same as open_finalize), `conversations.ts` (rebuild open_beat_pay links like open_finalize), `prompt.ts`. Test: `assistant-tools.test.ts`, `assistant-tools-authz.test.ts`, `assistant-loop.test.ts`.

**Interfaces** (tool names exact; each wraps the route named):
- `create_event` (`write`): `{ name 1-120, description? ≤2000, startTime ISO, endTime ISO, timezone? }` → `POST /api/events`. `undo`: `DELETE /api/events/:id` guarded by `currentOf` (name/times unchanged). `orgName` from the created event's `orgId`. Label `Create event "{name}"`.
- `update_event` (`write`): `{ eventId, name?, description?, startTime?, endTime?, timezone? }` → `PUT /api/events/:eventId`. `before` reads `GET /api/events/:eventId`; undo PUTs the old values.
- `link_event_scene` (`write`): `{ eventId, sceneId }` → `POST /api/events/:eventId/link-scene`. Undo `DELETE /api/events/:eventId/unlink-scene/:sceneId`.
- `list_scene_raffles` (`read`): `{ sceneId }` → `GET /api/scenes/:sceneId/raffles`.
- `create_raffle` (`public`): `{ sceneId, name, prize, winnersCount 1-…, mode: 'one_per_person'|'weighted', minPresentMinutes?, opensAt? }` → `POST /api/scenes/:sceneId/raffles` with `acceptHostTerms: true` added by the tool's `call`, never taken from args. `preview` detail is: `"{scene name}": {name}, prize "{prize}", {n} winner(s){, opens {date} UTC}` then a blank line, then `RAFFLE_HOST_TERMS` verbatim, then "Confirming accepts these terms for this raffle." `before` reads the scene as the user (org name, refusal).
- `schedule_raffle_open` (`public`): `{ raffleId, opensAt: ISO | null }` → `PATCH /api/raffles/:raffleId` `{ opensAt }`. Detail `Open "{raffle name}" by itself at {date} UTC` or `Stop "{name}" opening by itself`.
- `update_raffle_prize` (`write`): `{ raffleId, prize }` → `PATCH /api/raffles/:raffleId` `{ prize }`. Undo PATCHes the old prize, guarded by `current`.
- `create_beat_draft` (`write`): `{ name, description?, startsAt, endsAt, sceneIds: string[] 1+, imageMediaId, supplyCap?, minPresentMinutes?, tradeable?: boolean }` → `POST /api/beats` (location defaults to the route's own default). `undo: null` (ruling: a draft BEAT is cancelled on its page). Label `Create a BEAT draft "{name}"`.
- `get_beat` (`read`): `{ beatId }` → `GET /api/beats/:beatId` → `{ id, name, status, startsAt, endsAt, supplyCap, sceneIds }`.
- `open_beat_pay` (local, `read`): `{ beatId }` runs `GET /api/beats/:beatId/quote` as the user and returns `{ href: '/beats/{id}', label: 'Pay for "{name}"', detail: 'Total {price as the quote formats it}' }`. If the BEAT isn't a draft: a ToolError "This BEAT is already paid for." The loop emits it like `open_finalize`, and history rebuilds it the same way.
- `prompt.ts` RULES additions:
  - "Raffles: creating one accepts the host terms on the user's behalf only through its card."
  - "Pay for a BEAT with open_beat_pay; you never pay."
  - "For a show, call start_show first (see its description)."

- [ ] **Step 1: Failing tests:**
  - `create_raffle` sends `acceptHostTerms: true` even when args try to set it false, and its card detail contains `RAFFLE_HOST_TERMS` verbatim.
  - A raffle for another user's scene: refused, no card.
  - `create_event` undo deletes only an unchanged event.
  - `link_event_scene` undo unlinks.
  - `update_raffle_prize` undo restores the prize, and refuses once the prize was edited by hand.
  - `create_beat_draft` creates a `draft`.
  - `open_beat_pay` on a paid BEAT is refused.
  - The authz walk covers every new tool (B's event, raffle and BEAT fixtures).
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run assistant tests + server tsc, expect PASS.**
- [ ] **Step 5: Commit** `feat(assistant): event, raffle and BEAT tools`.

### Task 6: Show records

**Files:** Create `apps/server/src/assistant/shows.ts` (state computation) and `apps/server/src/routes/assistant-shows.ts` (routes; register next to the assistant routes). Modify `schema.ts`, `entrypoint.sh` (assistant block), `packages/shared/src/assistant.ts`, `tools/shows-tools.ts` (show tools), `tools/index.ts`. Test: `apps/server/test/assistant-shows.test.ts` (new), `cross-account-walk.test.ts`, `entrypoint-fallback-assistant.test.ts`, `assistant-tools-authz.test.ts`.

**Interfaces:**
- Table `assistant_shows`: `id uuid pk`, `user_id uuid not null fk users cascade`, `org_id uuid null`, `conversation_id uuid null fk assistant_conversations set null`, `event_id uuid null fk events set null`, `title text not null`, `items jsonb not null`, `created_at`, `updated_at`, `closed_at timestamptz null`. Index `(user_id, updated_at)`, index `(event_id)`.
- `ShowItemKind = 'event' | 'scene_link' | 'showing' | 'raffle' | 'raffle_scheduled' | 'beat' | 'beat_paid' | 'wearable_design' | 'wearable_published'`.
- Stored item: `{ id: string; kind: ShowItemKind; label: string; ref: { eventId?, sceneId?, showingId?, raffleId?, beatId?, designId? }; wearable?: { contract: string; itemId: string; url: string } }`.
- `ShowView = { id, title, eventId, orgName, createdAt, closedAt, timeline: string | null, warning: string | null, items: Array<{ id, kind, label, state: 'todo' | 'waiting' | 'done' | 'skipped', note: string | null }> }`.
- **State rules** (`computeShow(show, userId)`, reading only rows the user owns or can access through the same checks as the routes):

  | Kind | done when | otherwise |
  |---|---|---|
  | event | `ref.eventId` exists | todo |
  | scene_link | that scene is linked to the event | todo |
  | showing | `ref.showingId` exists | todo |
  | raffle | `ref.raffleId` exists | todo |
  | raffle_scheduled | the raffle has `opens_at`, or status is open/drawn/closed | waiting, note = `openError` when set |
  | beat | `ref.beatId` exists | todo |
  | beat_paid | the BEAT's status isn't `draft` | waiting, note "Waiting for payment." |
  | wearable_design | the design has a finalized piece | todo, or waiting while a job runs |
  | wearable_published | `wearable` is set | waiting, note "Publish it on Decentraland, then paste its Marketplace link." |

  - A ref whose row is gone or not visible to the user → `skipped`, note "This was deleted."
- `timeline`: the global timeline copy when the show has a `wearable_design` item, else null. `warning`: the too-soon copy when the show has a `wearable_design` item and the event (or the show's `startTime` input, before the event exists) starts within `CURATION_DAYS`.
- Routes (owner only; another user's id → 404):
  - `GET /api/assistant/shows?eventId=` → `{ shows: ShowView[] }`, open shows newest first.
  - `GET /api/assistant/shows/:showId` → `ShowView`.
  - `POST /api/assistant/shows` `{ title, startTime?, items: [{ kind, label }] (1-20) }` → `ShowView`. Item ids are server-made.
  - `PATCH /api/assistant/shows/:showId/items/:itemId` `{ ref?, wearable? }`.
    - Ref ids must be UUIDs the user can access. The server checks each through the owning GET route's rule; refused → 404 "That isn't yours, or it's gone."
    - Setting `ref.eventId` on the `event` item also sets the show's `event_id`.
    - `wearable` accepts a Marketplace URL `https://decentraland.org/marketplace/contracts/0x{40 hex}/items/{digits}` or `{ contract: 0x{40 hex}, itemId: digits }`. Anything else → 400 "Paste the wearable's Marketplace link, like https://decentraland.org/marketplace/contracts/0x…/items/0."
  - `POST /api/assistant/shows/:showId/close` sets `closed_at`.
  - The routes use the same access as conversations (assistant available), not undoAuth.
- Tools:
  - `start_show` (`write`, wraps POST). Its description tells the model to list the checklist items and pass `startTime`. It returns `timeline` and `warning` so the model says them before going further. `undo`: POST close.
  - `get_show` and `list_shows` (`read`).
  - `attach_to_show` (`write`, wraps PATCH; undo PATCHes the previous ref/wearable back).
  - `close_show` (`write`).

- [ ] **Step 1: Failing tests:**
  - Every state rule: done, todo, waiting and skipped, including a deleted raffle → skipped.
  - The timeline and warning thresholds: 6 days → warning, 8 days → none.
  - Attaching another user's raffle → 404, show unchanged.
  - Bad wearable shapes → 400 with the example; a good URL and a good contract/itemId → stored.
  - Another user's show id → 404 on every route (cross-account CASES).
  - The fallback creates the table.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run new tests + assistant tests + cross-account walk + server tsc, expect PASS.**
- [ ] **Step 5: Commit** `feat(assistant): show checklists`.

### Task 7: Show checklist on the events page

**Files:** Create `apps/web/src/components/assistant/ShowChecklist.tsx`. Modify `apps/web/src/app/(dashboard)/events/page.tsx` (the selected event's detail), `apps/web/src/lib/api.ts`. Test: `apps/web/src/components/assistant/assistant.test.ts`.

**Interfaces:**
- Consumes `GET /api/assistant/shows?eventId=` (Task 6).
- The checklist shows on the selected event when a show is attached and the assistant is available on the account. It lists each item with its label, a state badge (To do, Waiting, Done, Skipped) and the note, then the timeline and warning lines when set.
- One button, **Ask the assistant**, opens the panel; the panel is opened the way the dashboard layout already opens it.

- [ ] **Step 1: Failing tests** for state badges and notes in the rendered markup, and that no checklist renders when the list is empty.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Web vitest, web tsc, next build, expect PASS.**
- [ ] **Step 5: Commit** `feat(web): show checklist on the event`.

### Task 8: Docs

**Files:** Modify `apps/docs/src/content/docs/dashboard/assistant.md`.

- [ ] **Step 1:** Add "Setting up a show". Cover:
  - what one request sets up
  - the checklist on the event page
  - raffles in place of giveaways, with prizes delivered by you
  - the host terms card
  - scheduled opening
  - the BEAT draft and Pay link
  - the new-wearable timeline and the 7-day warning
  - pasting the Marketplace link
  - picking a show up from any conversation
- [ ] **Step 2: Docs build, expect success.**
- [ ] **Step 3: Commit** `docs: assistant shows`.

### Task 9: Markdown in the assistant's replies (owner request, 2026-11-22)

The assistant's replies render markdown: headings, bold and italic, lists, links, inline code, code blocks and tables. Raw HTML is never rendered.

**Files:**
- Modify `apps/web/src/lib/markdown.ts` (parser) and `apps/web/src/lib/markdown.test.ts`.
- Move `apps/web/src/app/(dashboard)/studio/[designId]/Markdown.tsx` to `apps/web/src/components/Markdown.tsx` and update the Studio import.
- Modify `apps/web/src/components/assistant/AssistantPanel.tsx` (assistant message text only). Test: `apps/web/src/components/assistant/assistant.test.ts`.

**Interfaces and decisions:**
- **Reuse the existing parser.** It builds a tree and React renders the tree, so text from a reply never becomes HTML. Never use `dangerouslySetInnerHTML` or an HTML-producing library. A literal `<b>x</b>` in a reply shows as text.
- **Tables (GFM pipes).** Add `Block` `{ type: 'table'; align: Array<'left' | 'center' | 'right' | null>; head: Inline[][]; rows: Inline[][][] }`.
  - A table is a header row, a separator row (`---`, `:---`, `---:`, `:---:`), then body rows.
  - Cells are inline-parsed.
  - A row with fewer cells than the header is padded; extra cells are dropped.
  - A pipe line with no separator row stays a paragraph.
- **Headings.** Keep levels 1-3 (deeper levels clamp to 3, as today). The shared component renders level 1 as `h3`, 2 as `h4`, 3 as `h5`, sized for the panel, so they don't fight the page's own headings.
- **Links.** The parser keeps `http(s)://` links and also accepts root-relative paths (`/…`). The component takes `links: 'external' | 'assistant'`:
  - `external` (Studio, unchanged behaviour): http(s) open in a new tab with `rel="noopener noreferrer"`; a relative path renders as its label text.
  - `assistant`: a path that passes `safeHref` (`lib/assistant/state.ts`, the dashboard allowlist) is an in-app link in the same tab. An `https://` link whose host is `virvi.io` or a subdomain of it opens in a new tab with `rel="noopener noreferrer"`. Any other URL renders as plain text, `label (url)`, with no link (ruling: model text can be steered by untrusted data, so only Virvi destinations are clickable, matching phase 1's link policy).
- **Code.** Inline code and fenced code blocks; the fence's language tag is ignored. Blocks scroll sideways inside themselves.
- **Width.** Tables sit in an `overflow-x-auto` wrapper so a wide table never makes the panel or page scroll sideways at 390 px.
- **Scope.** Only assistant replies render markdown. The user's own messages stay plain text. Streaming text re-renders as it grows, and an unclosed marker shows as literal text until it closes.

- [ ] **Step 1: Failing tests (parser):**
  - a 2-column table with alignment
  - a short row padded and a long row truncated
  - a pipe line without a separator stays a paragraph
  - `/scenes?id=x` kept as a link node
  - `javascript:alert(1)` and `data:` never become links
  - `<script>` stays text
- [ ] **Step 1b: Failing tests (render, `renderToStaticMarkup`):**
  - the assistant variant links `/scenes?id=x` and `https://docs.virvi.io/x`, but renders `https://evil.example` as `label (https://evil.example)` with no `<a>`
  - a table renders `<table>` inside an overflow wrapper
  - `<b>hi</b>` in the text appears escaped
  - a user message with `**x**` renders the asterisks
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Web vitest, web tsc, `npx next build`, expect PASS. Studio's conversation still renders as before.**
- [ ] **Step 5: Commit** `feat(web): assistant replies render markdown`.
