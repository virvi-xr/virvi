# Virvi Assistant: an AI that can act across the app

Status: design, ready to plan. Owner asked for "a comprehensive AI assistant feature that can take action across the entire application" and skipped the questions, so every product call below is the builder's best interpretation and is marked as such where it matters.

## Intent

Virvi does a lot: scenes on Decentraland, Hyperfy and AR, media and screens, events and showings, giveaways, ads, analytics, Studio designs, imports, deploys, organizations. Creators have to learn where each thing lives. The assistant lets a creator say what they want in plain words ("put tonight's DJ set on the main screen at 9 and tell my event page", "why did my last deploy fail", "make a giveaway for the first 50 visitors") and have it done, by Virvi, with the same permissions and limits as if they had clicked through the dashboard themselves.

Success looks like: a creator finishes a real multi-step job from one conversation, can see exactly what was changed, and can undo it. Nothing the assistant does could not have been done by that user through the normal UI.

## Goals

- One assistant panel, available on every dashboard page, that understands where the user is (current scene, event, org).
- It can read anything the user can read and do anything the user can do, through Virvi's own routes.
- It plans multi-step jobs, shows the plan, and carries it out with confirmations where they matter.
- Every action is logged, attributed ("done by the Virvi assistant on your behalf"), and reversible where the underlying feature allows it.
- It explains Virvi: how-to answers grounded in Virvi's own docs and the user's actual setup, with links that open the right page.

## Non-goals (for this design)

- Acting in-world (Decentraland HUD, Hyperfy, Quest, Vision Pro) and voice. The owner decided the assistant is web only; in-world, people use a dedicated Design Studio scene instead (LIV-65).
- Writing scene code or SDK7 projects. Studio already owns generative design; the assistant can drive Studio's existing routes, not replace them.
- Admin/support powers. An admin's assistant still acts only as that admin through admin routes, and admin tools are a later phase.
- An open "API for agents". External agents use API keys today; that stays separate.

## Anti-goals (would make this a failure even if it works)

- **A second permission system.** If the assistant can do something the user's own click can't, that's a security bug. It must never call services directly with elevated access.
- **Surprise side effects.** Anything public, paid, or destructive happening without the user seeing exactly what will happen and saying yes.
- **Being steered by content.** Scene names, media titles, chat messages, imported files, visitor-submitted text and web pages are data. Text in them that looks like an instruction is never followed.
- **Runaway cost.** An assistant that silently burns model spend or a user's credits.

## Constraints from the existing system

- Server is Fastify (`apps/server`), web is Next.js (`apps/web`, dashboard under `app/(dashboard)`). Auth is a session JWT → `Actor` (`auth/actor.ts`); scene access via `auth/permissions.ts` (`getSceneAccess`, `isFullAccess`), org roles, scene roles, trial actors (`actor.trial`), tier limits in `TierLimits`.
- Anthropic is already configured (`config.anthropicApiKey`, Studio models). Default model for the assistant: `claude-sonnet-5-5`, configurable with `ASSISTANT_MODEL` (owner, 2026-11-09). The assistant routes requests, fills in actions and explains; wearables and emotes are built by the Design Studio agent, which keeps its own model (`claude-opus-5-5`), so the assistant's model doesn't change design quality. Switch to Opus if quality on harder requests (deploy diagnosis) disappoints.
- Self-hosted error tracking (LIV-66) exists; the assistant's failures report there like everything else.
- No users yet (`vlm-no-users-yet`), so schema can be added freely.

## How it works

### Shape

1. **Panel (web).** A slide-out panel on every dashboard page, opened from a button in the header and with `⌘K`/`Ctrl-K`. It streams replies, shows tool activity as compact rows ("Read 3 scenes", "Will change: Main Screen → DJ set, 21:00"), and renders confirmations as cards with Confirm / Change / Cancel. Page context (route, selected scene/event/org ids) is sent with each message.
2. **Conversation service (server).** `POST /api/assistant/conversations/:id/messages` (SSE stream). Runs the model loop with tool use, persists the conversation, enforces limits.
3. **Tool layer (server).** A registry of tools, each a thin, typed wrapper around an **existing HTTP route**, executed in-process with `app.inject()` using the user's own session token. This is the key decision: authorization, validation, rate limits, tier limits, trial rules, and side-effect hooks are exactly the routes' own. A tool that has no route behind it doesn't exist.
4. **Action log.** Every tool call is recorded: who, conversation, tool, arguments (redacted per tool), result summary, status, undo info.

