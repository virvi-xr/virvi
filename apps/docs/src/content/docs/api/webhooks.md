---
title: Webhooks
description: Have Virvi POST to your server when a deploy finishes or an event starts, signed so you can check it came from Virvi.
sidebar:
  order: 3
---

A webhook is an address on your own server that Virvi sends a POST to when something happens in your account. Add one in **Settings → Webhooks** on the dashboard: give its URL (it must start with `https://` and be a public address), and choose its events. Virvi shows the webhook's **signing secret** once, when you add it. Copy it then: you need it to check each request.

## Events

| Event | When | `data` |
|-------|------|--------|
| `deployment.finished` | A deploy of one of your scenes to Decentraland went live or failed | `deploymentId`, `sceneId`, `sceneName`, `platform`, `status` (`deployed` or `failed`), and `entityId` when live or `error` when it failed |
| `event.started` | One of your events reached its start time | `eventId`, `name`, `startTime`, `endTime` |
| `webhook.test` | You pressed **Send test** | `message` |

## What Virvi sends

A `POST` with a JSON body:

```json
{
  "id": "6f1c…",
  "type": "deployment.finished",
  "createdAt": "2026-11-28T01:10:12.466Z",
  "data": { "deploymentId": "…", "sceneId": "…", "sceneName": "Club", "platform": "decentraland", "status": "deployed", "entityId": "bafy…" }
}
```

and these headers:

| Header | What it is |
|--------|------------|
| `Virvi-Event` | The event, as `type` |
| `Virvi-Delivery` | The delivery's id, as `id`. A retry has the same one, so you can ignore repeats |
| `Virvi-Signature` | `t=<unix seconds>,v1=<signature>` |

## Checking the signature

`v1` is the HMAC-SHA256, in hex, of the timestamp, a dot, and the raw request body, keyed with your signing secret. Compute it from the body exactly as you received it, before parsing it, and refuse a request whose timestamp is more than a few minutes old.

```js
import { createHmac, timingSafeEqual } from 'node:crypto'

function fromVirvi(rawBody, header, secret) {
  const { t, v1 } = Object.fromEntries(header.split(',').map((p) => p.split('=')))
  if (Math.abs(Date.now() / 1000 - Number(t)) > 300) return false
  const expected = createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex')
  return v1.length === expected.length && timingSafeEqual(Buffer.from(v1), Buffer.from(expected))
}
```

With the [TypeScript SDK](/docs/api/sdk/), `verifyWebhook(rawBody, signatureHeader, secret)` does this for you.

## Answering, and retries

Answer with any `2xx` status within 10 seconds. Anything else, or no answer, counts as a failure. Virvi tries again after 1 minute, 5 minutes, 30 minutes, 2 hours, 6 hours and 12 hours, then gives up. Redirects aren't followed. **Deliveries** next to the webhook in Settings lists the last 50 with how each went. They are kept 30 days.

An account can have up to 10 webhooks. Deleting one stops its deliveries at once. Webhooks are also available through the [REST API](/docs/api/rest-reference/) (`/api/webhooks`), with an account session or a full-access API key.
