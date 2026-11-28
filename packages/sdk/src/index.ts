/**
 * @virvixr/sdk: a typed client for the Virvi API (LIV-39). No dependencies: it uses the platform's fetch (Node 18+,
 * browsers, Deno, Bun, Workers) and Web Crypto. Every call runs as the API key's account, through the same checks as the
 * dashboard; a read-only or scene-limited key is refused what it can't do (VirviApiError with status 403).
 */

export interface Vec3 { x: number; y: number; z: number }

export interface SceneSummary {
  id: string
  name: string
  description?: string | null
  activePresetId: string | null
  relationship?: string
  updatedAt?: string
  [key: string]: unknown
}

export interface Instance {
  id: string
  elementId: string
  enabled: boolean
  position: Vec3 | null
  rotation: Vec3 | null
  scale: Vec3 | null
  parentInstanceId?: string | null
  properties?: Record<string, unknown> | null
  [key: string]: unknown
}

export type ElementType = 'image' | 'video' | 'model' | 'sound' | 'nft' | 'widget' | 'custom' | 'ad_space' | 'claim_point'

export interface Element {
  id: string
  presetId: string
  type: ElementType | string
  name: string
  enabled: boolean
  properties: Record<string, unknown> | null
  clickEvent?: Record<string, unknown> | null
  instances?: Instance[]
  [key: string]: unknown
}

export interface Preset { id: string; sceneId: string; name: string; elements?: Element[]; [key: string]: unknown }

export interface Scene extends SceneSummary { presets: Preset[] }

export interface VirviEvent { id: string; name: string; startTime: string | null; endTime: string | null; timezone?: string | null; [key: string]: unknown }

export interface MediaAsset { id: string; name?: string; url?: string; contentType?: string; [key: string]: unknown }

export type WebhookEventType = 'deployment.finished' | 'event.started' | 'webhook.test'
export interface Webhook { id: string; url: string; events: WebhookEventType[]; createdAt: string }
export interface WebhookDelivery { id: string; event: WebhookEventType; status: 'pending' | 'delivered' | 'failed'; attempts: number; responseStatus: number | null; lastError: string | null; createdAt: string; deliveredAt: string | null }

/** A webhook request's body, once its signature checks out. */
export interface WebhookPayload<T = Record<string, unknown>> { id: string; type: WebhookEventType; createdAt: string; data: T }

export class VirviApiError extends Error {
  constructor(public readonly status: number, public readonly code: string | null, message: string, public readonly body: unknown) {
    super(message)
    this.name = 'VirviApiError'
  }
}

export interface VirviClientOptions {
  /** An API key from virvi.io Settings → API Keys (or an OAuth access token). */
  apiKey: string
  /** The API's address; https://api.virvi.io by default, or your own server's when self-hosting. */
  baseUrl?: string
  /** A fetch to use instead of the global one (tests, proxies). */
  fetch?: typeof fetch
}

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
const enc = encodeURIComponent

export class VirviClient {
  private readonly base: string
  private readonly key: string
  private readonly f: typeof fetch

  constructor(opts: VirviClientOptions) {
    if (!opts?.apiKey) throw new Error('VirviClient needs an apiKey (virvi.io Settings → API Keys)')
    this.key = opts.apiKey
    this.base = (opts.baseUrl ?? 'https://api.virvi.io').replace(/\/+$/, '')
    this.f = opts.fetch ?? globalThis.fetch.bind(globalThis)
  }

