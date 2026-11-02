/**
 * Client for the Decentraland Worlds content server (config.worldsUrl).
 *
 * Endpoints, confirmed against worlds-content-server docs/openapi.yaml and live read-only GETs:
 * - GET  /world/{name}/about        -> { configurations: { scenesUrn: ['urn:decentraland:entity:<id>?=&baseUrl=...'] } };
 *                                      404 `{error, message}` when the World has no scene deployed.
 * - GET  /contents/{hash}           -> the content file; for an entity id, the entity JSON
 *                                      `{ version, type, pointers, timestamp, content: [{file, hash}], metadata }`.
 * - HEAD /contents/{hash}           -> 200 when the server holds the file, 404 when it doesn't.
 * - POST /entities                  -> multipart/form-data: `entityId`, `authChain[i][type|payload|signature]`,
 *                                      then one file part per content hash. Same form dcl-catalyst-client's
 *                                      ContentClient.deploy builds; we send it ourselves so the 4xx body reaches
 *                                      WorldsError verbatim. 200 = live (a 202 "missing files" is not success).
 * - GET  /world/{name}/permissions  -> { owner, permissions: { deployment: { type, wallets } } }.
 * - GET  /wallet/{address}/stats    -> { wallet, dclNames, ensNames, usedSpace: '<bytes>', maxAllowedSpace: '<bytes>' }
 *                                      (numbers are strings).
 * - Signed fetch (ADR-44) requests carry x-identity-auth-chain-N, x-identity-timestamp, x-identity-metadata.
 */
import { DCL_MAX_FILE_BYTES } from '@virvixr/shared'
import { config } from '../../config.js'
import type { AuthChain, ContentRef, SceneMetadata } from './entity.js'

export interface LiveEntity {
  id: string
  pointers: string[]
  content: ContentRef[]
  metadata: SceneMetadata
}

export class WorldsError extends Error {
  constructor(public status: number, public body: string, message?: string) {
    super(message ?? `Worlds server: HTTP ${status}${body ? `: ${body.slice(0, 300)}` : ''}`)
  }
}

export interface SignedRequest {
  method: 'PUT' | 'POST' | 'DELETE'
  path: string
  metadata: string
  timestamp: number
  body?: unknown
}

export interface WorldsClient {
  /** The World's live scene entities; [] when it has none. */
  getWorldEntities(world: string): Promise<LiveEntity[]>
  deploy(d: { entityId: string; authChain: AuthChain; files: Map<string, Uint8Array> }): Promise<void>
  /** `timeoutMs` defaults to the write timeout; callers cap it to what the signature has left. */
  sendSigned(req: SignedRequest, chain: AuthChain, timeoutMs?: number): Promise<void>
  /** Never cached: callers act on the answer right away. */
  getDeployers(world: string): Promise<{ owner: string | null; deployers: string[] }>
  getWalletStats(address: string): Promise<{ maxAllowedBytes: number; usedBytes: number } | null>
  /** Whether the server still holds the content file `hash`. */
  hasContent(hash: string): Promise<boolean>
  /** The content file `hash`, null when the server doesn't hold it. Not checked against the hash here. */
  getContent(hash: string): Promise<Uint8Array | null>
}

const READ_TIMEOUT_MS = 10_000
/** A content file can be up to 50 MB. */
const CONTENT_TIMEOUT_MS = 120_000
const WRITE_TIMEOUT_MS = 120_000

async function readBody(res: Response): Promise<string> {
  try {
    return await res.text()
  } catch {
    return ''
  }
}

async function request(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) })
  } catch (err) {
    throw new WorldsError(0, '', `Worlds server unreachable: ${(err as Error).message}`)
  }
}

const lower = (v: unknown) => (typeof v === 'string' && v ? v.toLowerCase() : null)

export class HttpWorldsClient implements WorldsClient {
  constructor(private base = config.worldsUrl) {}

  /** GET returning parsed JSON, or null on 404. Any other non-2xx throws. */
  private async getJson<T>(path: string): Promise<T | null> {
    const res = await request(`${this.base}${path}`, {}, READ_TIMEOUT_MS)
    if (res.status === 404) return null
    if (!res.ok) throw new WorldsError(res.status, await readBody(res))
    return (await res.json()) as T
  }

  async getWorldEntities(world: string): Promise<LiveEntity[]> {
    const about = await this.getJson<{ configurations?: { scenesUrn?: string[] } }>(`/world/${encodeURIComponent(world.toLowerCase())}/about`)
    const ids = (about?.configurations?.scenesUrn ?? []).flatMap((urn) => {
      const m = /^urn:decentraland:entity:([^?]+)/.exec(urn)
      return m ? [m[1]] : []
    })
    const out: LiveEntity[] = []
    for (const id of ids) {
      const e = await this.getJson<{ pointers?: string[]; content?: ContentRef[]; metadata?: SceneMetadata }>(`/contents/${encodeURIComponent(id)}`)
      // /about says this entity is live; failing to resolve it must not make the World look empty.
      if (!e?.metadata) throw new WorldsError(404, '', `Worlds server: live entity ${id} of ${world} could not be resolved`)
      out.push({ id, pointers: e.pointers ?? [], content: e.content ?? [], metadata: e.metadata })
    }
    return out
  }

