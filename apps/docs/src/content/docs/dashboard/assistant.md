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

## What it can change

- A scene's name and description.
- Presets: create one, rename one, or switch the active one.
- Elements: add them, edit them (including what a video screen plays), show or hide them, and turn a video screen's live stream on or off.
- Element positions in a scene.
- Preset schedules: create and edit them.
- Library items: add them and rename them.
- Scheduled showings: create them.
- Scenes: create a new, empty one in your personal account.
- Studio designs: start one, and send it prompts. See [Making things](#making-things).

## What it can't do yet

Deploying, publishing, editing events, giveaways, invites, deleting things, finalizing or paying for Studio designs, billing and branding are not available in this release. For those, it points you to the right page.

## Making things

**Scenes.** Ask for a new scene and it creates an empty one in your personal account, with one preset (Default) that is live.

**Studio designs.** Ask it to start a design and it creates one of three kinds: a **wearable**, an **emote**, or a **scene**, which means a building with its furniture. It uses your default agent for that kind unless you name one (Claude, Codex or Grok). A new design is empty until a prompt is sent.

**Prompts.** Sending a Studio prompt uses your Studio prompts, so the assistant never sends one on its own. It shows a card first, and the prompt goes only after you press **Confirm**. The card says which prompts it uses:

- "Uses 1 of your {n} prompts left today."
- "Uses 1 gifted prompt ({n} left)."
- "Uses 1 bought prompt ({n} left)."

Asking it to fix what the checker found is free. The card says so: "This one is free: fixing what the checker found doesn't use your prompts." A prompt that ends in an error is given back.

These prompts come out of your Studio allowance, not the assistant budget.

**No prompts left.** There is no card. The assistant tells you your Studio prompts are used up and gives you a **Buy Studio prompts** link to the Studio page. Daily prompts reset at midnight UTC.

**Finalizing.** The assistant never finalizes a design or takes payment. It can tell you the price and give you a **Finalize** link with the total, for example "Total $12". The link opens the normal finalize dialog in Studio, where you check the price and pay.

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
