---
title: Analytics
description: Zero-config visitor analytics for Decentraland LANDs and Worlds.
---

Virvi analytics start collecting as soon as a scene calls `startVirviAnalytics()` or `createVirvi()`. No account is needed to collect; sign in with the wallet that owns the LAND or World to see the data.

## What you get
- **Summary:** visits, unique visitors, session length and top countries.
- **Timeseries:** visits and visitors over time.
- **Live:** who is in the scene right now.
- **Heatmap:** where visitors walk and spend time.
- **Sessions:** individual visits and their events.
- **Wallet visibility:** optionally store wallet addresses and display names. Visitors see a notice when this is on. See [Privacy](/docs/privacy/).

## The dashboard
Open it from virvi.io (**Analytics** in the sidebar) or press **Stats** in the in-world HUD, which opens your scene's page. Pick a location to see:

- **Summary cards:** visitors, new vs returning, sessions, peak at once and average time in the scene.
- **Visitors over time:** a chart you can switch between visitors, sessions and peak at once, over 24 hours, 7 days, 30 days or a custom range. Day buckets are UTC days. **Download CSV** saves the chart's totals per hour or day, nothing about any one visitor.
- **Here now:** a map of the location's parcels with a dot for each visitor currently inside.
- **Heatmap:** where visitors spend time or how often they pass through, switchable between dwell time and visits.
- **Breakdowns:** top interactions, emotes, countries and platforms.
- **Screens and sounds:** for each video screen, how many times a video started playing, the total time watched, and the average per play, most watched first. Beside it, how many times each sound was played. Screens and sounds are named as they are in the scene, and older data from unnamed ones is grouped together. Decentraland scenes record screens. Sounds are recorded from `@virvixr/dcl` 2.23.0 on.
- **Recent visits:** the latest sessions with start time, duration, platform and country. Wallets and names appear only when wallet visibility is on.
- **Settings:** the wallet visibility switch.

Charts and counts update hourly; **Here now** refreshes every 15 seconds. Times are shown in your browser's time zone.

### Event attendance
Each event's page (**Events** in the sidebar) has a **Who came** section once the event has started. It counts visits to the event's linked scenes between the event's start and end time: visitors, verified wallets, the most people there at once and the average stay, then a list of each visitor with when they arrived and how long they stayed. **Download CSV** saves the list.

The section needs a start and an end time on the event, and only counts linked scenes whose analytics you can read. Names and wallets appear only when wallet visibility is on and the visitor allowed it; everyone else is listed as a visitor or guest with a short ID.

### Who sees what
The host, co-hosts, editors and viewers of a scene can all open its dashboard and see every section. Only the host and co-hosts can change wallet visibility; turning it off also clears the stored wallets and names. Anyone else sees a notice that they don't have access.

### Signing in from the HUD
**Stats** signs your browser in with a scene pass, so only that scene's analytics opens. A banner reads `Signed in from <scene name> — sign in for full access`. Any other page asks for a full sign-in. See [Scene pass and scene library](/docs/security/scene-pass/).
