# Design Studio collaboration, phase 1 (sharing, access, invites, the bell) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a design's owner invite other people by email as collaborators or viewers who can work on the design live, with every prompt and payment counted against the person who made it, and a notification bell for invites, new prompts and ready packages.

**Architecture:** A membership table beside `studio_designs` (the owner stays `studio_designs.owner_id`) and one role lookup that every Studio route, the live room and the downloads go through. Prompt jobs and messages record their sender, and all quota, cost and flag accounting moves from the design owner to the sender. A general `notifications` table and API, with a bell in the dashboard shell that polls.

**Tech Stack:** Fastify + Drizzle + Postgres (apps/server), Colyseus room `virvi_studio`, Next.js app router + Tailwind (apps/web), Vitest in both.

**Spec:** `docs/superpowers/specs/2026-11-10-studio-collaboration-design.md` (phase 1 only: no pool, no team chat).

## Global Constraints

- Work only in the worktree `/Users/unknower/-VLM/vlm-v2/.worktrees/liv-159-design`. Never touch `/Users/unknower/-VLM/vlm-v2` itself. Never bare `git stash`. No push, deploy or worker image release.
- Node 22: `export PATH=$HOME/.nvm/versions/node/v22.23.3/bin:$PATH`; `corepack pnpm`. Before the server tsc: `corepack pnpm install --frozen-lockfile` and `corepack pnpm --filter "@virvixr/server^..." build`.
- Server tests: `cd apps/server && npx vitest run <files>` (the test DB is dropped per run: never run two server suites at once). Web: `cd apps/web && npx vitest run`.
- Schema changes: drizzle schema in `apps/server/src/db/schema.ts` **and** the hand-written boot fallback in `apps/server/entrypoint.sh`, as `apps/server/src/studio/README.md` describes; README updated.
- No worker change in this phase (`apps/studio-worker` untouched).
- Copy: short plain sentences, no exclamation marks, no emoji. Phone width must work.
- Limits (spec): 50 members per design (config `studioMaxMembers`, default 50, members + pending invites); invites expire after 14 days; 50 invites per owner per UTC day; notifications kept 90 days.
- Roles: `owner` (studio_designs.owner_id), `collaborator`, `viewer`. Non-members and removed members get the same 404 as a stranger; a viewer on an action route gets `403 { error: 'viewer', code: 'viewer' }`.
- Trial (guest) accounts can't invite, be invited, or accept (`403 { error: 'account_required' }`). A paused account can accept, view, finalize and pay, not prompt or render (the existing `isPaused(request.user.id)` refusal). Pausing never blocks paying (owner, 2026-11-10).
- Notifications never carry prompt or chat text: names and design titles only.
- Every new `:param` route is walked in `apps/server/test/cross-account-walk.test.ts` and listed in `apps/server/test/trial-guard.test.ts` per the existing rules, in the task that adds it.
- Commit trailer on every commit:
  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_018ds2NZXw5KLxDpVm9B3ABD
  ```

## Review Focus

1. **A removed member with the page still open** keeps polling and holds a room connection: every read 404s and the room drops them at once (Task 2 test `removed member is disconnected from the room`).
2. **Two members race the one-job-at-a-time lock**: the second gets `409 busy` and is not charged (Task 3 test `second member's prompt while one runs is busy and uncounted`).
3. **An invite email typed with different case or spaces** (`  Sam@X.com`) matches the account `sam@x.com`, and a second invite to the same person is refused (Task 4 test `invite email is trimmed and case-insensitive; duplicate is 409`).
4. **The owner deletes their account while a collaborator has paid packages**: the delete succeeds, the design and packages survive under the new owner (Task 7 test `owner deletion hands over and keeps a collaborator's paid package`).
5. **A busy design spams the bell**: five prompts by two people make one unread item (Task 5 test `prompts group into one unread item per design`).

---

### Task 1: Schema

**Files:**
- Modify: `apps/server/src/db/schema.ts`, `apps/server/entrypoint.sh`, `apps/server/src/studio/README.md`, `apps/server/src/config.ts` (`studioMaxMembers`)
- Test: `apps/server/test/studio-schema.test.ts`

