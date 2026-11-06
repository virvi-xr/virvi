/**
 * An imported scene's own thumbnail (LIV-89): scene.json's display.navmapThumbnail, a file in the scene or an https
 * link, read here and kept as the Virvi scene's thumbnail. Nothing about it ever fails an import: a thumbnail that is
 * missing, unreadable or unsafe is skipped with a note the import page shows.
 */
import { fetch as undiciFetch } from 'undici'
import { SCENE_THUMBNAIL_MAX_BYTES } from '@virvixr/shared'
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

/** The file at `raw` in the scene, normalised as the zip reader does (exact, else ignoring case). */
function fileInScene(folder: SceneFolder, raw: string): Buffer {
  let segs: string[]
  try {
    segs = safeSegments(raw)
  } catch {
    throw new ThumbnailUnusable(`${raw} is outside the scene folder`)
  }
  const path = segs.join('/')
  let data = path ? folder.files.get(path) : undefined
  if (!data && path) {
    const lower = path.toLowerCase()
    const matches = [...folder.files.keys()].filter((k) => k.toLowerCase() === lower)
    if (matches.length === 1) data = folder.files.get(matches[0])
  }
  if (!data) throw new ThumbnailUnusable(`${path || raw} isn't in the upload`)
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
