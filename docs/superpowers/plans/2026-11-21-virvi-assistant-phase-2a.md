# Virvi Assistant phase 2a (making things) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The assistant can create a scene, start a Studio design (wearable, emote or building), send Studio prompts through a confirmation card that says which prompts it uses, hand the user to finalize with the server's quote, and Settings lists everything the assistant has done.

**Architecture:** Phase 1's action log gets a third effect, `paid`. A `paid` tool never runs from the model: the loop turns it into a **card**, a one-row plan with its own single-use token and a server-written `detail` line, approved through phase 1's existing approve route. Studio and scene tools wrap existing routes like every phase 1 tool. A new read route lists the user's assistant actions for a Settings section.

**Tech Stack:** Fastify, Drizzle (Postgres), zod 4, Vitest; Next.js static export, React, Tailwind.

**Spec:** `docs/superpowers/specs/2026-11-21-virvi-assistant-phase-2-design.md` (section 2a and "Effects and cards"), on top of `docs/superpowers/specs/2026-11-09-virvi-assistant-design.md`.

## Global Constraints

- Every tool wraps an existing route through `app.inject` as the user (`apps/server/src/assistant/tools/http.ts`). No assistant-only business logic.
- A `paid` tool's card is never batched and never inside `propose_plan`. Its token is bound to the exact tool and args and single-use (phase 1's `approvePlan` claim).
- Studio prompt card copy, exactly (the count is the current number, `prompt` singular when it is 1):
  - "Uses 1 of your {n} prompts left today."
  - "Uses 1 gifted prompt ({n} left)."
  - "Uses 1 bought prompt ({n} left)."
  - fixChecks: "This one is free: fixing what the checker found doesn't use your prompts."
- With no prompts left there is no card: the model gets the error "No Studio prompts left. They reset at midnight UTC, or the user can buy more." and the user gets a link "Buy Studio prompts" to `/studio`.
- The assistant never calls `POST /api/studio/designs/:id/finalize`.
- Studio design kinds: `wearable`, `emote`, `scene` (buildings and furniture). The route also requires `agent` (`claude` | `codex` | `grok`).
- Assistant-started prompts use the Studio allowance, not the assistant budget.
- Copy: sentence case, plain verbs; a route's refusal is passed on in its own words (`routeError`).
- Schema changes go in `apps/server/src/db/schema.ts` and in the `// assistant` block of `apps/server/entrypoint.sh` (`ADD COLUMN IF NOT EXISTS`), with `test/entrypoint-fallback-assistant.test.ts` updated.
- Commands: from `apps/server`, `export PATH="$(dirname $(ls -d ~/.nvm/versions/node/v22*/bin/node | tail -1)):$PATH"` first, then `npx vitest run <file>`; typecheck with `npx tsc --noEmit -p .` (server) and `npx tsc --noEmit -p .` in `apps/web`.

## Review Focus

1. The user's prompts run out between the card being shown and Confirm being pressed: the server's own refusal (403 with its message) shows on the card as a failed step, nothing else runs. (Task 2 test.)
2. A card for someone else's design: the card is never shown; the model gets the route's 404 text. (Task 4 test.)
3. The model calls a `paid` tool during the approval continuation, or after `propose_plan` in the same turn: refused with phase 1's `APPROVAL_WRITE` / `AFTER_PLAN`, no card. (Task 3 test.)
4. Confirm pressed twice (two tabs): the second gets 409 `used`, the prompt is sent once. (Task 2 test.)
5. A design whose kind default agent is unset: `create_design` falls back to `claude`, never sends `agent: null`. (Task 4 test.)

---

### Task 1: The `paid` effect and the card fields

**Files:**
- Modify: `packages/shared/src/assistant.ts`
- Modify: `apps/server/src/db/schema.ts` (assistantActions), `apps/server/entrypoint.sh`
- Modify: `apps/server/src/assistant/tools/types.ts`, `apps/server/src/assistant/tools/run.ts`
- Test: `apps/server/test/entrypoint-fallback-assistant.test.ts`, `apps/server/test/assistant-tools.test.ts`

**Interfaces:**
- Produces:
  - `AssistantEffect = 'read' | 'write' | 'paid'`
  - `AssistantPlanView` gains `kind: 'plan' | 'card'` and `detail: string | null` (null for plans).
  - Stream event `{ type: 'link'; label: string; href: string; detail?: string }` (optional `detail`).
  - `assistant_actions.detail TEXT` (nullable) and the Drizzle column `detail`.
  - `ToolDef.preview?(args, ctx): Promise<{ detail: string } | { blocked: string; link: { label: string; href: string } }>`: required for every `paid` tool.
  - `runTool` treats `paid` like `write`: `before()` is required and throws `assistant tool X is paid without before()` otherwise.

