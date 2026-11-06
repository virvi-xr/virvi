/**
 * An imported scene's own thumbnail (LIV-89): scene.json's display.navmapThumbnail, a file in the scene or an https
 * link, read here and kept as the Virvi scene's thumbnail. Nothing about it ever fails an import: a thumbnail that is
 * missing, unreadable or unsafe is skipped with a note the import page shows.
 */
import { eq } from 'drizzle-orm'
import { fetch as undiciFetch } from 'undici'
import { SCENE_THUMBNAIL_MAX_BYTES } from '@virvixr/shared'
import { db } from '../../db/connection.js'
import { scenes } from '../../db/schema.js'
import { StoreMediaError } from '../../media/store.js'
import { SceneGone, ThumbnailError, importMayReplace, removeImportedSceneThumbnail, setImportedSceneThumbnail, type ThumbnailErrorCode } from '../../scenes/thumbnail.js'
import { assertPublicHttpUrl } from '../../net/public-url.js'
import { guardedAgent, type Lookup } from '../../net/public-agent.js'
import { safeSegments, type SceneFolder } from './scene-zip.js'

/** Why a scene's thumbnail can't be used, as the end of "The scene's thumbnail couldn't be used: …". */
export class ThumbnailUnusable extends Error {
  constructor(public reason: string) {
    super(reason)
    this.name = 'ThumbnailUnusable'
  }
}

export type SceneThumbnailRead =
  | { kind: 'none' }
  | { kind: 'bytes'; data: Buffer; from: 'file' | 'url' }
  | { kind: 'unusable'; reason: string }

type FetchLike = (url: string, init: { redirect: 'manual'; signal: AbortSignal; dispatcher?: unknown }) => Promise<Response>

export interface DownloadOptions {
  /** Tests: stands in for undici's fetch. */
  fetchImpl?: FetchLike
  /** Tests: stands in for DNS, for the pre-check and the connection alike. */
  lookup?: Lookup
  timeoutMs?: number
  maxBytes?: number
}

const TIMEOUT_MS = 10_000
const MAX_REDIRECTS = 3
const MB = (n: number) => `${Math.round(n / (1024 * 1024))} MB`
const SCHEME = /^[a-z][a-z0-9+.-]+:/i
const defaultAgent = guardedAgent()

/** The https URL, checked to be public (every address it resolves to). Throws ThumbnailUnusable. */
async function publicHttps(raw: string, lookup?: Lookup): Promise<URL> {
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    throw new ThumbnailUnusable('its link is not a valid URL')
  }
  if (u.protocol !== 'https:') throw new ThumbnailUnusable('its link must be https')
  try {
    await assertPublicHttpUrl(u.href, { lookup })
  } catch {
    throw new ThumbnailUnusable('its link is not a public address')
  }
  return u
}

/**
 * Downloads a thumbnail from a public https link: every hop (at most 3 redirects, each https) checked to be public, the
 * connection itself refused for a private address, at most `maxBytes` (2 MB) whatever content-length says, within
 * `timeoutMs` (10 s) in all. Throws ThumbnailUnusable.
 */
export async function downloadThumbnail(url: string, opts: DownloadOptions = {}): Promise<Buffer> {
  const maxBytes = opts.maxBytes ?? SCENE_THUMBNAIL_MAX_BYTES
  const tooBig = new ThumbnailUnusable(`it is over ${MB(maxBytes)}`)
  const signal = AbortSignal.timeout(opts.timeoutMs ?? TIMEOUT_MS)
  const fetchImpl: FetchLike = opts.fetchImpl ?? (undiciFetch as unknown as FetchLike)
  const dispatcher = opts.lookup ? guardedAgent(opts.lookup) : defaultAgent
  try {
    let target = await publicHttps(url, opts.lookup)
    for (let hop = 0; ; hop++) {
      const res = await fetchImpl(target.href, { redirect: 'manual', signal, dispatcher })
      if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
        await res.body?.cancel().catch(() => {})
        if (hop >= MAX_REDIRECTS) throw new ThumbnailUnusable('its link has too many redirects')
        target = await publicHttps(new URL(res.headers.get('location')!, target).href, opts.lookup)
        continue
      }
      if (!res.ok) {
        await res.body?.cancel().catch(() => {})
        throw new ThumbnailUnusable(`it couldn't be downloaded (${res.status})`)
      }
      const declared = res.headers.get('content-length')
      if (declared !== null && /^\d+$/.test(declared.trim()) && Number(declared) > maxBytes) {
        await res.body?.cancel().catch(() => {})
        throw tooBig
      }
      if (!res.body) throw new ThumbnailUnusable("it couldn't be downloaded (no body)")
      const reader = res.body.getReader()
      const chunks: Uint8Array[] = []
      let total = 0
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        total += value.byteLength
        if (total > maxBytes) {
          await reader.cancel().catch(() => {})
          throw tooBig
        }
        chunks.push(value)
      }
      return Buffer.concat(chunks, total)
    }
  } catch (err) {
    if (err instanceof ThumbnailUnusable) throw err
    if (signal.aborted) throw new ThumbnailUnusable('its link took too long to answer')
    throw new ThumbnailUnusable("it couldn't be downloaded")
  }
}

const ECHO_MAX = 120
/** A scene.json value as a note repeats it: at most 120 characters. */
const echo = (v: string) => (Array.from(v).length > ECHO_MAX ? `${Array.from(v).slice(0, ECHO_MAX).join('')}…` : v)