  /** Any route (such as '/api/v1/scenes'), for what the typed methods don't cover yet. Throws VirviApiError for a non-2xx answer. */
  async request<T = unknown>(method: Method, path: string, body?: unknown): Promise<T> {
    const res = await this.f(`${this.base}${path}`, {
      method,
      headers: { authorization: `Bearer ${this.key}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })
    const text = await res.text()
    let json: unknown = null
    if (text) { try { json = JSON.parse(text) } catch { json = text } }
    if (!res.ok) {
      const o = (json && typeof json === 'object' ? json : {}) as { error?: unknown; message?: unknown }
      const code = typeof o.error === 'string' ? o.error : null
      throw new VirviApiError(res.status, code, typeof o.message === 'string' ? o.message : code ?? `HTTP ${res.status}`, json)
    }
    return json as T
  }

  readonly scenes = {
    list: async (): Promise<SceneSummary[]> => (await this.request<{ scenes: SceneSummary[] }>('GET', '/api/v1/scenes')).scenes,
    get: async (sceneId: string): Promise<Scene> => (await this.request<{ scene: Scene }>('GET', `/api/v1/scenes/${enc(sceneId)}`)).scene,
    update: async (sceneId: string, changes: { name?: string; description?: string; activePresetId?: string }): Promise<Scene> =>
      (await this.request<{ scene: Scene }>('PUT', `/api/v1/scenes/${enc(sceneId)}`, changes)).scene,
    /** How the live preset compares with Decentraland's limits, and suggested fixes. */
    performance: (sceneId: string) => this.request<Record<string, unknown>>('GET', `/api/v1/scenes/${enc(sceneId)}/health`),
    /** Who changed what, newest first (hosts and co-hosts). */
    activity: (sceneId: string) => this.request<Record<string, unknown>>('GET', `/api/v1/scenes/${enc(sceneId)}/activity`),
  }

  readonly presets = {
    create: async (sceneId: string, name: string, fromPresetId?: string): Promise<Preset> =>
      (await this.request<{ preset: Preset }>('POST', `/api/v1/scenes/${enc(sceneId)}/presets`, { name, ...(fromPresetId ? { fromPresetId } : {}) })).preset,
    rename: async (presetId: string, name: string): Promise<Preset> => (await this.request<{ preset: Preset }>('PATCH', `/api/v1/presets/${enc(presetId)}`, { name })).preset,
    /** Makes it the live preset: everyone in the scene sees the switch within seconds. */
    activate: (sceneId: string, presetId: string) => this.scenes.update(sceneId, { activePresetId: presetId }),
  }

  readonly elements = {
    create: async (presetId: string, element: { type: ElementType; name: string; enabled?: boolean; properties?: Record<string, unknown> }): Promise<Element> =>
      (await this.request<{ element: Element }>('POST', `/api/v1/presets/${enc(presetId)}/elements`, element)).element,
    /** Note: `properties` replaces the element's properties whole; send them all (get the scene first to merge). */
    update: async (elementId: string, changes: { name?: string; enabled?: boolean; properties?: Record<string, unknown>; clickEvent?: Record<string, unknown> | null }): Promise<Element> =>
      (await this.request<{ element: Element }>('PUT', `/api/v1/elements/${enc(elementId)}`, changes)).element,
    delete: async (elementId: string): Promise<void> => { await this.request('DELETE', `/api/v1/elements/${enc(elementId)}`) },
  }

  readonly instances = {
    create: async (elementId: string, at: { position: Vec3; rotation?: Vec3; scale?: Vec3; enabled?: boolean }): Promise<Instance> =>
      (await this.request<{ instance: Instance }>('POST', `/api/v1/elements/${enc(elementId)}/instances`, at)).instance,
    update: async (instanceId: string, changes: { position?: Vec3; rotation?: Vec3; scale?: Vec3; enabled?: boolean }): Promise<Instance> =>
      (await this.request<{ instance: Instance }>('PUT', `/api/v1/instances/${enc(instanceId)}`, changes)).instance,
    delete: async (instanceId: string): Promise<void> => { await this.request('DELETE', `/api/v1/instances/${enc(instanceId)}`) },
  }

  readonly events = {
    list: async (): Promise<VirviEvent[]> => (await this.request<{ events: VirviEvent[] }>('GET', '/api/v1/events')).events,
    create: async (event: { name: string; description?: string; startTime?: string; endTime?: string; timezone?: string }): Promise<VirviEvent> =>
      (await this.request<{ event: VirviEvent }>('POST', '/api/v1/events', event)).event,
  }

  readonly media = {
    list: async (): Promise<MediaAsset[]> => (await this.request<{ assets: MediaAsset[] }>('GET', '/api/v1/media')).assets,
  }

  readonly webhooks = {
    list: async (): Promise<Webhook[]> => (await this.request<{ webhooks: Webhook[] }>('GET', '/api/v1/webhooks')).webhooks,
    /** The signing secret comes back here only: keep it to check deliveries with verifyWebhook. */
    create: (url: string, events: Array<Exclude<WebhookEventType, 'webhook.test'>>) =>
      this.request<{ webhook: Webhook; secret: string }>('POST', '/api/v1/webhooks', { url, events }),
    delete: async (webhookId: string): Promise<void> => { await this.request('DELETE', `/api/v1/webhooks/${enc(webhookId)}`) },
    test: (webhookId: string) => this.request<{ delivery: WebhookDelivery | null }>('POST', `/api/v1/webhooks/${enc(webhookId)}/test`),
    deliveries: async (webhookId: string): Promise<WebhookDelivery[]> =>
      (await this.request<{ deliveries: WebhookDelivery[] }>('GET', `/api/v1/webhooks/${enc(webhookId)}/deliveries`)).deliveries,
  }
}

const hex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')

/** Same length and every byte equal, without stopping early. */
function sameText(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

/**
 * Checks a webhook request: `rawBody` exactly as received, its `Virvi-Signature` header and the webhook's secret.
 * Returns the parsed payload, or null when the signature is wrong or older than `toleranceSeconds` (5 minutes).
 */
export async function verifyWebhook<T = Record<string, unknown>>(
  rawBody: string, signatureHeader: string | null | undefined, secret: string, opts: { toleranceSeconds?: number; now?: Date } = {},
): Promise<WebhookPayload<T> | null> {
  if (!signatureHeader || !secret) return null
  const parts = Object.fromEntries(signatureHeader.split(',').map((p) => { const i = p.indexOf('='); return [p.slice(0, i).trim(), p.slice(i + 1).trim()] }))
  const t = Number(parts.t)
  if (!Number.isFinite(t) || typeof parts.v1 !== 'string') return null
  const now = (opts.now ?? new Date()).getTime() / 1000
  if (Math.abs(now - t) > (opts.toleranceSeconds ?? 300)) return null
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const expected = hex(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${parts.t}.${rawBody}`)))
  if (!sameText(expected, parts.v1)) return null
  try { return JSON.parse(rawBody) as WebhookPayload<T> } catch { return null }
}