  async deploy(d: { entityId: string; authChain: AuthChain; files: Map<string, Uint8Array> }): Promise<void> {
    const form = new FormData()
    form.append('entityId', d.entityId)
    d.authChain.forEach((link, i) => {
      form.append(`authChain[${i}][type]`, link.type)
      form.append(`authChain[${i}][payload]`, link.payload)
      form.append(`authChain[${i}][signature]`, link.signature ?? '')
    })
    for (const [hash, bytes] of d.files) form.append(hash, new Blob([bytes as Uint8Array<ArrayBuffer>]), hash)
    const res = await request(`${this.base}/entities`, { method: 'POST', body: form }, WRITE_TIMEOUT_MS)
    const body = await readBody(res)
    // Only 200 means live; a 202 (files still missing) must not read as success.
    if (res.status !== 200) throw new WorldsError(res.status, body)
  }

  async sendSigned(req: SignedRequest, chain: AuthChain, timeoutMs = WRITE_TIMEOUT_MS): Promise<void> {
    const headers: Record<string, string> = {
      'x-identity-timestamp': String(req.timestamp),
      'x-identity-metadata': req.metadata,
    }
    chain.forEach((link, i) => {
      headers[`x-identity-auth-chain-${i}`] = JSON.stringify(link)
    })
    let body: string | undefined
    if (req.body !== undefined) {
      headers['content-type'] = 'application/json'
      body = JSON.stringify(req.body)
    }
    const res = await request(`${this.base}${req.path}`, { method: req.method, headers, body }, Math.min(timeoutMs, WRITE_TIMEOUT_MS))
    if (!res.ok) throw new WorldsError(res.status, await readBody(res))
  }

  async getDeployers(world: string) {
    const p = await this.getJson<{ owner?: string; permissions?: { deployment?: { type?: string; wallets?: unknown } } }>(
      `/world/${encodeURIComponent(world.toLowerCase())}/permissions`,
    )
    const d = p?.permissions?.deployment
    const wallets = d?.type === 'allow-list' && Array.isArray(d.wallets) ? d.wallets : []
    return { owner: lower(p?.owner), deployers: wallets.flatMap((w) => (typeof w === 'string' ? [w.toLowerCase()] : [])) }
  }

  async getWalletStats(address: string) {
    const s = await this.getJson<{ usedSpace?: string; maxAllowedSpace?: string }>(`/wallet/${encodeURIComponent(address.toLowerCase())}/stats`)
    if (!s) return null
    const used = Number(s.usedSpace)
    const max = Number(s.maxAllowedSpace)
    if (!Number.isFinite(used) || !Number.isFinite(max)) return null
    return { maxAllowedBytes: max, usedBytes: used }
  }

  async hasContent(hash: string) {
    const res = await request(`${this.base}/contents/${encodeURIComponent(hash)}`, { method: 'HEAD' }, READ_TIMEOUT_MS)
    if (res.status === 404) return false
    if (!res.ok) throw new WorldsError(res.status, '')
    return true
  }

  async getContent(hash: string) {
    const res = await request(`${this.base}/contents/${encodeURIComponent(hash)}`, {}, CONTENT_TIMEOUT_MS)
    if (res.status === 404) return null
    if (!res.ok) throw new WorldsError(res.status, await readBody(res))
    // No Decentraland file is over the limit, so a bigger body is never read in full
    const tooBig = () => new WorldsError(0, '', `Worlds server: ${hash} is over the ${DCL_MAX_FILE_BYTES} byte file limit`)
    if (Number(res.headers.get('content-length') ?? 0) > DCL_MAX_FILE_BYTES) {
      await res.body?.cancel().catch(() => {})
      throw tooBig()
    }
    const chunks: Uint8Array[] = []
    let size = 0
    try {
      for await (const chunk of res.body ?? []) {
        size += chunk.byteLength
        if (size > DCL_MAX_FILE_BYTES) break
        chunks.push(chunk)
      }
    } catch (err) {
      throw new WorldsError(0, '', `Worlds server: reading ${hash} failed: ${(err as Error).message}`)
    }
    if (size > DCL_MAX_FILE_BYTES) throw tooBig()
    return new Uint8Array(Buffer.concat(chunks))
  }
}

let current: WorldsClient | null = null

export function getWorldsClient(): WorldsClient {
  if (!current) current = new HttpWorldsClient()
  return current
}

/** Tests inject a fake; pass null to restore the HTTP implementation. */
export function setWorldsClient(c: WorldsClient | null): void {
  current = c
}
