# Virvi Assistant Phase 2c (Running Things) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The assistant can redeploy a scene to the destinations it already has, explain why a deploy failed and what to try next, and add or change a scene collaborator, each public step through its own card.

**Architecture:** New tools in `apps/server/src/assistant/tools/deploy.ts` and `tools/collaborators.ts`, wrapping existing routes through `inject` like every other tool. Two small runner changes make them possible: a `keepGoing` flag so one card can run several deploys and report each, and conversation wallet references so a wallet the user types reaches a tool without the model ever seeing it.

**Tech Stack:** Fastify, Drizzle (Postgres), zod v4, Vitest; Next.js web panel (unchanged components).

**Spec:** `docs/superpowers/specs/2026-11-21-virvi-assistant-phase-2-design.md`, section "2c: running things", plus Constraints.

## Global Constraints

- Every tool wraps an existing route through `app.inject` as the user. No assistant-only authorization.
- `public` cards are never batched: one card, its own single-use token bound to the exact tool and arguments (`proposeCard`, unchanged).
- `remove_scene_collaborator` is not offered; the assistant links to the scene's Roles tab with `open_page`.
- Never-tools stand: API keys, auth, billing, account or organization deletion, purges, admin.
- Copy: sentence case, plain verbs, the server's own messages passed on when a route refuses.
- Every tool that names something gets a sample in `apps/server/test/assistant-tools-authz.test.ts` (the cross-account walk).
- The model never sees another person's full wallet (phase 1 masking stands). Cards show a wallet as `0x12ab…9f3e` (first 6, last 4), which the mask doesn't match.
- Test hygiene: run server suites with a private `TEST_DATABASE_URL` (`vlm_test_2c_<task>`), dropped afterwards.

## Review Focus

1. A destination added to the scene between the card and the press: it must not be deployed, because the card didn't name it (Task 3 test `redeploy_scene deploys only the destinations the card named`).
2. One of two destinations fails at press time: the other still deploys, and the result names which failed and why (Task 3 test `redeploy_scene reports each destination, and one failing doesn't stop the rest`).
3. The user pastes a wallet in chat: the model sees `[wallet 1]`, the tool resolves it, and the card shows the short form (Task 1 and Task 4 tests).
4. Adding a wallet that already has a role: the card says it's a role change from the old role, and Undo restores the old role rather than removing them (Task 4 test `add_scene_collaborator on an existing collaborator is a role change, undone to the old role`).
5. A scene whose every destination needs the owner's signature: no card, and the tool says to sign on each deploy page (Task 3 test `redeploy_scene with only signing destinations offers no card`).

---

### Task 1: Wallet references in conversations

**Files:**
- Modify: `apps/server/src/db/schema.ts` (`assistantConversations`), `apps/server/entrypoint.sh` (assistant block, near line 592)
- Modify: `apps/server/src/assistant/redact.ts`, `apps/server/src/assistant/loop.ts:105`, `apps/server/src/assistant/tools/types.ts` (`ToolCtx`), `apps/server/src/routes/assistant.ts:72` (`toolCtx`)
- Create: `apps/server/src/assistant/tools/wallets.ts`
- Test: `apps/server/test/assistant-redact.test.ts`, `apps/server/test/assistant-loop.test.ts`

**Interfaces:**
- Produces: `assistantConversations.walletRefs: string[]` (column `wallet_refs JSONB NOT NULL DEFAULT '[]'`, lowercased wallets, append-only)
- Produces: `maskUserText(text: string, self: RedactSelf, refs: string[]): { text: string; refs: string[] }` in `redact.ts`
- Produces: `ToolCtx.walletRefs: string[]`
- Produces: `resolveWallet(value: string, ctx: ToolCtx): string | null` and `shortWallet(wallet: string): string` in `tools/wallets.ts`
- Produces: `toolCtx(app, request, conversationId: string | null)`

- [ ] **Step 1: Write the failing tests**

