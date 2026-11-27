---
title: Roles & Permissions
description: Who can do what in a scene, how to give people access, and how to see what they changed.
---

Every scene has one **host**: the account that owns it. The host can give other people access in two ways:

- **Wallet roles** (the scene's **Roles** tab): a role goes to a wallet address. It works in the dashboard and in-world, and the person doesn't need a Virvi account first. The role attaches when that wallet signs in to Virvi, from the website or from Decentraland.
- **Collaborators** (the **Collaborators** section on the scene page): invite a Virvi account by its email address. The account has to have confirmed its email.

Venue bookings add a third, time-boxed kind of access for an organizer and their crew: see [Venues & Bookings](/docs/dashboard/venues/).

## Roles

| Role | Given by | What it's for |
|------|----------|---------------|
| **Host** | Owning the scene | Everything |
| **Co-host** | Wallet role | Everything except handing over the host role and deleting the scene |
| **Editor** | Wallet role or collaborator | Building and running the scene |
| **Editor in an area** (a tenant) | Wallet role | Building inside one part of the scene, such as a plot or a shop |
| **Viewer** | Wallet role or collaborator | Watching how the scene does |

If a person has more than one (say, a collaborator invite and a wallet role), they get the strongest.

## What each role can do

| | Host | Co-host | Editor | Viewer |
|---|:---:|:---:|:---:|:---:|
| See the scene's analytics | ✓ | ✓ | ✓ | ✓ |
| Add, change, move and delete items, in the dashboard and in-world | ✓ | ✓ | ✓ | |
| Create, rename, delete and switch presets | ✓ | ✓ | ✓ | |
| Rename the scene, change its description and thumbnail | ✓ | ✓ | ✓ | |
| Run raffles and BEATs | ✓ | ✓ | ✓ | |
| Manage wallet roles and collaborators | ✓ | ✓ | | |
| See the [activity log](#activity-log) | ✓ | ✓ | | |
| Deploy to Decentraland | ✓ | ✓ | | |
| Hand over the host role | ✓ | | | |
| Delete the scene | ✓ | | | |

Deploying also needs a wallet that owns the World, or controls the parcels, linked to your account.

A collaborator can remove themselves from a scene at any time. The host can't be removed. To change hosts, the host makes a signed-in co-host the new host from the Roles tab, and becomes a co-host themselves.

## Tenants: editors limited to an area

An editor wallet role can be limited to part of the scene, for a tenant who rents a plot, a stall or a shop. In the **Roles** tab, tick **Only inside an area** when you add the editor, or use **Limit to an area** on an editor already listed. The area is a box on the scene's floor: **Min x**, **Max x**, **Min z** and **Max z**, in metres, in the same coordinates as item positions in the editor. Height isn't limited.

Inside their area, a tenant can:

- add images, videos, 3D models and sounds, and place them;
- move, turn, resize and remove copies whose position is inside the area, as long as they stay inside it;
- change or delete an item when every copy of it is inside the area.

Everything else stays with you and your co-hosts and editors. That includes items with any copy outside the area, presets, the scene's name and settings, roles, deploys, raffles, BEATs and analytics. Tenants can't attach a copy to another one (a child copy's position is relative to its parent), and they can't add ad spaces, claim points or widgets. An edit outside the area is refused with a message naming the area. The scene page shows a tenant their area.

**Change area** moves it, and **Edit everywhere** removes the limit. A role change in the HUD keeps the area, and making the tenant a co-host or viewer removes it. If the same person also has an unlimited editor role, through another wallet or a collaborator invite, the stronger one wins.

Tenants edit from the dashboard, and in Decentraland from the HUD in scenes on `@virvixr/dcl` 2.24.0 or later, where the Layout panel shows their area. Older scenes show a tenant nothing to edit in-world until they're redeployed. Hyperfy and the headset apps don't offer tenants editing yet.

## In-world

The in-world HUD follows the same roles. The host and co-hosts manage roles from the HUD, editors place and edit items, and viewers and visitors can't edit. If an edit is refused, the HUD says why: signed out, no permission, disconnected, or a scene that needs a redeploy.

## Activity log

The scene's **Activity** tab lists who changed what, and when. That covers items, presets, the scene's settings, roles and collaborators, deploys, and deleting or restoring the scene, made in the dashboard or in-world. Only the host and co-hosts can see it. See [Core Concepts](/docs/getting-started/concepts/#activity) for what's included.
