# @virvixr/sdk

A typed client for the [Virvi](https://virvi.io) API: scenes, presets, items and their placements, events, media and webhooks, plus webhook signature checking. No dependencies; it runs anywhere with `fetch` and Web Crypto (Node 18+, browsers, Deno, Bun, Workers).

```sh
npm install @virvixr/sdk
```

```ts
import { VirviClient } from '@virvixr/sdk'

const virvi = new VirviClient({ apiKey: process.env.VIRVI_API_KEY! })

const [scene] = await virvi.scenes.list()
const { presets } = await virvi.scenes.get(scene.id)
const poster = await virvi.elements.create(presets[0].id, { type: 'image', name: 'Poster', properties: { textureSrc: 'https://example.com/poster.png' } })
await virvi.instances.create(poster.id, { position: { x: 8, y: 2, z: 1 } })
```

Make a key in virvi.io **Settings → API Keys**. A key acts as your account through the same checks as the dashboard; a read-only or scene-limited key is refused what it can't do, as a `VirviApiError` with `status` 403 and the API's `code`. For anything without a typed method, `virvi.request(method, path, body)` calls any route.

## Webhooks

```ts
import { verifyWebhook } from '@virvixr/sdk'

// rawBody: the request body exactly as received, before parsing
const event = await verifyWebhook(rawBody, request.headers['virvi-signature'], process.env.VIRVI_WEBHOOK_SECRET!)
if (!event) return new Response('bad signature', { status: 400 })
if (event.type === 'deployment.finished') console.log(event.data)
```

Docs: <https://virvi.io/docs/api/sdk/> · Webhooks: <https://virvi.io/docs/api/webhooks/>

Licensed under Apache-2.0. Copyright Livication LLC.
