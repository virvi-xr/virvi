# Design Studio: inspect from every angle, check the emotes, fix clipping free

**Status:** draft for the owner's approval. Marks: **(owner)** the owner decided it; **(call)** the author's call, open
to change.

## Intent

Someone designing a wearable today sees each piece alone on the avatar from eye level only, turning left and right, and
five emotes. They can't look at the top of a hat or the soles of a shoe, and the emotes are choppy. Each emote is 36
frames, captured while the animation plays live and the camera turns between captures, so each frame lands at whatever
moment the animation happens to be at. When an item pokes through the body during a dance, the only fix is to describe it in a prompt, which
costs them one of their prompts for what is the agent's mistake.

This design gives the preview a set of steps: **Design → Inspect → On avatar → Emotes → Finalize** **(owner)**. You can
turn the item every way, see it worn, play the animations Decentraland players actually use, and say "this clips in the
dance". The agent then fixes that free, looking at frames of that dance, and checks its fix before handing back
**(owner)**. Fewer clipping problems reach curation, and fewer reach buyers.

## Goals

- **Inspect:** the item on its own, turnable in every direction: all the way round, and tipped over the top and
  underneath (a shoe's sole, the inside of a hat) **(owner)**.
- **Smoother emotes:** more frames per emote than today's 36 **(owner)**.
- **Run and jump:** the emote list becomes idle, wave, dance, clap, walk, run, jump **(owner)**. Run and jump are where
  items most often clip. Both play by name in Decentraland's wearable-preview page today (checked 2026-11-01: a made-up
  name fails to load, so they aren't falling back to idle).
- **Report clipping:** for each emote, the person can say "Looks fine" or "I see clipping" **(owner)**.
- **Free fixes:** a clipping report costs no prompt **(owner)**. The agent gets frames of that emote, fixes the parts that
  poke through, re-renders that emote and checks it before handing back **(owner)**. If it still clips, the person can
  report it once more for a second free try **(owner)**.
- **Finalizing:** every emote renders automatically, and the person is encouraged to check the ones they haven't looked
  at **(owner)**.
- **Emote designs get the same check:** watch the emote, report clipping (arms through the body, props through the
  avatar), free fix **(owner)**.
- **Short waits:** keep each one as short as possible **(owner)**: no view waits on angles or emotes the person hasn't
  asked for yet.

## Non-goals

- Sending the GLB, or anything a browser could turn back into the model, before payment. Every view is still
  server-rendered pictures behind signed URLs (`render-urls.ts`), as today. A live 3D viewer is out.
- Detecting clipping automatically. The person spots it and the agent judges its fix by eye, from the frames.
- Turning the on-avatar view in every direction. It stays today's left/right spin with body shapes and outfits
  **(call)**.
- Letting the person turn an emote by hand while it plays. One playthrough already turns once round (see Emotes).
- Outfits 2 and 3 in the emote check. They stay viewable, but they aren't on the checklist **(owner)**.
- Changing prices, the daily allowance, or finalize.

## Anti-goals

- **A free side door:** a clipping report becomes a way to get other changes for free. The report carries no text box;
  the server writes the agent's instruction. The agent is told to change only what clips **(call)**.
- **Waiting for unasked views:** the person waits for five emotes when they wanted to check one, or for the whole
  sphere when they wanted the front.
- **Forced steps:** someone who wants to finalize can't, because a step is incomplete. The steps are free to jump
  between, and the emote check is a nudge, never a gate **(owner)**.
- **Broken frames saved:** a failed or half-finished render leaves a broken picture where a good one was.

## The steps **(owner)**

A row of steps across the top of today's preview panel: Design, Inspect, On avatar, Emotes, Finalize. Any step can be
opened at any time; none is required. A wireframe of the agreed flow is in
`.superpowers/brainstorm/80252-1793460176/content/flow.html` (gitignored; the owner liked it as drawn).

- **Design:** the conversation, as today. The step row only needs to show where the person is. On narrow screens,
  Design is the conversation column.
- **Inspect** (wearables only): the item alone, no avatar. Drag left/right to turn it round; drag up/down to tip it,
  from looking straight down at it to looking straight up at it. A body-shape toggle shows the male or female GLB
  **(call)**. Emote designs skip this step: an emote has nothing to show without the avatar **(call)**.
- **On avatar:** today's view, the eye-level spin per piece with body shapes and outfits. It loses its emote buttons,
  which move to the Emotes step **(owner)**.
- **Emotes:** shows every piece of the design worn together, the way someone wears the set **(owner)**. It has a button
  per emote showing its check state (not yet checked / looks fine / clipping reported / being fixed), plus the body
  shape and outfit toggles. The emote plays in the middle, with "Looks fine" and "I see clipping" under it. For an emote
  design, this step shows the design's own emote with the same two buttons.
- **Finalize:** today's finalize strip and dialog, with an emote checklist added (below).

The check state is per design, per emote and per body shape. It belongs to the current set of piece revisions: a new
revision of any piece (any change, including a fix) resets it, because what's being worn changed **(call)**.

## Inspect: how "every direction" works without the GLB

Decentraland's wearable-preview page can show a wearable alone (`type=wearable`), and its controller's
`changeCameraPosition` takes `beta` (elevation) as well as `alpha` (round). Checked on 2026-11-01 with the base
sneakers: `beta` near π looked straight up at both soles, cleanly. The renderer already drives this controller
(`render.py`, `__studio.call('scene', 'changeCameraPosition', …)`).

- **A new render mode `orbit`:** the item alone, rendered from a grid of angles covering the sphere. The target is 24
  steps round × 7 elevations, from straight down to straight up in 30° steps: 168 frames **(call)**. The builder sets
  the final grid from a timed render on the worker (see Waits). The web stage maps a drag to the nearest frame in the
  grid. Straight up and straight down need only one frame each, not 24.
- **The ring arrives first:** the eye-level row comes first and the other rows fill in after it **(call)**. Until a
  row is ready, dragging up or down stops at the nearest finished row. No spinner blocks the view.
- **Staying in the image:** the camera distance and target keep the item in frame from every angle. With
  `type=wearable` the page centres the item; the builder confirms it stays centred when tipped.
- **View key:** `orbit-<bodyShape>`, one render per piece, revision and body shape. It's stored and signed like every
  other view, under `renders/<category>/orbit-<shape>/NNN.webp`, with frame index = row × 24 + column. The contract
  (`CONTRACT.md`) and `viewKey` gain the mode.

## Emotes

- **The list:** `BASE_EMOTES` becomes idle, wave, dance, clap, walk, run, jump in all three places it lives:
  `designs.ts`, the worker's `config.py` and `Preview.tsx`'s list. The `View` type, the route's validation and the
  contract follow.
- **A new render mode, the walk-around:** the animation is paused and stepped through its timeline with the
  controller's `goTo`, as emote designs already are. The camera also turns a little at each step, at eye level, so one
  playthrough is smooth and shows every side once **(owner)**. For frame i of n: `goTo(i × length / n)`, camera
  `alpha` at i × 360° / n.
- **Frame rate:** each emote is rendered at a fixed rate rather than a fixed count. The target is 24 frames a second of
  animation, capped at 120 frames **(call)**; the builder sets the final rate from the timing. A short emote would turn
  quickly at that rate, so the turn is spread over at least 4 seconds of playback, looping the animation as many times
  as needed **(call)**. The stage plays the frames at the rate they were rendered, so emotes run at real speed.
- **All pieces together** **(owner)**: an emote view renders every piece of the design on the avatar at once (the
  renderer already takes a list of pieces). It's a design-level view, tied to the set of piece revisions it was
  rendered from; how that's stored is left to the builder, as long as a change to any piece makes it stale. The old
  per-piece `spin-…-<emote>` rows are simply left behind: they're previews, and nothing reads them once the
  emote buttons leave On avatar.
- **Timing:** an emote renders the first time someone opens it, one at a time **(call)**. A view someone asks for goes
  ahead of background renders, such as the rest of an orbit grid **(call)**.

## Reporting clipping and the free fix

**The report.** "I see clipping" on emote E, while viewing body shape S and outfit O, for the whole design (all its
pieces worn together). It asks for nothing else: no text, and no choosing which piece is at fault **(call)**. The agent
works out which piece is poking through and fixes that one **(owner)**.

**The server** queues a free fix, like the existing "fix the checker's FAILs" path in `queuePrompt` (`fixChecks`:
`counted: false`, server-written text, `check: false`, so the scope guard is skipped).

- **Instruction:** names the emote, the body shape and the outfit. It says to fix only the parts that pass through the
  body, the base outfit's clothes or the design's other pieces in that emote, and to change nothing else.
- **Two free fixes:** each design and emote gets two since the person's last prompt of their own **(owner: "report it
  again and try once more")**. Counting since the last prompt of their own is the author's reading of "per version"
  **(call)**. A fix whose job fails, or that ends without changing any piece, doesn't use one up **(call)**. A third
  report is turned down with a plain message: "We've tried to fix the clipping in the dance twice. Describe what you
  see in a prompt and the agent will take another look." The prompt then counts as normal.
- **Who can report:** only someone who has that emote's view rendered for the current set of piece revisions, because
  they've seen it. Only when no prompt is running, as for any prompt.
- **What the person sees:** the report shows in the conversation as a message from them, like the fix-checks one,
  e.g. "It clips in the dance (male, default outfit). Please fix it." The emote's state shows "being fixed".

**The worker.** Before the agent runs, the worker renders the reported emote on S and O from the current workspace,
with all the pieces worn. It uses several angles (front, right, back, left) at evenly spaced moments, and saves them into the design folder,
e.g. `out/clipping/<emote>/` **(call)**. The agent is told to open them first. `studio-preview` gains an emote option, so
the agent can render that emote again after its change, open the frames and compare. The agent hands back only when
it judges the clipping gone. If it can't fix it, it says so plainly.

**Grok:** the fix instruction tells Grok to open the frames with `read_file`. This design doesn't depend on the
unmerged `fix/grok-look-at-renders` branch **(call)**. If that branch merges first, its send-back-if-it-never-looked
check covers fixes too.

**After the fix:** a normal prompt result. There's a new revision, the eye-level renders are refreshed, and the fixed
emote is rendered again for the new revision straight away, so the person can check it without asking **(call)**.

## Finalizing **(owner)**

- **Starting the renders:** when the person opens Finalize (the dialog, before paying), every emote that isn't rendered
  yet for the current set of piece revisions is queued, on both body shapes, with the default outfit **(owner)**:
  14 renders for a wearable design.
- **The checklist:** the dialog lists each emote on each body shape with its check state, e.g. "You've checked 9 of
  14." Each item opens that emote and shape in the Emotes step.
- **Never a gate:** paying is never blocked on the checklist. The wording encourages checking; it doesn't warn or
  block **(owner)**.
- **Emote designs:** the checklist is the design's emote on both body shapes **(call)**.

## Waits

The owner wants waits as short as possible.

- **Timing first:** before setting frame counts, time on the Fly worker how long one orbit frame and one emote frame
  take after the page has loaded. Record it in the plan. The grid size and emote rate above are targets to adjust,
  not promises.
- **After each change:** the prompt job renders what it renders today (the on-avatar eye-level spin) plus the Inspect
  eye-level ring, so Inspect is ready when the prompt finishes **(call)**. The rest of the orbit grid is queued as a
  render job straight after. The person gets the result without waiting for it.
- **Cost:** rendering is about $0.001 per change today; the owner chose rendering previews over the risk of sending the
  GLB. The orbit grid multiplies frames several times over. That's still far below a prompt's cost. The plan records
  the measured figure.

## Constraints

- No GLB, glTF or texture leaves the server before payment; only rendered frames, through signed URLs.
- The render worker locks down the network: anything new goes through `wearable-preview.decentraland.org`, already
  allowed.
- Clipping fixes use the free path's rules: not counted, the server writes the text, there's a 2-per-emote cap, and
  one prompt runs at a time per design.
- Matching existing patterns: a view is a `studio_renders` row keyed by revision and view key; the worker uploads
  frames, then reports counts; a failed render saves no frames.

## Left to the builder

- **Inspect's drag feel:** sensitivity and inertia.
- **Small screens:** how the step row collapses.
- **Wording:** the exact "being fixed" and checklist copy, within the tone above.
- **Fix-frame layout:** how the agent's fix frames are arranged (one contact sheet or separate images) and how many
  moments are sampled.
- **Check state storage:** a column or a small table, as long as it's per piece, emote and revision, and survives a
  reload.
- **Camera framing:** the exact orbit camera radius and framing.
- **Orbit poles:** how the straight-up and straight-down frames are indexed.
- **Orbit record keeping:** how the prompt job's ring and the follow-up job's remaining rows are recorded against
  the one view.
- **Queue priority:** how asked-for renders jump ahead of background ones.
