---
title: TypeScript SDK
description: "@virvixr/sdk, a typed client for the Virvi API: scenes, presets, items, events, media and webhooks."
sidebar:
  order: 4
---

`@virvixr/sdk` wraps the [REST API](/docs/api/rest-reference/) with typed methods. It has no dependencies and runs anywhere with `fetch` and Web Crypto: Node 18 and later, browsers, Deno, Bun and Workers.

```sh
npm install @virvixr/sdk
```

```ts
import { VirviClient } from '@virvixr/sdk'

const virvi = new VirviClient({ apiKey: process.env.VIRVI_API_KEY! })
// Self-hosting: new VirviClient({ apiKey, baseUrl: 'https://virvi.example.com' })
```

Make the key in **Settings → API Keys**. It acts as your account, through the same checks as the dashboard: a [read-only or scene-limited key](/docs/agents/use-virvi-with-your-agent/#connect-with-mcp) is refused what it can't do.

## Methods

| Area | Methods |
|------|---------|
| Scenes | `scenes.list()`, `scenes.get(sceneId)`, `scenes.update(sceneId, { name, description, activePresetId })`, `scenes.performance(sceneId)`, `scenes.activity(sceneId)` |
| Presets | `presets.create(sceneId, name, fromPresetId?)`, `presets.rename(presetId, name)`, `presets.activate(sceneId, presetId)` |
| Items | `elements.create(presetId, { type, name, properties })`, `elements.update(elementId, changes)`, `elements.delete(elementId)` |
| Placements | `instances.create(elementId, { position, rotation, scale })`, `instances.update(instanceId, changes)`, `instances.delete(instanceId)` |
| Events | `events.list()`, `events.create({ name, startTime, endTime, timezone })` |
| Media | `media.list()` |
| Webhooks | `webhooks.list()`, `webhooks.create(url, events)` (returns the signing secret, once), `webhooks.delete(id)`, `webhooks.test(id)`, `webhooks.deliveries(id)` |
| Anything else | `request(method, path, body?)` |

`elements.update` with `properties` replaces the item's properties whole, as the API does: read the scene first and send them all.

## Errors

A refused or failed call throws `VirviApiError`, with the HTTP `status`, the API's `code` (such as `read_only_key`, `key_scene_limited` or `outside_area`) and its `message`.

```ts
import { VirviApiError } from '@virvixr/sdk'

try {
  await virvi.instances.update(instanceId, { position: { x: 40, y: 0, z: 8 } })
} catch (err) {
  if (err instanceof VirviApiError && err.status === 403) console.log(err.code, err.message)
  else throw err
}
```

## Checking webhook signatures

```ts
import { verifyWebhook } from '@virvixr/sdk'

const event = await verifyWebhook(rawBody, request.headers.get('virvi-signature'), process.env.VIRVI_WEBHOOK_SECRET!)
if (!event) return new Response('bad signature', { status: 400 })
```

`verifyWebhook` returns the parsed body when the signature matches and is under 5 minutes old, and `null` otherwise. Pass the body exactly as received. See [Webhooks](/docs/api/webhooks/).