**Interfaces:**
- Produces:
  - `studioDesignMembers` (`studio_design_members`): `id uuid pk`, `designId` → studio_designs cascade, `userId` → users cascade, `role text` ('collaborator'|'viewer'), `joinedAt timestamptz`, `leftAt timestamptz null`. Partial unique index on (design_id, user_id) where left_at is null; index on user_id. Rows are kept after leaving (leftAt set) for "Finalized while you were on it".
  - `studioDesignInvites` (`studio_design_invites`): `id uuid pk`, `designId` → cascade, `email text` (trimmed, lower-cased), `role`, `token text unique` (32 random bytes base64url, stored plainly like `orgInvites.token`), `invitedBy uuid`, `userId uuid null` (the account matched at send time) → users cascade, `createdAt`, `expiresAt`, `acceptedAt`, `declinedAt`, `cancelledAt` (all null). Partial unique index on (design_id, email) where accepted/declined/cancelled are all null.
  - `studioMessages.userId uuid null` (the sender; null means the owner, for old rows) and `studioJobs.userId uuid null` (the prompt's sender; null means the owner).
  - `notifications`: `id uuid pk`, `userId` → users cascade, `kind text`, `data jsonb`, `groupKey text null`, `createdAt`, `updatedAt`, `readAt null`. Index (user_id, created_at desc); partial unique (user_id, group_key) where read_at is null and group_key is not null.
  - `studioPayments.userId` becomes **nullable with ON DELETE SET NULL** (today cascade): after a hand-over a deleted payer's payment must not take the entitlements (FK, no cascade) with it or block the delete.

- [ ] **Step 1: Failing test** in `studio-schema.test.ts`: `it('has the collaboration tables and columns')` inserting a member, an invite, a notification and a message/job with `userId`, and `it('a payment survives its payer being deleted, with user_id null')`; and `it('a second open membership for the same user and design is refused')` (unique violation `23505`).
- [ ] **Step 2:** Run `npx vitest run test/studio-schema.test.ts` → FAIL (tables missing).
- [ ] **Step 3:** Add the schema, the entrypoint fallback (CREATE TABLE IF NOT EXISTS / ADD COLUMN IF NOT EXISTS / the FK change, idempotent), the README lines, and `studioMaxMembers` in config (env `STUDIO_MAX_MEMBERS`, default 50).
- [ ] **Step 4:** Run the test → PASS; run server tsc.
- [ ] **Step 5:** Commit `feat(studio): collaboration schema (members, invites, senders, notifications)`.

### Task 2: Roles and access everywhere

**Files:**
- Create: `apps/server/src/studio/members.ts`
- Modify: `apps/server/src/routes/studio.ts` (`designAccess`, `ownDesign`, `supportDesign` and every route), `apps/server/src/ws/VirviStudioRoom.ts`, `apps/server/src/studio/events.ts`
- Test: `apps/server/test/studio-members.test.ts`, `apps/server/test/studio-room.test.ts`

**Interfaces:**
- Produces:
  - `type DesignRole = 'owner' | 'collaborator' | 'viewer'`
  - `designRole(designId: string, userId: string, exec?: Exec): Promise<DesignRole | null>` (owner from studio_designs; else the open membership row)
  - `memberIds(designId: string, exec?: Exec): Promise<string[]>` (owner first, then open members by joinedAt)
  - `memberCount(designId: string, exec?: Exec): Promise<number>` (open members, owner excluded)
  - In routes: `designAccess(request, { need: 'view' | 'work' | 'own', allowAdmin?: boolean })` returning `{ d, role, support } | null` or the viewer refusal. `ownDesign` = need 'own'. Remove the "a design belongs to its owner alone" header comment.
  - `StudioEvent` gains `{ type: 'member_removed'; userId: string }`; the room disconnects that user's clients when it hears it.
- Route needs (by path): `GET designs/:id`, `GET packages`, `GET piece package`, `GET uploads/:uploadId`, `GET set`, `GET people` (Task 4) → **view**. `PATCH designs/:id` (rename, archive, agent) and member management → **own**. Everything else under `/designs/:id` (prompts, prompt-ideas, prompt-help, warm, rating put/delete, try-again, GET/POST finalize, report, package retry, uploads POST/DELETE, renders, set-renders, emote-checks, clipping, finalize-renders) → **work**. Support (`allowAdmin`) stays on exactly the routes that have it today.
- `GET /api/studio/designs` lists owned designs plus open-membership designs; each item gains `role` and, for shared ones, `ownerName`. Shared designs never count in `openDesignCount`/`totalDesignCount`.
- The design detail gains `role` and `members: [{ userId, displayName, role }]` (owner first).

- [ ] **Step 1: Failing tests** (`studio-members.test.ts`): `designRole` for owner/collaborator/viewer/left/stranger; a collaborator can GET the design and POST a prompt (201); a viewer GETs (200) and POST prompt → 403 `viewer`; a viewer can download a ready package; a left member and a stranger → 404 on GET and on a prompt; collaborator PATCH rename → 404 (own-only routes hide); the list shows a shared design with `role: 'collaborator'` and `ownerName`, and it isn't counted in the collaborator's open designs. In `studio-room.test.ts`: `a collaborator can join the room`, `a viewer can join`, `a stranger is Unauthorized`, `removed member is disconnected from the room` (publish `member_removed`, the client's connection closes).
- [ ] **Step 2:** Run both files → FAIL.
- [ ] **Step 3:** Implement `members.ts`, the role-aware `designAccess`, the per-route needs above, the list/detail fields, and the room's `onAuth` (`designRole` not null, or Virvi admin) and `member_removed` handling.
- [ ] **Step 4:** Run both files and `test/studio-routes.test.ts test/studio-admin-help.test.ts` → PASS.
- [ ] **Step 5:** Commit `feat(studio): design roles on every route and the live room`.

### Task 3: The sender pays and is named

**Files:**
- Modify: `apps/server/src/studio/designs.ts` (`queuePrompt`, `designDetail`, `usage`), `apps/server/src/studio/results.ts`, `apps/server/src/studio/ratings.ts`, `apps/server/src/studio/warm.ts`, `apps/server/src/routes/studio.ts` (prompt, try-again, prompt-help, warm, finalize quote)
- Test: `apps/server/test/studio-sender.test.ts`

**Interfaces:**
- Consumes: `memberCount`, `designRole` (Task 2).
- Produces:
  - `queuePrompt(design, input & { senderId: string }, now)`; `requestRender`/others unchanged.
  - Helper `jobPayer(job, design): string` = `job.userId ?? design.ownerId`, used by every cost, give-back, off-topic, scope-event and flag call in `results.ts` (lines that use `design.ownerId` today: cost day, `recordCost`, `offTopicIsFree`, `refundPrompt`, scope event `userId`, `maybeFlag`, lost-job refund).
  - `tryAgainBlock(exec, designId, senderId, jobId, now)` and `lockTryAgains(exec, senderId)`; `tryAgainsToday` counts by `COALESCE(j.user_id, d.owner_id) = sender`.
  - Detail messages gain `sender: { userId, displayName } | null` (null for agent/system); the open job in the detail gains `senderName`. The `job` queued event gains `senderName`.
- Rules: the reservation, the trial checks (`promptStatus`, `account_required`, `trial_busy`), the try-again limit, prompt-help's `takePromptHelp`, warm's "could this account prompt now" check, and `giftsFor`/`creditFor` on the finalize quote all use the **request user**. The message and job rows store `userId = senderId`. Support prompts keep `byAdminId` and stay uncounted. When `memberCount(d.id) > 0`, the prompt sent to the agent is `${senderDisplayName}: ${words}` (after the support prefix logic; not for Continue, fix-checks or clipping text).

- [ ] **Step 1: Failing tests** (`studio-sender.test.ts`): `a collaborator's prompt counts on the collaborator, not the owner` (owner's `studio_usage_days` untouched); `its cost and a give-back go to the collaborator` (post a result with `costUsd`, then an `error` job → refunded to the collaborator's source); `a collaborator over their allowance is refused even when the owner has prompts left`; `try-again limit is per sender`; `prompt-help counts on the sender`; `second member's prompt while one runs is busy and uncounted`; `on a shared design the agent's prompt starts with the sender's name; on a solo design it doesn't`; `detail messages carry sender names; old rows without user_id show the owner`.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement as above.
- [ ] **Step 4:** Run the new file plus `test/studio-quota.test.ts test/studio-ratings.test.ts test/studio-prompt-help.test.ts test/studio-warm.test.ts test/studio-routes.test.ts` → PASS.
- [ ] **Step 5:** Commit `feat(studio): prompts count against and are named for their sender`.

### Task 4: Invites and people

**Files:**
- Create: `apps/server/src/studio/invites.ts`
- Modify: `apps/server/src/routes/studio.ts` (new routes), `apps/server/src/services/email.ts` (`sendDesignInviteEmail`)
- Test: `apps/server/test/studio-invites.test.ts`, `cross-account-walk.test.ts`, `trial-guard.test.ts`

**Interfaces:**
- Consumes: `designRole`, `memberIds`, `memberCount`, `member_removed` (Task 2); `notify` (Task 5: if Task 5 isn't merged yet, leave a single call site `notifyInvite(invite)` that Task 5 fills).
- Produces (routes; all `auth` unless noted, none open to trials):
  - `GET /api/studio/designs/:id/people` (view): `{ members: [{ userId, displayName, role, joinedAt }], invites?: [{ id, email, role, expiresAt, link }] }`. `invites` only for the owner.
  - `POST /api/studio/designs/:id/invites` (own) `{ email, role? = 'collaborator' }` → `201 { invite }`. 400 bad email or role; 409 `already_member` / `already_invited` (open invite to the same normalized email); 409 `members_full` when members + open invites ≥ `studioMaxMembers`; 429 `invite_limit` after 50 today; 400 `self` for the owner's own email. Matches `users.email` case-insensitively at send time into `userId`. Sends the email when SMTP is set (link `${WEB_APP_URL}/studio/invite/${token}`).
  - `POST /api/studio/designs/:id/invites/:inviteId/cancel` and `/resend` (own). Resend: new expiry (14 days from now), same token, email again.
  - `GET /api/studio/invites` → my open, unexpired invites where `userId = me`: `[{ id, designId, designName, inviterName, role, expiresAt }]`.
  - `POST /api/studio/invites/:inviteId/accept` and `/decline` (the matched account only; others 404).
  - `GET /api/studio/invite-links/:token` (auth): `{ designName, inviterName, role, status: 'open' | 'expired' | 'used' }`; `POST /api/studio/invite-links/:token/accept` (auth): any signed-in non-trial account holding the link accepts (this is how no-account invites are claimed).
  - `PATCH /api/studio/designs/:id/members/:userId` (own) `{ role }`; `DELETE /api/studio/designs/:id/members/:userId`: the owner removes anyone, a member removes only themselves (leave). Sets `leftAt`, publishes `member_removed`. The owner can't be removed or leave (400 `owner`).
  - Accept: creates the open membership (re-joining after leaving makes a new row), marks the invite accepted, 409 `members_full` if the cap was reached since.
- Invites are cancelled when the design is archived (`PATCH` archive) and can't be sent on an archived design (409 `archived`).

- [ ] **Step 1: Failing tests** (`studio-invites.test.ts`): owner invites an existing account → it appears in that account's `GET /api/studio/invites`, accept makes them a collaborator; `invite email is trimmed and case-insensitive; duplicate is 409`; decline; cancel; expired invite (fake `now` + 15 days) can't be accepted; a no-account invite isn't in anyone's list but its link accepts for whoever signs up and opens it; a used link shows `used`; a trial can't invite (403) or accept (403); a collaborator can't invite (404); `members_full` at the cap (set `studioMaxMembers` to 2 in the test); 51st invite in a day → 429; owner removes a collaborator → 404 for them afterwards and a `member_removed` event; a viewer leaves; role change collaborator → viewer then prompt → 403; email sent only when SMTP set (stub `sendEmail`).
- [ ] **Step 2:** Add every new route to `cross-account-walk.test.ts` (B's design, invite and token reached by A → 404) and `trial-guard.test.ts`. Run → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the three files → PASS.
- [ ] **Step 5:** Commit `feat(studio): invite people to a design by email, roles, remove and leave`.

### Task 5: Notifications

**Files:**
- Create: `apps/server/src/notifications/notifications.ts`, `apps/server/src/routes/notifications.ts` (registered where the other route modules are)
- Modify: `apps/server/src/studio/invites.ts` (invite kind), `apps/server/src/studio/designs.ts` (after a queued prompt), `apps/server/src/studio/payments.ts` (where an entitlement becomes `ready`), the existing Studio sweep (`apps/server/src/studio/sweep.ts`) for the 90-day prune
- Test: `apps/server/test/notifications.test.ts`, `cross-account-walk.test.ts`, `trial-guard.test.ts`

**Interfaces:**
- Produces:
  - `notify(userId: string, kind: NotificationKind, data: Record<string, unknown>, opts?: { groupKey?: string; merge?: (old: data, next: data) => data }, exec?: Exec): Promise<void>`: with a groupKey and an unread row for it, updates that row's data via `merge` and `updatedAt`; else inserts.
  - `type NotificationKind = 'studio_invite' | 'studio_prompts' | 'studio_package_ready' | 'studio_owner'`
  - Data: `studio_invite { inviteId, designId, designName, inviterName, role }`; `studio_prompts { designId, designName, senders: string[] (display names, unique, in order), count }` with groupKey `studio_prompts:<designId>`; `studio_package_ready { designId, designName, category }`; `studio_owner { designId, designName }` (Task 7).
  - Routes (auth; trials get an empty list and 0): `GET /api/notifications?before=<iso>&limit=20` → `{ items: [{ id, kind, data, createdAt, updatedAt, readAt, gone }], more }` newest by `updatedAt`; `GET /api/notifications/unread-count` → `{ count }`; `POST /api/notifications/:id/read`; `POST /api/notifications/read-all`. `gone: true` when the item names a design the viewer no longer has a role on (invites: when the invite is no longer open).
  - Hooks: invite sent to a matched account → `studio_invite`; the invite's notification is marked read when accepted, declined, cancelled or expired. A queued counted-or-free prompt by sender S → `studio_prompts` to every member and the owner except S (support prompts notify the owner and members, with sender name "Virvi support"). An entitlement turning `ready` → `studio_package_ready` to the owner and every current member.
- Prune: delete notifications with `updatedAt` older than 90 days in the existing periodic sweep.

- [ ] **Step 1: Failing tests** (`notifications.test.ts`): `invite creates a notification for the matched account and accepting marks it read`; `prompts group into one unread item per design` (5 prompts by two people → one item, `count: 5`, `senders: ['Sam','Alex']`; after reading it, the next prompt makes a new item); `the sender isn't notified`; `package ready notifies owner and members`; `a removed member's items show gone`; `unread-count and read-all`; `another user's notification id → 404 on read`; `prune removes items older than 90 days`; `no notification data contains the prompt text`.
- [ ] **Step 2:** Walk + trial-guard entries for the `:id` route. Run → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run → PASS, plus `test/studio-invites.test.ts test/studio-payments.test.ts`.
- [ ] **Step 5:** Commit `feat: notifications (invites, new prompts, packages ready)`.

### Task 6: Finalizing and downloads for members

**Files:**
- Modify: `apps/server/src/routes/studio.ts` (report route, past packages), `apps/server/src/studio/payments.ts` (`reportMistake` payer check, `readyPackages`), `apps/server/src/studio/library.ts`
- Test: `apps/server/test/studio-shared-finalize.test.ts`, `cross-account-walk.test.ts`

**Interfaces:**
- Consumes: Task 2 roles.
- Produces:
  - Finalize by a collaborator charges the request user (`createFinalizeCheckout(d, { id: request.user.id, ... })` already does; verify card, credit, gift and MANA paths each record `studioPayments.userId` = the collaborator and touch no one else's balances).
  - `reportMistake(design, category, number, text, now, reporterId)`: 404 `not_found` unless the entitlement's `userId === reporterId`.
  - A scene piece added to the library on finalize goes to the **payer's** library (`library.ts` uses the payment's user, not `design.ownerId`, for `uploadedBy` and the storage key).
  - `GET /api/studio/past-packages` → `[{ entitlementId, designName, category, revisionNumber, finalizedAt }]`: entitlements that became ready while the caller had a membership row on that design (`joinedAt ≤ readyAt ≤ leftAt`) and on which they no longer have a role. `GET /api/studio/past-packages/:entitlementId/package` streams that package (404 otherwise).
  - Duplicate-payment rules hold across members: a second member starting checkout for a revision with an open payment gets the existing refusal.

- [ ] **Step 1: Failing tests**: `a collaborator pays by card; only they are recorded and charged`; same for credit and gift (balances of owner untouched); `every member downloads the package whoever paid`; `only the payer can report a mistake`; `a scene piece goes to the payer's library`; `a second member's checkout for the same revision is refused while one is open`; `a member who left lists and downloads packages finalized while they were on it, not later ones`; `a stranger gets 404 on past-packages/:id`.
- [ ] **Step 2:** Walk entry for `past-packages/:entitlementId/package`. Run → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run → PASS, plus `test/studio-finalize.test.ts test/studio-credit-checkout.test.ts test/studio-library.test.ts test/studio-partial-finalize.test.ts`.
- [ ] **Step 5:** Commit `feat(studio): any collaborator finalizes; every member downloads`.

### Task 7: Hand-over on account deletion, and merges

**Files:**
- Create: `apps/server/src/studio/handover.ts`
- Modify: `apps/server/src/routes/auth.ts` (self delete, near the `deleteUserWithModels` call), `apps/server/src/routes/admin.ts` (admin delete), `apps/server/src/studio/merge.ts`
- Test: `apps/server/test/studio-handover.test.ts`, `apps/server/test/studio-merge.test.ts`

**Interfaces:**
- Produces: `handOverDesigns(tx: Exec, userId: string, now: Date): Promise<number>`: for each design the user owns with open members, the earliest-joined collaborator becomes owner (else the earliest-joined viewer); their membership row closes (`leftAt = now`); the new owner gets `studio_owner`; open invites from the old owner on that design stay valid and become the new owner's to manage. Designs with no members are left for the existing cascade. Called inside the same transaction as the user delete, before it.
- `merge.ts` (account merge from A into B): moves A's memberships to B (closing a duplicate if B is already on the design, keeping the stronger role; B owning the design drops A's membership), A's invites' `userId`, A's notifications, and job/message `userId`s.

- [ ] **Step 1: Failing tests**: `owner deletion hands over and keeps a collaborator's paid package` (the collaborator becomes owner, the package still downloads, the payment row has `user_id` null if the owner had paid); `only viewers: the earliest viewer becomes owner`; `no members: the design is deleted as before`; `admin deleting a user hands over too`; `the new owner gets a studio_owner notification`; merge cases above.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run → PASS, plus `test/studio-merge.test.ts` and the account-delete tests (`grep -l "deleteUserWithModels\|/api/auth/account" test/`).
- [ ] **Step 5:** Commit `feat(studio): hand shared designs over when the owner's account is deleted`.

### Task 8: Web: sharing in the Studio

**Files:**
- Modify: `apps/web/src/lib/api.ts` (client calls for Tasks 2–6 routes), `apps/web/src/app/(dashboard)/studio/page.tsx`, `apps/web/src/app/(dashboard)/studio/[designId]/client.tsx`, `Conversation.tsx`, `PaidRevisions.tsx`
- Create: `apps/web/src/app/(dashboard)/studio/[designId]/People.tsx`, `apps/web/src/app/(dashboard)/studio/invite/[token]/page.tsx`, `apps/web/src/lib/studio-people.ts`
- Test: `apps/web/src/lib/studio-people.test.ts`

**Interfaces:**
- Consumes: the routes and fields above (`role`, `members`, `sender`, `senderName`, `ownerName`).
- Produces: `studio-people.ts` pure helpers: `canAct(role)`, `boxState(role, job, meId) -> 'open' | 'viewer' | { busyFor: string }`, `senderLabel(message, meId) -> 'You' | name | null`, `inviteStatusCopy(status)`.
- UI:
  - Studio page: "Invited to a design" (Accept / Decline) at the top when there are invites; "Shared with me" section listing shared designs with the owner's name; "Finalized while you were on it" when past packages exist.
  - Design page: a **People** button opening a panel. Owner: invite by email with a role select, the member list with role select and Remove, pending invites with Copy link / Resend / Cancel. Others: the member list and Leave (with a confirm in-page, not a browser dialog).
  - Each user message shows its sender ("You" for your own); while a job runs the box says "Working on Sam's prompt" (or "Working on your prompt") and is disabled; viewers see "You can view this design. Ask the owner to make you a collaborator to send prompts." instead of the box, and no Finalize/Renders/Upload actions.
  - Invite link page `/studio/invite/[token]`: signed out → sign-in/up with `next` back here (`signinPath(next, 'register')`); signed in → design name, inviter, role, Accept; trial → the existing sign-up prompt; expired/used → a plain line and a link to the Studio.
  - The PATCH agent picker is hidden for non-owners.

- [ ] **Step 1: Failing tests** for the helpers (each role, the busy state for me vs someone else, legacy messages without sender).
- [ ] **Step 2:** Run `npx vitest run src/lib/studio-people.test.ts` → FAIL.
- [ ] **Step 3:** Implement helpers and UI, following the existing components and Tailwind style.
- [ ] **Step 4:** Web tests and web tsc pass; check the Studio page, a shared design (as collaborator and as viewer) and the invite page at 390 px against a local server (see the Studio README for the local setup).
- [ ] **Step 5:** Commit `feat(web): share Studio designs: people panel, invites, shared list, sender names`.

### Task 9: Web: the bell

**Files:**
- Create: `apps/web/src/components/NotificationBell.tsx`, `apps/web/src/lib/notifications.ts`
- Modify: `apps/web/src/app/(dashboard)/layout.tsx` (sidebar header and the mobile top bar), `apps/web/src/lib/api.ts`
- Test: `apps/web/src/lib/notifications.test.ts`

**Interfaces:**
- Consumes: Task 5 routes.
- Produces: `notificationText(item) -> { text: string; href: string | null }` with the copy: `${inviterName} invited you to ${designName}`; one sender `${a} sent a prompt on ${designName}`, `count > 1` → `${names} sent ${count} prompts on ${designName}` (names: "Sam", "Sam and Alex", "Sam, Alex and 2 others"); `The ${category label} package for ${designName} is ready to download`; `You're now the owner of ${designName}`; `gone` → `${designName} is no longer shared with you`, no link. `href` is `/studio/<designId>` (invites: the Studio page).
- Behaviour: the bell shows the unread count (hidden at 0, "9+" above 9). It polls `unread-count` every 60 s while the tab is visible and on window focus; opening the list fetches the first 20 (More loads older). Clicking an item marks it read and navigates; invites have Accept and Decline in the list; "Mark all read". Signed-in accounts only (not trials, not scene passes).

- [ ] **Step 1: Failing tests** for `notificationText` (every kind, the names rule, gone) and the badge rule.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Web tests and tsc pass; check the bell at desktop and 390 px against the local server.
- [ ] **Step 5:** Commit `feat(web): notification bell`.

### Task 10: Whole-branch check

- [ ] **Step 1:** Run the full server suite in the background (about 10 minutes), the full web suite, server and web tsc.
- [ ] **Step 2:** `grep -n "ownerId" apps/server/src/studio/*.ts apps/server/src/routes/studio.ts` and confirm each remaining use is about ownership (rename, archive, agent, design limits, admin view, hand-over), not about who acted or who pays.
- [ ] **Step 3:** Update `apps/server/src/studio/README.md` (roles, invites, who pays) and the LIV-159 spec's status line to "phase 1 built".
- [ ] **Step 4:** Commit `docs(studio): collaboration phase 1`.