- [ ] **Step 1: Write the failing tests.** In `entrypoint-fallback-assistant.test.ts`, assert the fallback SQL contains `ALTER TABLE assistant_actions ADD COLUMN IF NOT EXISTS detail TEXT`. In `assistant-tools.test.ts`, add `it('a paid tool without before() is a programming error')` that registers a throwaway paid def through the test's existing tool-swap helper and expects `runTool` to reject with `/is paid without before\(\)/`.
- [ ] **Step 2: Run them, expect FAIL.** `npx vitest run test/entrypoint-fallback-assistant.test.ts test/assistant-tools.test.ts`
- [ ] **Step 3: Implement** the type, column, entrypoint line (after the existing `ADD COLUMN IF NOT EXISTS args JSONB`), `ToolDef.preview`, and the `run.ts` check. `proposePlan` sets `kind: 'plan', detail: null` on its view.
- [ ] **Step 4: Run the assistant tests, expect PASS.** `npx vitest run test/assistant-*.test.ts test/entrypoint-fallback-assistant.test.ts`, then server `tsc`.
- [ ] **Step 5: Commit** `feat(assistant): paid effect and card fields`.

### Task 2: Cards in the action log

**Files:**
- Modify: `apps/server/src/assistant/actions.ts`
- Test: `apps/server/test/assistant-actions.test.ts`

**Interfaces:**
- Consumes: Task 1's `preview`, `kind`, `detail`.
- Produces: `proposeCard(ctx: ToolCtx, conversationId: string | null, name: string, args: unknown): Promise<AssistantPlanView | { error: string } | { blocked: string; link: { label: string; href: string } }>`. It parses args with the tool's schema, runs `before()` (org name, and the route's refusal for a target that isn't the user's, as `{ error }`), then `preview()`. A blocked preview writes no row. Otherwise one row: `planId` new, `step: 1`, `effect: 'paid'`, `status: 'awaiting_confirmation'`, `detail`, token signed exactly as `proposePlan` signs (same `sign`, `PLAN_TTL_MS`). Returns `{ kind: 'card', detail, planId, steps: [view], token, expiresAt }`.
- `approvePlan`, `cancelPlan` work on a card unchanged (one-row plan). `proposePlan` refuses a `paid` step with `Step {n}: {tool} needs its own confirmation, so it can't be in a plan. Call it on its own.`

- [ ] **Step 1: Write the failing tests** with a stub paid tool (preview returns `{ detail: 'Uses 1 of your 3 prompts left today.' }`, call POSTs a test route that counts calls):
  - `proposeCard` returns `kind: 'card'`, the detail, one step `awaiting_confirmation`, and stores `effect: 'paid'`.
  - approving the card runs the call once; approving again returns `{ error: 'used' }` and the count stays 1.
  - a blocked preview returns `{ blocked, link }` and inserts no row.
  - `before()` throwing `ToolError(404, …)` returns `{ error }` and inserts no row.
  - `proposePlan` with a paid step returns the "needs its own confirmation" error.
  - the route refusing at approval (403 `{ error: 'No prompts left today' }`) marks the step `failed` with that text.
- [ ] **Step 2: Run, expect FAIL.** `npx vitest run test/assistant-actions.test.ts`
- [ ] **Step 3: Implement `proposeCard`** and the `proposePlan` refusal.
- [ ] **Step 4: Run, expect PASS.**
- [ ] **Step 5: Commit** `feat(assistant): confirmation cards for paid tools`.

### Task 3: The loop turns paid calls into cards

**Files:**
- Modify: `apps/server/src/assistant/loop.ts`
- Test: `apps/server/test/assistant-loop.test.ts`

**Interfaces:**
- Consumes: `proposeCard` (Task 2).
- Behaviour, in the tool loop after the existing `planned` check:
  - `paid` during `opts.approval` → `reply({ error: APPROVAL_WRITE }, true)`.
  - `paid` otherwise → `proposeCard`. `{ error }` → error reply. `{ blocked, link }` → emit `{ type: 'link', label: link.label, href: link.href, detail: blocked }`, reply `{ error: blocked }` as an error. A card → `planned = true`, emit `{ type: 'plan', plan }`, reply `{ shown_to_user: true, waiting_for: 'the user to confirm' }`.
  - A paid card doesn't use the turn's one direct write, and a card after a direct write in the same turn is allowed.