### Tools

Each tool declares:
- `name`, description, JSON schema for input (zod in code, converted for the model).
- `route` it calls (method + path template) and how input maps to it.
- `effect`: `read` | `write` | `public` | `paid` | `destructive`.
- `confirm`: derived from effect (below), can only be made stricter per tool.
- `summarize(result)`: a short, safe text the model sees (no secrets, no raw tokens, trimmed lists).
- `undo` (optional): the inverse route call and the data it needs, captured at execution time.
- `redact`: fields never stored in the log or shown to the model (API keys, wallet signatures, payment details).

Initial catalogue (phase 1 and 2), grouped by area; each maps to routes that exist today:
- **Orientation (read):** who am I / plan / limits; list scenes, events, orgs; scene detail (destinations, deployments, live status); recent errors for my scenes; analytics summaries; help search over Virvi docs.
- **Scenes (write):** rename, settings, elements (images/video/screens/frames), presets and preset schedules, scene roles (invite co-hosts), branding.
- **Media (write):** list/upload-by-URL/rename/delete media, set what a screen plays, playlists.
- **Events & showings (write → public):** create/update events, link scenes, schedule showings, publish an event page (public).
- **Giveaways (write → public/paid where applicable):** create, schedule, pause.
- **Deploy (public):** redeploy a scene to its existing destinations, check deploy status and explain failures. Signing that needs the user's wallet is handed back to the UI (the assistant prepares; the user signs).
- **Studio (paid):** start a design, send a prompt, list revisions; finalizing is `paid` and always goes through the existing checkout.
- **Navigation (read):** "open X" returns a link the panel turns into a button; the assistant never needs to scrape the UI.

Not in the catalogue (never): reading or creating API keys, changing passwords or auth methods, billing/payment methods, deleting an account or organization, "delete forever" purges, admin routes (until a separate admin phase), anything that moves money other than starting a checkout the user completes.

### Confirmation levels

| Effect | Behaviour |
|---|---|
| `read` | Runs without asking. |
| `write` (reversible, private) | Shown in the plan; runs after the user approves the plan once ("Do these 4 changes"). Undo offered. |
| `public` (visitors or other people see it: deploys, publishing, messages, invites) | Its own confirmation card with the exact diff/preview, every time. |
| `paid` (spends credits/money or starts checkout) | Its own card with the price from the server's quote route; the payment itself happens in the normal checkout UI. |
| `destructive` (deletes, unlinks, removes from a platform) | Its own card naming exactly what goes, whether it can be restored (e.g. scene soft-delete 30 days), and requiring the user to press Confirm; never batched. |

Confirmations are bound to the exact tool + arguments the server will run (a signed, single-use, short-lived token). The model cannot "confirm" on the user's behalf, and a confirmation can't be replayed with changed arguments.

### Planning and execution

- For anything with more than one write, the assistant first produces a plan: numbered steps, each tagged with its effect. The user approves the plan; `public`/`paid`/`destructive` steps still get their own cards when reached.
- Execution stops at the first failure and reports what was done and what wasn't, with undo for the done part.
- Long jobs (deploys, Studio renders) return a pending status; the assistant can check back when the user asks, or the panel shows the existing job status.

### Context and memory

- Per conversation: messages, tool calls and results (summaries), page context. Conversations are private to the user; listing and deleting them is in the panel.
- No cross-conversation memory in phase 1 (builder's call: it's a privacy and correctness risk for little gain early). Phase 3 can add opt-in "remember this preference".
- Org context: when the user is acting in an org (`users.active_org_id`), the assistant says so and tools act in that org, exactly as the UI does.

### Safety

