---
title: Assistant
description: Ask the Virvi Assistant to look things up and make changes on the dashboard, with a plan you approve and Undo for every change.
---

The assistant is a chat panel on the dashboard. Ask it a question or tell it what you want changed, and it looks things up or makes the change for you.

## Opening it

Click **Assistant**, next to the notification bell, or press **⌘K** (Mac) or **Ctrl K**.

## Who can use it

The assistant is part of paid plans, and it is rolling out to admin accounts first. On a free account the panel says "The assistant is included with paid plans."

## What it can look at

- Your plan and usage.
- Your organizations, and the scenes in them, including their publishing status.
- Preset schedules, events and analytics summaries.
- A scene's recent errors.
- Your Studio designs, their checker results, your prompts left and what finalizing would cost.
- Your media, a scene's library, its streams and its scheduled showings.
- These docs, when you ask how something works.

It can also give you "open" links that take you straight to the dashboard page you need.

Replies are formatted, with headings, lists, tables and code where they help. Links to Virvi pages and virvi.io are clickable. Any other web address shows as plain text, so copy it into your browser yourself.

## What it can change

- A scene's name and description.
- Presets: create one, rename one, or switch the active one.
- Elements: add them, edit them (including what a video screen plays), show or hide them, and turn a video screen's live stream on or off.
- Element positions in a scene.
- Preset schedules: create and edit them.
- Library items: add them and rename them.
- Scheduled showings: create them.
- Scenes: create a new, empty one in your personal account.
- Events: create them, edit them and link scenes to them.
- Raffles: create a draft, schedule when it opens and change its prize. See [Setting up a show](#setting-up-a-show).
- BEAT drafts: create one. Paying for it is your step.
- Shows: a saved checklist for an event. See [Setting up a show](#setting-up-a-show).
- Studio designs: start one, and send it prompts. See [Making things](#making-things).

## What it can't do yet

Deploying, publishing, giveaways, invites, deleting things, finalizing or paying for Studio designs, billing and branding are not available in this release. For those, it points you to the right page.

## Making things

**Scenes.** Ask for a new scene and it creates an empty one in your personal account, with one preset (Default) that is live.

**Studio designs.** Ask it to start a design and it creates one of three kinds: a **wearable**, an **emote**, or a **scene**, which means a building with its furniture. It uses your default agent for that kind unless you name one (Claude, Codex or Grok). A new design is empty until a prompt is sent.

**Prompts.** Sending a Studio prompt uses your Studio prompts, so the assistant never sends one on its own. It shows a card first, and the prompt goes only after you press **Confirm**. The card shows exactly what will be sent: the start of the prompt (for example, Send "a neon cap with rivets"), and under it the design's name and which prompts it uses, then the wearable slots it works on and, for a long prompt, its whole text. The cost line is one of:

- "Neon cap": Uses 1 of your {n} prompts left today.
- "Neon cap": Uses 1 gifted prompt ({n} left).
- "Neon cap": Uses 1 bought prompt ({n} left).

Asking it to fix what the checker found is free. The card says Fix what the checker found, and under it: "Neon cap": This one is free: fixing what the checker found doesn't use your prompts. A prompt that ends in an error is given back.

Confirming a card needs the assistant to be available on your account. If your plan no longer includes the assistant, **Confirm** is refused: send the prompt from Studio instead.

A card lasts 10 minutes. If it expires, or you reload the page before confirming it, ask the assistant again for a fresh one.

If your Studio access is paused, the assistant says so and shows no card.

These prompts come out of your Studio allowance, not the assistant budget.

**No prompts left.** There is no card. The assistant tells you your Studio prompts are used up and gives you a **Buy Studio prompts** link to the Studio page. Daily prompts reset at midnight UTC.

**Finalizing.** The assistant never finalizes a design or takes payment. It can tell you the price and give you a **Finalize** link with the total, for example "Total $12". The link opens the normal finalize dialog in Studio, where you check the price and pay.

## Setting up a show

Ask for a whole show in one request, for example "set up a launch event on Friday at 8pm with a raffle and a BEAT". The assistant works out what the show needs and saves it as a **checklist**. A checklist can hold an event, scene links, showings, a raffle, the raffle's scheduled opening, a BEAT draft and its payment, a new wearable design and its Decentraland publishing. Then it makes the things one at a time, ticking them off the list.

**Approving changes.** Private changes, such as the event, scene links and showings, are approved the usual way, as a numbered plan (see [Changes, plans and Undo](#changes-plans-and-undo)). Raffles and anything that goes public get their own cards, described below.

### The checklist

The checklist shows on the event's page, under **Show checklist**, with an **Ask the assistant** button that opens the panel. Each item has one of four states:

- **To do:** not made yet.
- **Waiting:** made, and something else has to happen first. For example, a raffle with no opening time yet, or whose scheduled opening failed (the note says why), a BEAT that hasn't been paid for ("Waiting for payment."), a wearable design still being worked on in Studio, or a wearable that isn't published yet ("Publish it on Decentraland, then paste its Marketplace link.").
- **Done:** it exists and is where it should be.
- **Skipped:** it was deleted, so the item is left alone with a note ("This was deleted."). A cancelled raffle or BEAT is also Skipped, with "This raffle was cancelled." or "This BEAT was cancelled."

The states are read from your real events, raffles, BEATs and designs each time, never from what the assistant remembers. If you change something by hand, the checklist follows.

### Raffles instead of giveaways

The assistant can't run giveaways, so a show uses a [raffle](/docs/dashboard/raffles/). Winners are picked by the draw, and **you send the prizes** to them yourself. See Delivering prizes on that page.

**The host terms card.** Creating a raffle is its own card, never part of a plan. It shows the raffle's details and Virvi's raffle host terms word for word: the raffle is free to enter and needs no purchase, you are responsible for following the giveaway and sweepstakes rules where you and your entrants live, and for delivering prizes. The card says "Confirming accepts these terms for this raffle." Pressing **Confirm** is you accepting them for that raffle. The assistant never accepts them for you.

**Official rules.** The raffle gets the same official rules the Raffles tab fills in for you, with the prize, the number of winners and you as the host (your display name, or the scene's name if you have none). The card says "Official rules: included, from Virvi's template." You can edit the rules on the Raffles tab. When the raffle is part of a show, the card also says "You'll send the wearable to the winners yourself, from the raffle's winners list."

**Changing the prize.** Visitors see a raffle's prize, so changing it is a card too, for example "Launch raffle": prize "A neon cap" becomes "The Neon Cap wearable". If the raffle is already open, the card says visitors see the new prize straight away. If the rules are still the template, they change to name the new prize; rules you edited yourself are left alone. Once you paste a published wearable's link, the assistant offers to make it the prize.

**Scheduled opening.** A new raffle is a draft. To have it open by itself, the assistant offers a separate card that names the prize, for example Open "Launch raffle" (prize "A neon cap") by itself at 2031-03-04 20:30 UTC. When the raffle is part of a show whose event has a timezone, the card shows the time in that timezone and names it, for example 2031-03-04 21:30 Europe/Paris. Otherwise times on the card are UTC. Confirm it to schedule the opening, or ask it to stop the raffle opening by itself. Only a raffle that hasn't opened can be scheduled. See [Scheduling a raffle](/docs/dashboard/raffles/#scheduling-a-raffle) for how opening works, including what happens if another raffle is running. The checklist's scheduling item reads Done once the raffle has an opening time (or has already opened); the raffle itself opens at that time.

### A BEAT draft and paying for it

The assistant makes a BEAT only as a **draft**: its name, dates, scenes, image and supply. It never pays. Instead it gives you a link to pay for it, on the BEAT's page, with the price, for example "Total $12.00", and you pay there the normal way. The checklist item reads Waiting until the BEAT is paid, then Done. See [BEATs](/docs/dashboard/beats/) for the price and what happens after paying. A draft BEAT can't be undone from the assistant: cancel it on its page.

### A new wearable

If the show includes a wearable that doesn't exist yet, the assistant tells you the timeline before it goes further: making the wearable takes a few days in Studio, then Decentraland curation, so it can't be named as the raffle's prize until it's published. It keeps the wearable on the checklist meanwhile.

If the event starts in fewer than 7 days, you also get a warning: a new wearable may not be through Decentraland curation by then, and a wearable you've already published would be safer. The warning shows on the checklist too, until the wearable design is done.

**Pasting the Marketplace link.** Once the wearable is published on Decentraland, paste its Marketplace link into the conversation, like `https://decentraland.org/marketplace/contracts/0x…/items/0`. The assistant adds it to the checklist and the item turns Done. It accepts a Decentraland Marketplace item link, or the wearable's contract address and item id.

### Picking a show up later

A show is saved to your account, not to one conversation. Open the assistant from the event's page, or start any new conversation, and ask it to carry on with the show. It reads the checklist as it stands and continues from there. When a show is finished or you no longer want it, ask the assistant to close it. A closed show drops off your list, and a closed show can't be reopened.

## Assistant activity

**Settings** has an **Assistant activity** section. It lists everything the assistant has changed for you, newest first, with the organization, the date and the status. Use **Undo** there where it still applies. Undo stays available for 7 days.

Scenes and Studio designs the assistant creates can't be undone from the assistant. Change those yourself in the dashboard.

## Changes, plans and Undo

- **One change** runs straight away, with an **Undo** button beside it.
- **Two or more changes** show up as a numbered plan first. Read it, then approve it once with **Do these N changes**. Nothing happens until you do. Plans expire after 10 minutes.
- **Undo** is on each step and on the whole plan (**Undo all**). It stays available for 7 days.

Undo refuses if you have edited the same thing by hand since. You'll see "This changed after the assistant's edit, so Undo would overwrite it." Your edit is kept, and nothing is rolled back over it.

## Several organizations

The assistant works across all your organizations and names the organization on every change it makes. If a request could mean more than one, for example two scenes with the same name in different organizations, it asks which one you mean before doing anything.

## Budget

Each month has an assistant budget, shown as the percentage you have left. You get a warning when 80% is used. At 100% the assistant stops, and it tells you the day it comes back.

## Your conversations

Conversations are kept until you delete them. See the [privacy page](/docs/privacy/) for how they are handled.