- [ ] **Step 1: Write the failing tests** with the scripted model and the Task 2 stub tool: a paid call emits one `plan` event with `kind: 'card'` and runs nothing; a paid call in the approval continuation gets `APPROVAL_WRITE`; a paid call after `propose_plan` in the same response gets `AFTER_PLAN`; a blocked preview emits a `link` with `detail` and no `plan`.
- [ ] **Step 2: Run, expect FAIL.** `npx vitest run test/assistant-loop.test.ts`
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run all assistant tests, expect PASS.**
- [ ] **Step 5: Commit** `feat(assistant): paid tool calls become confirmation cards`.

### Task 4: Scene and Studio tools

**Files:**
- Create: `apps/server/src/assistant/tools/studio.ts`
- Modify: `apps/server/src/assistant/tools/index.ts`, `apps/server/src/assistant/tools/write.ts` (create_scene), `apps/server/src/assistant/tools/local.ts` (open_finalize)
- Modify: `apps/server/src/assistant/prompt.ts`
- Test: `apps/server/test/assistant-tools.test.ts`, `apps/server/test/assistant-tools-authz.test.ts`

**Interfaces:**
- Consumes: Task 1's `preview` and `paid`; existing helpers `inject`, `routeError`, `get`, `pick`, `id`.
- Produces tools (names exact):
  - `create_scene` (`write`): `{ name: string 1-100, description?: string ≤500 }` → `POST /api/scenes`. `before`: `orgName: null`, `undo: null` (ruling: undoing a create would be a delete, out of scope), `after`: `{ id, name }`. Label `Create scene "{name}"`. Summary `{ sceneId, presetId, name }`.
  - `list_designs` (`read`): `GET /api/studio/designs` → `[{ id, name, kind, status }]`.
  - `get_design` (`read`): `{ designId }` → `GET /api/studio/designs/:id` → `{ id, name, kind, status, revisions: last 5 as { number, status, summary } }` (field names taken from the route's response).
  - `get_studio_usage` (`read`): `GET /api/studio/usage` → `{ promptsLeft, giftedPrompts, credits, resetsAt, freeFinalizes }`.
  - `create_design` (`write`): `{ kind: 'wearable'|'emote'|'scene', name: string 1-80, agent?: 'claude'|'codex'|'grok' }`. `call` reads `GET /api/studio/defaults` when `agent` is absent and uses `agents[kind] ?? 'claude'`. `undo: null`, `orgName: null`. Label `Start a {kind word} design "{name}"` (wearable, emote, building).
  - `send_studio_prompt` (`paid`): `{ designId, text?: string 1-4000, fixChecks?: boolean, selectedSlots?: string[] }`; exactly one of `text` or `fixChecks: true`. `before`: `GET /api/studio/designs/:id` (a design that isn't the user's is the route's refusal), `undo: null`, `orgName: null`. `preview`: fixChecks → the free copy; else `GET /api/studio/usage` and daily = `promptsLeft - credits - giftedPrompts`, then the Global Constraints copy in order daily → gifted → bought, else blocked. Label `Send a Studio prompt` (labels come from args alone); `detail` is `"{design name}": {cost line}`, the name read in `preview`.
  - `get_finalize_quote` (`read`): `{ designId }` → `GET /api/studio/designs/:id/finalize` → the quote's total and free-finalize lines as the route returns them.
  - `open_finalize` (local, `read`): `{ designId }` → runs the quote GET as the user, returns `{ href: '/studio/{id}?step=finalize', label: 'Finalize "{name}"', detail: '{total as the route formats it}' }`; the loop's existing `open_page` link emission is extended to `open_finalize` with `detail`.
- `prompt.ts` RULES: replace "start Studio designs" in the can't list with "finalize or pay for anything"; add: "Studio makes wearables, emotes and buildings with furniture (kind scene). Sending a Studio prompt shows the user a card first; say what you're about to send and wait. A revision takes minutes: check it with get_design when the user asks, and never say it's done until get_design says so."

- [ ] **Step 1: Write the failing tests** (route stubs or real routes, following the file's existing style):
  - `create_design` with no agent and no default sends `agent: 'claude'`; with a default `codex` for `emote` sends `codex`.
  - `send_studio_prompt` preview (detail ends with): usage `{ promptsLeft: 5, credits: 2, giftedPrompts: 0 }` → `Uses 1 of your 3 prompts left today.`; `{ promptsLeft: 1, credits: 0, giftedPrompts: 1 }` → `Uses 1 gifted prompt (1 left).`; `{ promptsLeft: 2, credits: 2, giftedPrompts: 0 }` → `Uses 1 bought prompt (2 left).`; `{ promptsLeft: 0 }` → blocked with the exact constraint text and link `/studio`; `fixChecks: true` → the free copy without reading usage; `{ promptsLeft: 2, credits: 0, giftedPrompts: 0 }` → `Uses 1 of your 2 prompts left today.` and `{ promptsLeft: 1, … }` → `Uses 1 of your 1 prompt left today.`
  - `send_studio_prompt` for another user's design: `proposeCard` returns the route's refusal and no row.
  - both `text` and `fixChecks`, or neither: schema error.
  - `open_finalize` returns `href` `/studio/{id}?step=finalize`.
  - `assistant-tools-authz.test.ts`: the new tools are walked by the existing every-tool-as-another-user test (add fixtures if it needs a design owned by B).
- [ ] **Step 2: Run, expect FAIL.** `npx vitest run test/assistant-tools.test.ts test/assistant-tools-authz.test.ts`
- [ ] **Step 3: Implement** the tools and the RULES change.
- [ ] **Step 4: Run all assistant tests and server `tsc`, expect PASS.**
- [ ] **Step 5: Commit** `feat(assistant): scene and Studio tools, prompt cards`.

### Task 5: Assistant activity route

**Files:**
- Modify: `apps/server/src/routes/assistant.ts`, `packages/shared/src/assistant.ts`
- Test: `apps/server/test/assistant-routes.test.ts`

**Interfaces:**
- Produces `GET /api/assistant/activity?before=<ISO>&limit=<1-100, default 50>` (same `auth` as conversations; locked or hidden users still get it, like Undo, through `undoGuard`) → `{ items: AssistantActivityItem[]; next: string | null }`, newest first, the user's own rows only, effects `write` and `paid` only, status not `awaiting_confirmation`. `AssistantActivityItem = AssistantActionView & { createdAt: string; conversationId: string | null; effect: AssistantEffect }`. `next` is the last item's `createdAt` when a full page was returned.

- [ ] **Step 1: Write the failing tests:** another user's rows never appear; reads and pending rows are left out; paging with `before` returns the next page without repeats; `canUndo` matches `actionView`.
- [ ] **Step 2: Run, expect FAIL.** `npx vitest run test/assistant-routes.test.ts`
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run, expect PASS.**
- [ ] **Step 5: Commit** `feat(assistant): activity route`.

### Task 6: Web: cards, finalize link, Studio step, Settings activity

**Files:**
- Modify: `apps/web/src/components/assistant/PlanCard.tsx`, `AssistantPanel.tsx`, `copy.ts`, `ActionRow.tsx` (if needed), `apps/web/src/lib/assistant/state.ts`, `apps/web/src/lib/api.ts`
- Modify: `apps/web/src/app/(dashboard)/studio/[designId]/client.tsx` (open on `?step=finalize`)
- Create: `apps/web/src/app/(dashboard)/settings/AssistantActivity.tsx`; modify `settings/page.tsx`
- Test: `apps/web/src/components/assistant/assistant.test.ts`, `apps/web/src/lib/assistant/state.test.ts`

**Interfaces:**
- Consumes: `kind`, `detail` (Task 1), link `detail`, `GET /api/assistant/activity` (Task 5).
- A `kind: 'card'` plan renders as one row: the label, the org line, `detail` under it, buttons **Confirm** and **Cancel**; after approval it is the step's `ActionRow`, with no "Undo all". Its expiry text matches plans.
- A link with `detail` shows the detail under the link button.
- `api.ts`: `getAssistantActivity(token, before?)`.
- Settings: an "Assistant activity" section, shown when `/api/assistant/status` isn't `hidden`; rows are `ActionRow`s with Undo, the date, and "Load more" while `next` is set; empty state "Nothing yet. Changes the assistant makes show here."
- The Studio design page opens on the Finalize step when the URL has `step=finalize`.

- [ ] **Step 1: Write the failing tests:** state reducer keeps a card's single step and its status updates; the card renders Confirm (not "Do these n changes"); a link event with detail keeps it; the activity list appends pages.
- [ ] **Step 2: Run, expect FAIL.** From `apps/web`: `npx vitest run src/components/assistant src/lib/assistant`
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the web suite, web `tsc`, and `npx next build`, expect PASS.**
- [ ] **Step 5: Commit** `feat(web): assistant cards, finalize link, activity in settings`.

### Task 7: Docs

**Files:**
- Modify: `apps/docs/src/content/docs/dashboard/assistant.md`

- [ ] **Step 1:** Add "Making things": creating scenes, Studio designs (the three kinds), prompt cards with the exact cost lines, the no-prompts case, finalizing through the normal dialog, and "Assistant activity" in Settings. Remove any line saying it can't start Studio designs.
- [ ] **Step 2: Build the docs** (`npx astro build` in `apps/docs`, or the repo's docs build script), expect success.
- [ ] **Step 3: Commit** `docs: assistant phase 2a`.
