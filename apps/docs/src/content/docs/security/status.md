---
title: Status Page
description: Whether Virvi is working right now, uptime over the last 90 days, and incident updates.
---

[virvi.io/status](/status/) shows whether Virvi is working, and posts updates when something goes wrong.

## What it checks

Virvi's server checks each part once a minute:

- **Website, dashboard and in-world sync:** the server is running and its database answers. This covers the dashboard, the API, and the connection the in-world HUD uses.
- **Deploying to Decentraland:** whether Decentraland's content servers answer. These are the Genesis City catalyst and the Worlds content server, which Virvi deploys scenes to. They're run by Decentraland, so a problem there is outside Virvi's control. It's checked every 5 minutes. If only one of the two is reachable, it shows as having problems.

Each part has a bar for each of the last 90 days. A day under 99% is red. A day with a short problem is amber. A gray bar means it wasn't being checked yet.

## How downtime is counted

The server checks itself, so it can't report while it's down. Instead, every minute with no check counts as down. Once the server is back, the outage shows in that day's bar and in the 90-day figure.

## Incidents and maintenance

When there's a problem, the Virvi team posts it at the top of the page with a timeline: investigating, identified, monitoring, resolved. Planned maintenance is posted the same way, ahead of time, and doesn't mark the page as having problems. Resolved incidents stay listed for 14 days.

The page refreshes every minute. It's also available as JSON at `GET /api/status`, with no sign-in, for your own monitoring.