In `assistant-redact.test.ts`:
```ts
it('maskUserText numbers other wallets as references, reusing a known one, and keeps the own wallet', () => {
  const own = '0x' + 'a'.repeat(40), w1 = '0x' + 'B'.repeat(40), w2 = '0x' + 'c'.repeat(40)
  const r = maskUserText(`add ${w1} and ${w2}, not ${own}, again ${w1.toLowerCase()}`, { email: null, wallets: [own] }, ['0x' + 'd'.repeat(40)])
  expect(r.text).toBe(`add [wallet 2] and [wallet 3], not ${own}, again [wallet 2]`)
  expect(r.refs).toEqual(['0x' + 'd'.repeat(40), w1.toLowerCase(), w2])
})
it('maskUserText still masks other emails', () => {
  expect(maskUserText('mail x@y.io', { email: null, wallets: [] }, []).text).toBe('mail [email]')
})
it('resolveWallet takes a reference or a full wallet, and shortWallet is never masked', () => {
  const w = '0x' + '1'.repeat(38) + 'ab'
  const ctx = { walletRefs: [w] } as ToolCtx
  expect(resolveWallet('[wallet 1]', ctx)).toBe(w)
  expect(resolveWallet('wallet 1', ctx)).toBe(w)
  expect(resolveWallet('[wallet 2]', ctx)).toBeNull()
  expect(resolveWallet(w.toUpperCase().replace('0X', '0x'), ctx)).toBe(w)
  expect(resolveWallet('0x123', ctx)).toBeNull()
  expect(shortWallet(w)).toBe('0x1111…11ab')
  expect(redactText(shortWallet(w), { email: null, wallets: [] })).toBe('0x1111…11ab')
})
```
A 40+ hex run that isn't exactly 40 (a tx hash) stays `[wallet]`, unnumbered.

In `assistant-loop.test.ts`: `a wallet the user types reaches the model as [wallet 1] and is stored on the conversation` — the stored user message text contains `[wallet 1]` and not the address; `assistant_conversations.wallet_refs` holds the lowercased address; a second turn with the same wallet still says `[wallet 1]`.

- [ ] **Step 2: Run them to see them fail**

Run: `cd apps/server && TEST_DATABASE_URL=postgres://localhost/vlm_test_2c_t1 npx vitest run test/assistant-redact.test.ts test/assistant-loop.test.ts`
Expected: FAIL (`maskUserText` not exported).

- [ ] **Step 3: Implement**