- **Prompt injection:** tool results are passed to the model inside clearly delimited data blocks with an instruction that their contents are untrusted; summaries strip or escape anything instruction-like where practical. Confirmation cards are rendered from the server's own record of the pending call, never from model text, so a manipulated model can't disguise an action.
- **Scope:** the tool registry is an allowlist. Unknown tool names are rejected server-side.
- **Access and cost limits (owner, LIV-65):** paid plans only; free and trial accounts see the panel locked with an upgrade prompt. Each user's metered model cost per billing period is capped at 70% of that period's subscription payment (annual plans: 70% of 1/12 of the yearly payment, reset monthly), read from Stripe; downgrades, refunds and cancellations shrink or stop it at once. Users see the budget left as a percentage, with a warning at 80% and a stop at 100% that says when it comes back or offers an upgrade. A per-minute rate limit and `assistantToolCallsPerMessage` keep one conversation from burning the month. Studio prompts the assistant starts use the normal Studio allowance, not this budget.
- **Privacy:** tool summaries never include other people's emails, wallet addresses, or private data the user could not see in the UI. Logs redact per-tool `redact` fields. Conversations are excluded from LIV-66 error reports except ids.
- **Kill switch:** `ASSISTANT_ENABLED` config flag and a per-tool disable list in admin settings.

### Data (new tables, Drizzle)

- `assistant_conversations` (id, user_id, org_id, title, created_at, updated_at, deleted_at)
- `assistant_messages` (id, conversation_id, role, content JSON, tokens_in, tokens_out, model, created_at)
- `assistant_actions` (id, conversation_id, user_id, tool, effect, args_redacted JSON, status [planned|awaiting_confirmation|done|failed|undone], result_summary, undo JSON, confirmation_token_hash, created_at, finished_at)
- `assistant_usage` (user_id, day, messages, tokens_in, tokens_out) for limits and cost reporting.

### Surfaces in the UI

- Panel (above) on all dashboard pages.
- "Assistant activity" in Settings: every action the assistant took, filterable, with Undo where available.
- Changes made by the assistant show "via assistant" wherever the app already shows who changed something.
- Admin: usage and cost per day, error rate per tool, top failed tools (reuses the admin pages' patterns).

## Phases

1. **Foundation + read + safe writes (first ticket).** Panel with streaming; conversation service; tool registry with `app.inject` execution as the user; confirmation tokens; action log; limits and usage; ~25 tools covering orientation, navigation, help, scene settings/elements/presets, media and screens, with undo. Kill switch. Tests: every tool's authorization is the route's (a test that calls each tool as an unrelated user and expects the route's 403/404), confirmation tokens can't be replayed or altered, injected instructions in a scene name don't trigger a tool call (scripted model), limits enforced.
2. **Public and paid actions.** Events/showings/publishing, giveaways, scene roles/invites, deploy and deploy diagnosis (wallet signing handed to the UI), Studio prompts and finalize via checkout. Settings "Assistant activity" page with undo.
3. **Quality.** Evaluation set of real creator tasks with pass/fail grading, help search over docs, opt-in preferences memory, cost tuning (model choice per turn, caching).

## Left to the builder

- Exact tool list and names in phase 1 (from the catalogue above, ~25), and which existing routes each wraps.
- Panel visual design within the dashboard's existing style.
- How summaries are trimmed per tool.
- Whether a single model or a cheap-then-strong split per turn.

## Owner decisions (2026-11-09, recorded in LIV-65)

- Web only; no in-world or voice phase.
- Paid plans only; trial and free accounts get the locked panel.
- The 70%-of-payment monthly budget replaces per-tier message counts.
- Default model `claude-sonnet-5-5` for the assistant; the Design Studio agent keeps Opus 5.5.
- Actions ship on day one, behind confirmation: the public launch waits for phase 2.
- Works across all of the user's organizations; every action and confirmation names its organization.

## Calls made without the owner (check these)

- The assistant acts only through existing routes, as the user (no service-level shortcuts).
- Never-tools list (API keys, auth, billing, account/org deletion, purges, admin).
- No long-term memory in phase 1.
