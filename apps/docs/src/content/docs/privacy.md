---
title: Privacy & visitor data
description: What Virvi analytics collect in Decentraland scenes, and how to delete your data.
---

## What is collected
When a scene uses Virvi, the scene sends anonymous usage events to Virvi while you're inside its parcels: when you arrive and leave, where you walk (sampled every few seconds), what you click or hover, videos you play, emotes, and camera mode.

## How you're identified
- By default Virvi stores a **per-scene pseudonym**: a keyed hash of your wallet (or guest id). It can't be linked across scenes and it isn't your wallet address.
- **Display names and wallet addresses are only stored** if the scene owner turns on wallet visibility. When they do, the scene shows a notice when you enter, and only data collected after that notice includes your wallet and name.
- **IP addresses are never stored.** Virvi uses them briefly to limit abuse and to look up your country, then discards them.

## Retention
Raw events are kept for the scene owner's plan (7–365 days, unlimited on the top tier and self-hosted installs), 30 days for unclaimed scenes, and 7 days for local previews. Aggregated statistics (counts, heatmaps) are kept longer and contain no identities.

## Deleting your data
Call `POST /api/analytics/me/delete` with your session token. A dashboard control for this is coming. This removes your sessions, events and positions from every scene.

## Virvi Spaces on Quest
Virvi Spaces is the Meta Quest app that shows a Virvi space in your room. It talks to virvi.io. Pictures, videos and 3D models in a space load from wherever its owner hosts them, which may be outside virvi.io; those hosts see the headset's network address like any website would.
- **Every visitor sends:** the code of the ring you look at, to find its space; a request for the space's contents (the space feed); and anonymous visit events: when you arrive and leave, and where your head is (every few seconds), in the space's own coordinates rather than your room's. Each visit uses a fresh random id that is never stored, so visits can't be linked to you or to each other.
- **Builders also send:** the edits they make to a space, the alignment of a ring, and the pairing of their headset (including the headset model) with a Virvi account. The headset proves who it is with a secret kept in its encrypted storage; the server stores only a hash of it.
- **Never sent:** camera images and room scans. The headset's cameras are used on the headset to find rings, and your room's walls and surfaces are used on the headset to hide virtual things behind real ones and to snap items to walls. Neither leaves the headset.

Visit events follow the same retention as the rest of Virvi analytics, above. They carry no identity, so there is nothing to look up or delete for a single visitor. A builder can revoke a paired headset on virvi.io, which stops it from editing.

## Error reporting
When something goes wrong on virvi.io, the page and our server record the error so we can find and fix it. A report holds the error message, the page, the build of Virvi, your browser and operating system, your organization and scene ids, the time, and the last few things you did: pages you opened, the names of buttons and links you clicked, and the requests the page made (their address, result and timing). Before anything leaves your browser, tokens, email addresses, wallet addresses, secrets and the query part of web addresses are removed. It never includes what you type, passwords, wallet signatures, payment details, or what the page sent or received, other than the error message that came back.

- **How you're counted:** by a keyed hash of your account id, so we can see how many people an error reached without storing who. To count how many different places an error comes from, we also keep a hash of your network address made with a random key that changes every day. The key and those hashes are deleted after 2 days, after which they can't be traced back to an address or linked to another day. Your address itself is never stored.
- **How long:** error details, the account hashes and the breakdowns by page, browser and release are kept for 30 days. Hourly counts of each kind of error, with no identity, are kept for 400 days.
- **If you send a report:** when a page breaks it records the error without your account. If something you were doing fails and we need more detail, we may ask you about it, at most once a day; you can turn that off in Settings (or from the message itself). Whether you report from there, a crash page or Report a bug in the menu, you see exactly what will be sent before you press Submit, and nothing is sent before that. A report you send (what you wrote, that preview and a screenshot if you add one) is linked to your account if you're signed in, so we can follow up. Reports are kept for 400 days, and screenshots for 30 days. Ask us at support@virvi.io to have one deleted sooner.
- **Asking only when it helps:** to ask you at most once a day, and to say "we know about this" only once for each problem, we keep when we last asked your account and whether you turned asking off, and for 30 days which problems we told it about (by the account hash above); if you're not signed in, this browser keeps it.
- **Our issue tracker:** when automatic bug filing is turned on, the details of errors that keep happening (the redacted messages, pages, steps and counts above) are sent to Linear, the issue tracker we use, as bug reports, without your account. A report you choose to send is added to that bug with what you wrote (with email addresses and similar details removed) and, if you're signed in, your account id, never your name or email. Screenshots stay with us and are not sent to Linear. Those Linear comments aren't removed by the 400-day limit or when you delete your account; ask us at support@virvi.io and we'll remove them.

## Advertiser early access
When you ask for advertising early access on virvi.io, Virvi stores the email address, name, company or project, website and message you enter, and the time you sent the form. It's used only to contact you about advertising on Virvi. If you send the form again with the same email, the new answers replace the old ones (fields you leave blank keep what you sent before). Your IP address is used briefly to limit repeated submissions and is not stored. To be removed from the list, email sales@virvi.io.