- Column in schema.ts, and in entrypoint.sh: `ALTER TABLE assistant_conversations ADD COLUMN IF NOT EXISTS wallet_refs JSONB NOT NULL DEFAULT '[]'::jsonb`.
- `loop.ts`: replace `redact(userText, ctx.self)` with `maskUserText(userText, ctx.self, conv.walletRefs)`; when refs grew, update the conversation row and set `ctx.walletRefs` before any tool runs.
- `toolCtx` loads `walletRefs` from the conversation (`[]` when null or not the user's); both call sites pass their conversation id (the approve route passes `rows[0].conversationId`).
- `resolveWallet` accepts `/^\[?wallet (\d+)\]?$/i` (1-based) or `/^0x[0-9a-f]{40}$/i`, returns lowercase.

- [ ] **Step 4: Run the tests to see them pass**

Same command. Expected: PASS. Also `npx vitest run test/assistant-*.test.ts` stays green (other tests building a `ToolCtx` need `walletRefs: []`).

- [ ] **Step 5: Commit**

```bash
git add -A apps/server && git commit -m "feat(assistant): wallets the user types become conversation references"
```

---

### Task 2: Deploy status and failure explanations (reads)

**Files:**
- Create: `apps/server/src/assistant/tools/deploy.ts`
- Modify: `apps/server/src/assistant/tools/index.ts` (add `DEPLOY_TOOLS`)
- Test: `apps/server/test/assistant-tools.test.ts`, `apps/server/test/assistant-tools-authz.test.ts`

**Interfaces:**
- Produces: `DEPLOY_TOOLS: ToolDef<any>[]` (Task 3 adds `redeploy_scene` to it)
- Produces: `nextStep(d: { status: string; errorMessage: string | null }, dest: { status: string; statusDetail: string | null } | null): string` (exported, pure)
- Produces: `destinationName(d: { kind: string; worldName: string | null; base: string; parcels: string[] }): string` — `World "<worldName>"` or `Genesis City parcels at <base> (<n> parcels)` (`1 parcel` singular)

- [ ] **Step 1: Write the failing tests**

```ts
it('nextStep gives the next thing to try for each way a deploy ends', () => {
  expect(nextStep({ status: 'deployed', errorMessage: null }, null)).toBe("It's live. Nothing to do.")
  expect(nextStep({ status: 'awaiting_signature', errorMessage: null }, null)).toBe('It is waiting for your signature on its deploy page.')
  expect(nextStep({ status: 'building', errorMessage: null }, null)).toBe('It is still running. Check again in a minute.')
  expect(nextStep({ status: 'failed', errorMessage: 'Cancelled by user' }, null)).toBe('It was cancelled. Redeploy when you are ready.')
  expect(nextStep({ status: 'failed', errorMessage: 'x' }, { status: 'over_budget', statusDetail: 'Too many triangles' }))
    .toBe('The scene is over the size limit: Too many triangles. Remove or shrink models, then redeploy.')
  expect(nextStep({ status: 'failed', errorMessage: 'x' }, { status: 'needs_review', statusDetail: 'Two models failed' }))
    .toBe('Two models failed. Check the models on the deploy page, then redeploy.')
  expect(nextStep({ status: 'failed', errorMessage: "Couldn't reach Decentraland's servers. Try again in a minute." }, { status: 'ok', statusDetail: null }))
    .toBe('Decentraland couldn\'t be reached. Redeploy in a few minutes.')
  expect(nextStep({ status: 'failed', errorMessage: 'Decentraland rejected the deploy: bad parcels' }, { status: 'ok', statusDetail: null }))
    .toBe('Decentraland refused it. Open the deploy page to check the destination, then redeploy.')
  expect(nextStep({ status: 'failed', errorMessage: 'Something went wrong on our side while deploying. Try again in a few minutes.' }, null))
    .toBe('Redeploy in a few minutes. If it fails again, ask for help with the Help button.')
})
```
Order of checks: deployment status first (deployed, awaiting_signature, pending/building/built/deploying), then destination status (`over_budget`, `needs_review`, `unreachable` → the unreachable sentence), then the message (`Cancelled` prefix, `Couldn't reach` prefix, `Decentraland rejected` prefix), else the generic sentence.

Tool tests (seed a scene, a World destination and two deployments with the existing test helpers):
- `get_deploy_status returns the deployment's status, message, destination name and next step` — summary has exactly `id, status, platform, errorMessage, createdAt, deployedAt, destination, next`; no `target`.
- `explain_deploy_failure picks the scene's latest failed deployment, or says none failed` — with a later deployed one after a failure, it still explains the failure and adds `newerDeployed: true`; with none failed, `{ failed: null, message: 'No deploy of this scene has failed recently.' }`.
- Authz walk: samples for `get_deploy_status` (B's deployment id) and `explain_deploy_failure` (B's scene id) are refused.

- [ ] **Step 2: Run them to see them fail**

Run: `cd apps/server && TEST_DATABASE_URL=postgres://localhost/vlm_test_2c_t2 npx vitest run test/assistant-tools.test.ts test/assistant-tools-authz.test.ts`
Expected: FAIL (unknown tools).

- [ ] **Step 3: Implement in `tools/deploy.ts`**

- `get_deploy_status` `{ deploymentId: uuid }`: calls `GET /api/deploy/:id`, and, when it has a `destinationId`, `GET /api/dcl/destinations/:destinationId` (read tools may return several calls).
- `explain_deploy_failure` `{ sceneId: uuid, deploymentId?: uuid }`: calls `GET /api/deploy/scene/:sceneId` and `GET /api/scenes/:sceneId/dcl/destinations`; picks `deploymentId` if given (must be in the list, else ToolError 404 `That deploy isn't one of this scene's recent deploys.`), else the newest `failed`.
- Both descriptions say the message is Decentraland's or Virvi's own words, and the model should explain it plainly with `next`.

- [ ] **Step 4: Run the tests to see them pass**

Same command. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A apps/server && git commit -m "feat(assistant): deploy status and failure explanations"
```

---

### Task 3: redeploy_scene (one card, several destinations)

**Files:**
- Modify: `apps/server/src/assistant/tools/types.ts` (`ToolDef.keepGoing`), `apps/server/src/assistant/tools/run.ts`, `apps/server/src/assistant/tools/deploy.ts`
- Test: `apps/server/test/assistant-tools.test.ts`, `apps/server/test/assistant-tools-authz.test.ts`

**Interfaces:**
- Consumes: `destinationName` (Task 2)
- Produces: `ToolDef.keepGoing?: boolean` — every call runs; `summarize` gets `Array<{ status: number; json: unknown }>` in call order; the tool fails only when every call failed (with the first call's error)

- [ ] **Step 1: Write the failing tests**

Stub the deployer as the existing destination-deploy tests do (mode `virvi` → 202).
- `redeploy_scene is a public card naming each destination and how it deploys` — args `{ sceneId, destinationIds: [w, p] }` with `w` mode virvi and `p` mode sign; card detail is exactly:
  ```
  Redeploy "<scene name>":
  - World "<name>": Virvi deploys it now
  - Genesis City parcels at 0,0 (1 parcel): you sign it on its deploy page
  ```
- `redeploy_scene deploys only the destinations the card named` — card for `[w]`; add a second virvi destination; approve; only `w` gets a deployment row.
- `redeploy_scene reports each destination, and one failing doesn't stop the rest` — two virvi destinations, the first route refuses (stub throws `DeployerError(409, 'deploy_in_progress', 'A deploy is already running.')`); the action is done and its summary is `{ deployed: [{ destinationId, name, deploymentId }], failed: [{ destinationId, name, error: 'A deploy is already running.' }], toSign: [] }`.
- `redeploy_scene with only signing destinations offers no card` — `proposeCard` returns `{ error: 'Each of these destinations needs your signature: open their deploy pages to redeploy.' }`.
- `redeploy_scene refuses a destination that isn't the scene's` — ToolError 400 `That destination isn't one of this scene's.`
- Authz walk: sample `redeploy_scene` with B's scene and destination.

- [ ] **Step 2: Run them to see them fail**

Run: `cd apps/server && TEST_DATABASE_URL=postgres://localhost/vlm_test_2c_t3 npx vitest run test/assistant-tools.test.ts test/assistant-tools-authz.test.ts`

- [ ] **Step 3: Implement**

- `run.ts`: with `def.keepGoing`, collect `{ status, json }` for every call instead of returning at the first `>= 400`; when all failed, return the first failure as today.
- `redeploy_scene` `{ sceneId: uuid, destinationIds: uuid[] (1–10, unique) }`, `effect: 'public'`, `keepGoing: true`. `before` reads `GET /api/scenes/:sceneId/dcl/destinations` (and the scene for its name and org), refuses ids not in it, refuses when none is mode `virvi`, returns `undo: null`. `call` returns one `POST /api/dcl/destinations/:id/deploy` per named virvi destination (re-read at press time; a named destination since switched to sign moves to `toSign`). `summarize` returns `{ deployed, failed, toSign: [{ destinationId, name }] }`. `refusals`: `not_world_owner` → `Only the World's owner can deploy it.`, `not_parcel_controller` → `None of your wallets can deploy to these parcels.`, `world_unreachable`/`catalyst_unreachable` → `Decentraland couldn't be reached. Try again in a few minutes.`, `not_found` → `That destination wasn't found.`
- Label: `Redeploy the scene to <n> destination(s)` (`1 destination`).

- [ ] **Step 4: Run the tests to see them pass**

Same command, plus the whole `test/assistant-*.test.ts`. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A apps/server && git commit -m "feat(assistant): redeploy a scene to its destinations from one card"
```

---

### Task 4: Scene collaborators

**Files:**
- Create: `apps/server/src/assistant/tools/collaborators.ts`
- Modify: `apps/server/src/assistant/tools/index.ts`
- Test: `apps/server/test/assistant-tools.test.ts`, `apps/server/test/assistant-tools-authz.test.ts`

**Interfaces:**
- Consumes: `resolveWallet`, `shortWallet`, `ToolCtx.walletRefs` (Task 1)
- Produces: tools `list_scene_collaborators` (read) and `add_scene_collaborator` (public)

- [ ] **Step 1: Write the failing tests**

- `list_scene_collaborators lists roles with masked wallets` — summary `{ host: { displayName }, roles: [{ wallet, role, displayName, signedIn }] }`; the wallet is `[wallet]` in the model's view.
- `add_scene_collaborator card names the short wallet, the role and what it can do` — ctx `walletRefs: [w]`, args `{ sceneId, wallet: '[wallet 1]', role: 'editor' }`; detail is `Add 0x…(short) to "<scene>" as editor: they can change the scene.` Role words: cohost `they can run the scene with you, including deploying it and changing its roles`, editor `they can change the scene`, viewer `they can see the scene's analytics`.
- `add_scene_collaborator on an existing collaborator is a role change, undone to the old role` — existing viewer; detail `0x…(short) is a viewer on "<scene>". They become editor: they can change the scene.`; after approval, Undo POSTs role `viewer` back.
- `add_scene_collaborator for a new collaborator is undone by removing them` — Undo is `DELETE /api/scenes/:sceneId/roles/:wallet`.
- `add_scene_collaborator refuses an unknown reference and the host's wallet, with no card` — `[wallet 9]` → `I don't have that wallet. Ask the user to paste it again.`; the host's wallet → `That wallet is the scene's host.`
- Authz walk: samples for both tools with B's scene.

- [ ] **Step 2: Run them to see them fail**

Run: `cd apps/server && TEST_DATABASE_URL=postgres://localhost/vlm_test_2c_t4 npx vitest run test/assistant-tools.test.ts test/assistant-tools-authz.test.ts`

- [ ] **Step 3: Implement in `tools/collaborators.ts`**

- `add_scene_collaborator` `{ sceneId: uuid, wallet: string (max 50), role: 'cohost' | 'editor' | 'viewer' }`. `before` resolves the wallet (ToolError 400 on null), reads `GET /api/scenes/:sceneId/roles` unredacted server-side for the host wallets and the existing role, and returns the undo (`POST` old role, or `DELETE`) with `after`/`current` on `{ wallet, role }`. `call` POSTs the resolved wallet. The description says to pass the `[wallet N]` reference from the user's message as it appears, and that removing someone is done on the scene's Roles tab (`open_page /scenes/<id>`).
- `label`: `Add a collaborator as <role>` (no wallet in labels: they're stored and shown in Settings, masked).

- [ ] **Step 4: Run the tests to see them pass**

Same command. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A apps/server && git commit -m "feat(assistant): add or change a scene collaborator from a card"
```

---

### Task 5: Prompt rules, docs, full suite

**Files:**
- Modify: `apps/server/src/assistant/prompt.ts` (`RULES`), `apps/docs/src/content/docs/dashboard/assistant.md`
- Test: `apps/server/test/assistant-loop.test.ts` (a RULES assertion, if one exists for 2b's rules, extended)

- [ ] **Step 1: Rules**

Replace the "You can't deploy or publish scenes, invite people…" rule with:
- `You can redeploy a scene to the destinations it already has (redeploy_scene, after get_scene_publishing; pass every destination unless the user names some) and add or change a collaborator (add_scene_collaborator). Each shows the user a card first. You can't connect new destinations, remove collaborators, delete anything or change billing: offer the page with open_page. For a destination that needs the user's signature, give its deploy page with open_page /publish?d=<id>.`
- `When a deploy fails, use explain_deploy_failure and say what went wrong in plain words and the next thing to try.`
- `Wallets the user typed appear as [wallet 1], [wallet 2]: pass them to tools exactly like that. Never ask the user to type a wallet again unless a tool says it doesn't have it.`

- [ ] **Step 2: Docs**

In `assistant.md`: a "Running things" section (redeploy card, what happens with signing destinations, failure explanations, collaborators and that removing is on the Roles tab, wallets shown shortened on cards), and update "What it can't do yet".

- [ ] **Step 3: Full suite and typecheck**

Run: `cd apps/server && npx tsc --noEmit && TEST_DATABASE_URL=postgres://localhost/vlm_test_2c_full npx vitest run; dropdb --if-exists vlm_test_2c_full`
Expected: all pass. Web: `cd apps/web && npx tsc --noEmit`.

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "feat(assistant): 2c rules and docs"
```

---

## Rulings made while planning

- Signing destinations aren't sent to the deploy route: that route would prepare a deploy that expires unsigned. The card names them and the assistant links each deploy page. Cost if wrong: one extra click per signing destination.
- The card binds destination ids, not "all destinations", so nothing the card didn't name is deployed.
- User-typed wallets become `[wallet N]` references (Task 1). Without them the tool can't work at all, since phase 1 masks every other wallet before the model. Cost if wrong: a small column and a masking change.
- `list_scene_collaborators` is added (not in the spec) so the assistant can say who's on a scene before changing a role.