/** The file at `raw` in the scene, normalised as the zip reader does (exact, else ignoring case). */
function fileInScene(folder: SceneFolder, raw: string): Buffer {
  let segs: string[]
  try {
    segs = safeSegments(raw)
  } catch {
    throw new ThumbnailUnusable(`${echo(raw)} is outside the scene folder`)
  }
  const path = segs.join('/')
  let data = path ? folder.files.get(path) : undefined
  if (!data && path) {
    const lower = path.toLowerCase()
    const matches = [...folder.files.keys()].filter((k) => k.toLowerCase() === lower)
    if (matches.length === 1) data = folder.files.get(matches[0])
  }
  if (!data) throw new ThumbnailUnusable(`${echo(path || raw)} isn't in the upload`)
  return Buffer.from(data.buffer, data.byteOffset, data.byteLength)
}

/**
 * The bytes of the scene's display.navmapThumbnail: a path in the scene from the upload, or an https link downloaded
 * (downloadThumbnail). `none` when it names none; `unusable` with why when it can't be read. Never throws for the scene.
 */
export async function readSceneThumbnail(folder: SceneFolder, opts: DownloadOptions = {}): Promise<SceneThumbnailRead> {
  const raw = (folder.sceneJson.display as { navmapThumbnail?: unknown } | undefined)?.navmapThumbnail
  if (raw === undefined || raw === null || (typeof raw === 'string' && !raw.trim())) return { kind: 'none' }
  try {
    if (typeof raw !== 'string') throw new ThumbnailUnusable("navmapThumbnail isn't a path or a link")
    const value = raw.trim()
    if (/^https:\/\//i.test(value)) return { kind: 'bytes', data: await downloadThumbnail(value, opts), from: 'url' }
    if (SCHEME.test(value)) throw new ThumbnailUnusable('only an https link or a file in the scene can be used')
    return { kind: 'bytes', data: fileInScene(folder, value), from: 'file' }
  } catch (err) {
    if (err instanceof ThumbnailUnusable) return { kind: 'unusable', reason: err.reason }
    throw err
  }
}

let downloadDefaults: DownloadOptions = {}

/** Tests: what downloads go through (a mocked fetch, a fake DNS); null goes back to the real ones. */
export function setThumbnailDownloadOptions(o: DownloadOptions | null): void {
  downloadDefaults = o ?? {}
}

/** What an import did with its scene's thumbnail, kept on the import row. */
export interface ImportThumbnailResult {
  /**
   * imported: it is the Virvi scene's thumbnail now; kept: the owner's uploaded one stays; skipped: see note; removed:
   * scene.json names none, so an earlier import's was taken off; null: none named and nothing to change.
   */
  outcome: 'imported' | 'kept' | 'skipped' | 'removed' | null
  note: string | null
}

const UNUSABLE: Record<ThumbnailErrorCode, string> = {
  too_large: `it is over ${MB(SCENE_THUMBNAIL_MAX_BYTES)}`,
  too_many_pixels: 'it is over 16 megapixels',
  unsupported_type: "it isn't a PNG, JPEG or WebP image",
  too_small: 'it is smaller than 64 × 64 px',
  wrong_shape: "it isn't 16:9", // not checked for imports
}

const skipped = (reason: string, earlier = false): ImportThumbnailResult => ({
  outcome: 'skipped',
  note: `The scene's thumbnail couldn't be used: ${reason}.${earlier ? ' The one from your earlier import stays.' : ''}`,
})

/**
 * Makes the imported scene's display.navmapThumbnail the Virvi scene's thumbnail (LIV-89), unless the owner uploaded
 * their own in Virvi (then nothing is read or downloaded). Never throws: whatever goes wrong is skipped with a note.
 */
export async function importSceneThumbnail(sceneId: string, folder: SceneFolder): Promise<ImportThumbnailResult> {
  let earlier = false
  try {
    const current = await db.query.scenes.findFirst({ where: eq(scenes.id, sceneId), columns: { thumbnailKey: true, thumbnailSource: true } })
    if (!current) return { outcome: null, note: null }
    earlier = !!current.thumbnailKey && current.thumbnailSource === 'import'
    if (!importMayReplace(current)) {
      // The owner's own stays; only say so when scene.json names one
      const raw = (folder.sceneJson.display as { navmapThumbnail?: unknown } | undefined)?.navmapThumbnail
      return raw === undefined || raw === null || (typeof raw === 'string' && !raw.trim()) ? { outcome: null, note: null } : { outcome: 'kept', note: null }
    }
    const read = await readSceneThumbnail(folder, downloadDefaults)
    if (read.kind === 'none') {
      // scene.json owns an imported thumbnail: none named takes an earlier import's off
      return earlier && (await removeImportedSceneThumbnail(sceneId)) ? { outcome: 'removed', note: null } : { outcome: null, note: null }
    }
    if (read.kind === 'unusable') return skipped(read.reason, earlier)
    return (await setImportedSceneThumbnail(sceneId, read.data)) ? { outcome: 'imported', note: null } : { outcome: 'kept', note: null }
  } catch (err) {
    if (err instanceof ThumbnailError) return skipped(UNUSABLE[err.code], earlier)
    if (err instanceof StoreMediaError && (err.body as { error?: unknown }).error === 'storage_limit_reached') {
      return skipped('it would go over your storage limit', earlier)
    }
    if (err instanceof SceneGone) return { outcome: null, note: null }
    console.error(`[scene-import] the thumbnail of scene ${sceneId} couldn't be stored:`, err instanceof Error ? err.message : err)
    return skipped("it couldn't be stored just now", earlier)
  }
}
