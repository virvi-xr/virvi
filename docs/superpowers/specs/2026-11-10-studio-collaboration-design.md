# Design Studio collaboration, team chat and the notification bell (LIV-159)

Status: phase 1 built, 2026-11-10. Linear: LIV-159. Owner decisions are marked **(owner)**; everything else marked
**(Claude's call)** can be changed by the owner while reviewing.

## Why

People want to make Design Studio pieces together: friends making matching outfits for fun, and creators working with
a client or a co-founder on a collection they'll sell **(owner: both)**. Today a design belongs to one account: every
Studio route, the live room, the downloads and the conversation assume a single owner. This adds:

1. **Sharing:** the owner invites other people to a design; they can prompt it, see it live, finalize and pay, and
   download everything.
2. **A shared prompt pool** per design, on top of everyone spending their own prompts.
3. **Team chat:** members can talk to each other in the design's conversation without starting a build, and the agent
   reads that chat as context the next time someone prompts it.
4. **A notification bell** in the site header, a general system that starts with three kinds of notification.

## Goals

- Several accounts work on one design as if it were each of theirs, live, with clear names on everything.
- Nobody ever pays or spends prompts for someone else unless they chose to (the pool).
- A removed person loses access everywhere at once.
- People find out about invites, new prompts and ready packages without having to look.

## Non-goals

- Shared ownership. One owner per design; only the owner manages people and the design itself.
- Splitting payments or revenue, or anything about who sells the finished items. Every member can download the
  packages; what they do with them on Decentraland is outside Virvi. Virvi doesn't publish to the Builder.
- Running two jobs at once on a design. Still one job at a time.
- Notifications for team chat, agent replies, or anything other than the three kinds below. No email except invites.
  No mute settings.
- Real-time co-editing of the prompt box.

## Anti-goals (would be a failure even if it works)

- A collaborator's prompt counted against the owner's allowance, cost ceiling or try-again limit, or a payment charged
  to anyone but the payer.
- A removed collaborator, a stranger or a viewer able to read or do anything through any route, the live room,
  downloads, notifications or the worker-facing data that a role doesn't allow.
- Team chat quietly sent to the agent without people being told.
- The bell becoming noisy: one item per prompt on a busy design.

## Roles **(owner, from LIV-159)**

| | Owner | Collaborator | Viewer |
|---|---|---|---|
| See the design, conversation, previews, pieces live | yes | yes | yes |
| Send prompts to the agent, use "Improve my prompt", upload references, rate, try again, request renders | yes | yes | no |
| Team chat | yes | yes | no **(Claude's call: the chat goes to the agent, so posting is steering)** |
| Add to / take back from the pool | yes | yes | no |
| Finalize and pay | yes | yes | no |
| Download finalized packages | yes | yes | yes **(Claude's call: "everyone gets the assets")** |
| Invite, change roles, remove, rename, archive, delete | yes | no | no |

- **How many:** no product limit **(owner)**. A technical cap of 50 members per design, a config value, protects the
  live room.
- **Leaving:** any member can leave; the owner can remove anyone. Access ends immediately, live room included.
- A member who leaves or is removed keeps the packages finalized while they were a member **(owner)**, and loses the
  design and anything finalized after they left. They keep them as downloads from a "Finalized while you were on it"
  list on their Studio page **(Claude's call on where)**.
- Messages they sent stay in the history with their name.
- Virvi support access (LIV-141) is unchanged and separate.
- **Changing the agent** (Claude, Codex, Grok) is owner-only **(Claude's call: it changes the cost of everyone's next
  prompt)**.
- **Account states are per person** **(Claude's call)**: pauses, off-topic strikes, flags and plan limits follow the
  person who acted, not the design owner. A paused owner can't prompt, but their collaborators can keep working with
  their own prompts. `maybeFlag`, `studio_pauses` and off-topic accounting move from `ownerId` to the sender.
- **When the owner deletes their account (owner):** each shared design passes to its longest-standing collaborator,
  who becomes the owner; the design, its history and every package stay. If there are only viewers, the
  longest-standing viewer becomes the owner **(Claude's call)**; with no other members, the design is deleted as today.
  The new owner gets a notification, and the old owner's pool contributions are returned to nobody (they're dropped,
  as the account is gone) **(Claude's call)**. Packages the old owner paid for stay downloadable by every member.
  Payments and refunds that were the old owner's stay attached to their (deleted) payment records.
- The owner's account limits (open designs, total designs) count only designs they own. A shared design never counts
  against an invitee.

## Inviting **(owner: by email, even without an account)**

- The owner invites by email address and picks a role (collaborator by default).
- **Existing account with that email:** the invite appears in their bell and at the top of their Studio page under
  "Invited to a design", with Accept and Decline. If SMTP is configured, they also get an email with a link to the
  design's invite page.
- **No account yet:** the invite waits on the email address. Virvi doesn't verify email addresses, so a no-account
  invite is claimed only through its link, which proves the person can read that inbox: the link takes them to sign
  up (or sign in) and then accepts. Signing up later with the same address without the link doesn't claim it
  **(Claude's call)**.
- **Matching an existing account** is by its email, case-insensitive, at the moment the owner sends the invite: the
  owner typed that address, so the account holding it is the one they meant **(Claude's call)**.
- **Copy invite link:** the owner can copy any pending invite's link from the People panel and send it themselves,
  so invites work even when SMTP isn't configured **(Claude's call)**.
- Invites expire after 14 days **(Claude's call)**; the owner can cancel or resend a pending one. The owner sees
  pending invites in the design's People panel.
- Trial (guest) accounts can't be invited or accept until they've signed up. Wallet-only accounts without an email
  can't be invited by email; that's acceptable for now **(Claude's call)**.
- A paused Studio account can accept, view, finalize and pay, but can't prompt, chat or add to the pool. Pausing never
  blocks paying **(owner, 2026-11-10)**.
- Follow the org invite pattern that exists (`orgInvites`: email, token, expiry; `sendOrgInviteEmail`), but in its own
  table; designs are not orgs.
- Rate-limit invites per owner (e.g. 50 a day) so the feature can't be used to send email spam.
- The design's page gets a **People** panel (owner: invite, roles, remove, pending invites; others: the member list and
  Leave).

## Prompts: your own, plus a pool **(owner, from LIV-159)**

- **Everyone spends their own prompts.** A prompt counts against its **sender**: their daily allowance, gifted
  prompts and bought prompts, plus their own cost ceiling, their own "Improve my prompt" limit and their own daily
  try-again limit. Today all of these use `design.ownerId`; they move to the sender. The job records its sender, and
  its cost, give-back and off-topic accounting go to the sender (`studio/results.ts`).
- **The pool:** any collaborator can put some of their **gifted or bought** prompts into the design's pool, and any
  collaborator can spend from it. The daily allowance can't be pooled.
- **Order when sending:** the sender's daily allowance, then the design's pool, then the sender's gifted, then bought
  prompts.
- A pooled prompt that was originally bought is still stopped by the **sender's** cost ceiling, as bought prompts are
  today; a pooled gifted prompt skips it, as gifted prompts do. So each pool contribution keeps its kind.
- The pool panel shows what's left and who added what, and what each person has used from it **(Claude's call)**.
- A member can take back their unspent contribution any time. Unspent contributions return to whoever added them when
  that person leaves or is removed, or when the design is archived or deleted. When a pool has several givers, spend
  the oldest contribution first **(Claude's call)**, so take-backs are predictable.
- A given-back prompt (job error, lost) returns to where it came from: the pool contribution it was taken from, or the
  sender's own allowance, gift or credit. If that contribution has since been taken back or returned, it goes to the
  person who added it.
- Ledger every pool movement (add, spend, give back, take back, return) so the counts can always be explained.
- Free prompts stay free for whoever sends them: Continue, fixing the checks, a clipping report. A try-again counts
  against the sender's try-again limit.
- Trials: a trial owner can't share (they can't invite until they've signed up), so a trial is never on a shared
  design.

## Finalizing and the assets **(owner, from LIV-159)**

- Any collaborator can finalize and pay with their own card, credit, gift code or MANA. Only the payer is charged;
  refunds and "report a mistake" refunds go back to the payer under the existing rules. `studioPayments.userId`
  already records the payer.
- Credit and gift lookups (`creditFor`, `giftsFor`) use the payer.
- Every current member can download every finalized package on the design, whoever paid.
- A scene piece added to the asset library goes to the **payer's** library **(Claude's call)**; any member can download
  its package.
- **Report a mistake:** at checkout the payer writes the reports for the lines they pay for (it's part of their
  checkout). After payment, only the payer can report a mistake on that revision, since the refund is theirs.
  Waivers keep working on the revision whoever checks out next. Review stays as it is today **(Claude's call)**.
- When someone else is mid-checkout for a piece, the others see that and can't start a second payment for the same
  revision (the existing duplicate-payment rules must hold across members).

## Team chat **(owner)**

- The prompt box gets a switch: **To the agent** (default) and **To the team**.
- A team message appears in the same timeline with the sender's name, styled differently from prompts (a lighter
  bubble, no agent styling) **(Claude's call on the look)**.
- A team message is sent to everyone on the design live. It never starts a job, never uses a prompt and never goes
  through the off-topic check.
- **The agent always gets the conversation between collaborators (owner):** when anyone sends a prompt, the job
  includes every team message since the agent's last reply, each labelled with the sender's display name. The agent
  doesn't reply to team messages; it only reads them when someone prompts it.
- Cap the team context sent with one prompt (about 3,000 words, most recent first kept) **(Claude's call)**, so a
  chatty design doesn't make one person's prompt expensive. The sender pays for that context, like the rest of their
  prompt.
- The team switch carries a line: "The agent reads team messages when it works on the next prompt."
- **Scope check:** only the sender's own words are checked. The team context goes to the worker as a separate field in
  the job payload (a worker contract change, documented in `CONTRACT.md`), which the worker adds to the agent's input
  as context from teammates, never as the user's request. A worker image that predates the field ignores it; the
  agent then just doesn't see the chat until the new image is released.
- Once a design has more than one member, each prompt reaches the agent with its sender's display name in front
  ("Sam: make the visor red"), so the agent can tell who asked for what. This is added by the server to the prompt
  text, in phase 1, with no worker change **(Claude's call)**. The scope check ignores the name prefix.
- Every message in the conversation, prompts included, shows its sender's display name. `studio_messages` gains the
  sender's user id; older messages are the owner's.
- Length limit for one team message: 2,000 characters **(Claude's call)**. Rate limit per sender.
- Team chat on a single-person design: hide the switch until there's a second member **(Claude's call)**.

## Working together live

- The live room (`virvi_studio`) admits every member and Virvi admins; it re-checks membership on join, and a removed
  member is disconnected at once.
- While a job runs, everyone's box says whose prompt the agent is on ("Working on Sam's prompt"), and the agent
  switch is disabled for everyone until it finishes. Team chat stays open during a job.
- Guests poll today; they can't be members, so nothing changes for them.

## The notification bell **(owner)**

- A bell in the site header on every signed-in page, with a red count of unread notifications.
- Clicking opens a short list, newest first; each item links to its design; opening an item marks it read; "Mark all
  read" clears the count. Keep 90 days **(Claude's call)**.
- The count updates live while the person is on the site, and otherwise on page load. Live delivery can be a per-user
  channel on the existing realtime server or polling every 30–60 s; the builder picks **(Claude's call: either is
  fine)**.
- A general table and API (`notifications`: user, kind, data, read state, timestamps), so other features can add
  kinds later. Notifications never contain prompt text, chat text or anything private beyond names and design titles.
- **Kinds at launch:**
  - **Invite:** "Sam invited you to *Neon cap*", with Accept and Decline in the list. Cleared when acted on,
    cancelled or expired.
  - **New prompts:** "Sam sent a prompt on *Neon cap*", to every other member, never the sender. Grouped: while an
    unread item exists for that design, later prompts update it ("Sam and Alex sent 4 prompts on *Neon cap*") instead
    of adding new ones.
  - **Package ready:** "The hat package for *Neon cap* is ready to download", to every member.
- A removed member's notifications for that design stop linking to it (the design shows as no longer shared).

## Access rules that must hold

- Membership and role are checked on every Studio route (the existing `designAccess` / `ownDesign` /
  `supportDesign` helpers become role-aware), the live room, package downloads, uploads, renders, the prompt-ideas and
  prompt-help routes, the warm route, and anything the worker-facing routes expose.
- A removed collaborator and a stranger get the same 404. A viewer gets 403 for actions their role doesn't allow, or
  404 where the existing pattern hides existence **(builder follows the existing pattern)**.
- Every new route is walked in `apps/server/test/cross-account-walk.test.ts`, and trial guards are updated
  (`trial-guard` tests).
- Account merges (`studio/merge.ts`) carry memberships, invites, pool contributions and notifications over.

## Phasing **(Claude's call)**

1. **Sharing and access:** members and roles, invites by email (including no-account invites), the People panel,
   "Shared with me" and "Invited to a design" on the Studio page, prompts counted against the sender, sender names on
   messages, "working on X's prompt", finalize by any collaborator, downloads for every member, and the bell with the
   three kinds. This is useful on its own.
2. **The pool:** contributions, spending order, take-backs, returns, the ledger and the pool panel.
3. **Team chat:** the switch, team messages, the worker contract field and a worker image release.

Each phase ships on its own. Each phase's deploy and the worker image release need the owner's OK.

## Left to the builder

- Table and column names, migrations (drizzle schema plus the hand-written boot fallback, as the Studio README
  describes), indexes.
- Exact copy beyond what's quoted, following the copy rules: short plain sentences, no exclamation marks, no emoji.
- The People panel and bell layouts, following the existing components; phone width must work.
- Live delivery for the bell (realtime channel or polling).
- How the worker formats team context for the agent, as long as it's clearly marked as teammates' messages and never
  as the user's request.
