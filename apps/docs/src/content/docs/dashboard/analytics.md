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
- **Visitors over time:** a chart you can switch between visitors, sessions and peak at once, over 24 hours, 7 days, 30 days or a custom range. Day buckets are UTC days.
- **Here now:** a map of the location's parcels with a dot for each visitor currently inside.
- **Heatmap:** where visitors spend time or how often they pass through, switchable between dwell time and visits.
- **Breakdowns:** top interactions, emotes, countries and platforms.
- **Recent visits:** the latest sessions with start time, duration, platform and country. Wallets and names appear only when wallet visibility is on.
- **Settings:** the wallet visibility switch.

Charts and counts update hourly; **Here now** refreshes every 15 seconds. Times are shown in your browser's time zone.

### Who sees what
The host, co-hosts, editors and viewers of a scene can all open its dashboard and see every section. Only the host and co-hosts can change wallet visibility; turning it off also clears the stored wallets and names. Anyone else sees a notice that they don't have access.

### Signing in from the HUD
**Stats** signs your browser in with a scene pass, so only that scene's analytics opens. A banner reads `Signed in from <scene name> — sign in for full access`. Any other page asks for a full sign-in. See [Scene pass and scene library](/docs/security/scene-pass/).
