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

## In-world

The in-world HUD follows the same roles. The host and co-hosts manage roles from the HUD, editors place and edit items, and viewers and visitors can't edit. If an edit is refused, the HUD says why: signed out, no permission, disconnected, or a scene that needs a redeploy.

## Activity log

The scene's **Activity** tab lists who changed what, and when. That covers items, presets, the scene's settings, roles and collaborators, deploys, and deleting or restoring the scene, made in the dashboard or in-world. Only the host and co-hosts can see it. See [Core Concepts](/docs/getting-started/concepts/#activity) for what's included.
