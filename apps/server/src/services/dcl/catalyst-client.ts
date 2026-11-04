/**
 * Client for the Decentraland catalyst content server (config.catalystUrl), which holds Genesis City parcel scenes,
 * and the ContentServer a deployer talks to for one destination (a World's Worlds server or the catalyst).
 *
 * Endpoints, all under `/content`:
 * - POST /entities/active {pointers} -> the active entities at those pointers (one entity can cover several).
 * - POST /entities                   -> the same multipart form as the Worlds server (see worlds-client.ts); 200 = live.
 * - GET|HEAD /contents/{hash}        -> a content file; 404 when the server doesn't hold it.
 */
import { DCL_MAX_FILE_BYTES } from '@virvixr/shared'
import { config } from '../../config.js'
import type { AuthChain, ContentRef, SceneMetadata } from './entity.js'
import { getWorldsClient, type LiveEntity, type WorldsClient } from './worlds-client.js'
import { worldOf } from './world-of.js'

/** What a content server needs to know about a destination. */
export interface ContentDest {
  kind: 'world' | 'parcels'
  worldName: string | null
  parcels: string[]
}

/** Where a destination's scene entities are read from and deployed to. */
export interface ContentServer {
  /** The destination's live scene entities; [] when it has none. */
  liveEntities(dest: ContentDest): Promise<LiveEntity[]>
  deploy(d: { entityId: string; authChain: AuthChain; files: Map<string, Uint8Array> }): Promise<void>
  hasContent(hash: string): Promise<boolean>
  getContent(hash: string): Promise<Uint8Array | null>
  contentSize(hash: string): Promise<number | null>
}

export class CatalystError extends Error {
  constructor(public status: number, public body: string, message?: string) {
    super(message ?? `Catalyst: HTTP ${status}${body ? `: ${body.slice(0, 300)}` : ''}`)
  }
}

const READ_TIMEOUT_MS = 10_000
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
    throw new CatalystError(0, '', `Catalyst unreachable: ${(err as Error).message}`)
  }
}

export class HttpCatalystClient implements ContentServer {
  constructor(private base = config.catalystUrl) {}

  async liveEntities(dest: ContentDest): Promise<LiveEntity[]> {
    const res = await request(
      `${this.base}/content/entities/active`,
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pointers: dest.parcels }) },
      READ_TIMEOUT_MS,
    )
    if (!res.ok) throw new CatalystError(res.status, await readBody(res))
    const list = (await res.json()) as Array<{ id?: string; pointers?: string[]; content?: ContentRef[]; metadata?: SceneMetadata }>
    const out = new Map<string, LiveEntity>()
    for (const e of Array.isArray(list) ? list : []) {
      if (!e?.id || !e.metadata) continue
      out.set(e.id, { id: e.id, pointers: e.pointers ?? [], content: e.content ?? [], metadata: e.metadata })
    }
    return [...out.values()]
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
    const res = await request(`${this.base}/content/entities`, { method: 'POST', body: form }, WRITE_TIMEOUT_MS)
    const body = await readBody(res)
    if (res.status !== 200) throw new CatalystError(res.status, body)
  }

  async hasContent(hash: string) {
    const res = await request(`${this.base}/content/contents/${encodeURIComponent(hash)}`, { method: 'HEAD' }, READ_TIMEOUT_MS)
    if (res.status === 404) return false
    if (!res.ok) throw new CatalystError(res.status, '')
    return true
  }

  async contentSize(hash: string) {
    const res = await request(`${this.base}/content/contents/${encodeURIComponent(hash)}`, { method: 'HEAD' }, READ_TIMEOUT_MS)
    if (res.status === 404) return null
    if (!res.ok) throw new CatalystError(res.status, '')
    const len = res.headers.get('content-length')
    return len !== null && /^\d+$/.test(len.trim()) ? Number(len) : null
  }

  async getContent(hash: string) {
    const res = await request(`${this.base}/content/contents/${encodeURIComponent(hash)}`, {}, CONTENT_TIMEOUT_MS)
    if (res.status === 404) return null
    if (!res.ok) throw new CatalystError(res.status, await readBody(res))
    const tooBig = () => new CatalystError(0, '', `Catalyst: ${hash} is over the ${DCL_MAX_FILE_BYTES} byte file limit`)
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
      throw new CatalystError(0, '', `Catalyst: reading ${hash} failed: ${(err as Error).message}`)
    }
    if (size > DCL_MAX_FILE_BYTES) throw tooBig()
    return new Uint8Array(Buffer.concat(chunks))
  }
}

/** A WorldsClient as the ContentServer of a World destination. */
export function worldsContentServer(client: WorldsClient): ContentServer {
  return {
    liveEntities: (dest) => client.getWorldEntities(worldOf(dest)),
    deploy: (d) => client.deploy(d),
    hasContent: (h) => client.hasContent(h),
    getContent: (h) => client.getContent(h),
    contentSize: (h) => client.contentSize(h),
  }
}

let current: ContentServer | null = null

export function getCatalystClient(): ContentServer {
  if (!current) current = new HttpCatalystClient()
  return current
}

/** Tests inject a fake; pass null to restore the HTTP implementation. */
export function setCatalystClient(c: ContentServer | null): void {
  current = c
}

/** The content server a destination deploys to: the Worlds server for a World, the catalyst for Genesis City parcels. */
export function contentServerFor(dest: ContentDest): ContentServer {
  return dest.kind === 'parcels' ? getCatalystClient() : worldsContentServer(getWorldsClient())
}
