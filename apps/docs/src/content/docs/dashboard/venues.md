---
title: Venues & Bookings
description: Rent time-boxed control of a Virvi scene to an organizer and their crew.
---

A **venue** is a scene whose owner lets others control parts of it for a booked time slot.

## Make a scene a venue
`POST /api/venues` with `sceneId`, `name`, `slug`, and `rentableElementIds` (the screens, posters and sounds renters may change). The scene's current active preset becomes the venue default.

## Bookings
Admins create bookings with `POST /api/venues/:venueId/bookings` (`renterWallet` or `renterUserId`, `title`, `startsAt`, `endsAt`). Each booking gets its own copy of the default preset. Bookings whose live windows would overlap are rejected: each booking reserves its setup lead before the start, its grace after the end, and the venue's buffer on both sides, so back-to-back bookings need `setupLeadMinutes + graceMinutes + 2 × bufferMinutes` between one's end and the next one's start.

- **Setup window** — from booking until `setupLeadMinutes` before start: renters and crew edit the booking's copy; the live venue is untouched.
- **Live window** — until `graceMinutes` after the end: the copy is the live scene.
- At the end, the venue switches back to its default preset and access ends.

## Crew
The renter (host) adds crew by wallet with a role — `cohost`, `vj`, `lighting`, `performer`, `door` — and can toggle individual scopes. Crew don't need a Virvi account; access attaches when their wallet signs in from Decentraland. Revoked crew can be added again; their old grant is restored with the new role and scopes.
