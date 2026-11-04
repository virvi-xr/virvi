/**
 * The exact files of every World deploy Virvi makes, kept in the private import store as `deployed/<hash>` (content
 * addressed, so a file shared by many deploys is kept once), and the zip of what went live built from them.
 *
 * A deploy uploads only its new files; the rest were already on the Worlds server. So a deployment's `content`
 * (its `assetBundle.content`) lists every path and hash of the entity, and a download takes each file from the store,
 * else from the Worlds server (checked against its hash).
 */
import { PassThrough, type Readable } from 'node:stream'
import { once } from 'node:events'
import { Zip, ZipPassThrough } from 'fflate'
import { getImportStore, type PrivateStore } from '../../storage/private-store.js'
import { safeSegments } from '../import/scene-zip.js'
import { dclHash, type ContentRef } from './entity.js'
import { contentServerFor, type ContentDest, type ContentServer } from './catalyst-client.js'

export const FILES_GONE = "Some of this deploy's files are no longer stored anywhere, so it can't be downloaded."
export const FILES_UNSAFE = "Some of this deploy's file names can't be put in a zip safely, so it can't be downloaded."
const NOT_DEPLOYED = "This deploy never went live, so there's nothing to download."
const UNREACHABLE = "Couldn't read your World from Decentraland. Try again in a minute."

export class DownloadError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message)
  }
}

const deployedKey = (hash: string) => `deployed/${hash}`

/** Whether `key` is in the store. The store has no head call, so this opens the object and lets go of it unread. */
async function isStored(store: PrivateStore, key: string): Promise<boolean> {
  const obj = await store.getStream(key)
  obj?.body.destroy()
  return obj !== null
}

/** Keeps the bytes of each of `content`'s hashes that `files` has (the deploy's new files), skipping ones already kept. */
export async function keepDeployedFiles(content: ContentRef[], files: Map<string, Uint8Array>): Promise<void> {
  const store = getImportStore()
  for (const hash of new Set(content.map((c) => c.hash))) {
    const bytes = files.get(hash)
    if (!bytes || (await isStored(store, deployedKey(hash)))) continue
    await store.put(deployedKey(hash), Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength), 'application/octet-stream')
  }
}

interface DeployedRow {
  status: string
  catalystEntityId: string | null
  deployedAt: Date | null
  target: unknown
  assetBundle: unknown
}

/** One zip entry: its safe path and where its bytes come from. */
interface Entry { path: string; hash: string; from: 'store' | ContentServer }

/** Every file of the deployment, path to hash: its kept list, else (older rows) the live entity's while it is still the live one. */
async function contentOf(dep: DeployedRow, dest: ContentDest): Promise<ContentRef[]> {
  const kept = (dep.assetBundle as { content?: ContentRef[] } | null)?.content
  if (Array.isArray(kept)) return kept
  let live
  try {
    live = (await contentServerFor(dest).liveEntities(dest)).find((e) => e.id === dep.catalystEntityId)
  } catch {
    throw new DownloadError(503, 'world_unreachable', UNREACHABLE)
  }
  if (!live) throw new DownloadError(409, 'files_gone', FILES_GONE)
  return live.content
}

/** A content hash is a CID, letters and digits only: anything else could reach outside `deployed/` or the Worlds URL. */
const CID = /^[a-zA-Z0-9]{1,128}$/

/**
 * Each file's safe zip path, or 409 files_unsafe when any one can't have one: a path the import's safe-path check
 * refuses, two files at the same path (compared case-insensitively, as Decentraland and most unzippers do) or a
 * hash that isn't a CID. The whole list is checked, so a download is never missing files.
 */
function zipPaths(content: ContentRef[]): Array<{ path: string; hash: string }> {
  const unsafe = () => new DownloadError(409, 'files_unsafe', FILES_UNSAFE)
  const seen = new Set<string>()
  return content.map(({ file, hash }) => {
    let path: string
    try {
      path = safeSegments(String(file)).join('/')
    } catch {
      throw unsafe()
    }
    if (!path || seen.has(path.toLowerCase()) || typeof hash !== 'string' || !CID.test(hash)) throw unsafe()
    seen.add(path.toLowerCase())
    return { path, hash }
  })
}

/** The content server's view of a deployment's target: a World when it names one, else its Genesis City parcels; null when neither. */
function destOf(target: unknown): (ContentDest & { label: string }) | null {
  const t = target as { world?: unknown; parcels?: unknown } | null
  const parcels = Array.isArray(t?.parcels) ? t.parcels.filter((p): p is string => typeof p === 'string') : []
  if (typeof t?.world === 'string') return { kind: 'world', worldName: t.world, parcels, label: t.world }
  if (parcels.length) return { kind: 'parcels', worldName: null, parcels, label: `genesis-city-${parcels[0]}` }
  return null
}

/**
 * Where each file of a deployed World or parcels deployment comes from, decided before anything is sent: a file in neither the
 * store nor the Worlds server is 409 files_gone, and a list that can't be zipped safely is 409 files_unsafe.
 */
export async function planDownload(dep: DeployedRow): Promise<{ filename: string; entries: Entry[] }> {
  const dest = destOf(dep.target)
  if (dep.status !== 'deployed' || !dep.catalystEntityId || !dest) {
    throw new DownloadError(409, 'not_deployed', NOT_DEPLOYED)
  }
  const files = zipPaths(await contentOf(dep, dest))
  const store = getImportStore()
  const server = contentServerFor(dest)
  const source = new Map<string, Entry['from']>()
  const entries: Entry[] = []
  for (const { path, hash } of files) {
    let from = source.get(hash)
    if (!from) {
      if (await isStored(store, deployedKey(hash))) from = 'store'
      else {
        let there: boolean
        try {
          there = await server.hasContent(hash)
        } catch {
          throw new DownloadError(503, 'world_unreachable', UNREACHABLE)
        }
        if (!there) throw new DownloadError(409, 'files_gone', FILES_GONE)
        from = server
      }
      source.set(hash, from)
    }
    entries.push({ path, hash, from })
  }
  return { filename: `${filenameSafe(dest.label)}-${utcStamp(dep.deployedAt ?? new Date())}.zip`, entries }
}

const filenameSafe = (s: string) => s.replace(/[^a-zA-Z0-9._-]+/g, '-')
const pad = (n: number) => String(n).padStart(2, '0')
/** YYYYMMDD-HHmm, in UTC. */
const utcStamp = (d: Date) =>
  `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}-${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}`

/**
 * The bytes of one entry: streamed from the store, or fetched from the Worlds server. A CIDv1 file is checked against
 * its hash; a CIDv0 one (`Qm…`, older deploys) can't be with the hashing Virvi has, so it goes out as the server sent it.
 */
async function* bytesOf(e: Entry): AsyncGenerator<Uint8Array> {
  if (e.from === 'store') {
    const obj = await getImportStore().getStream(deployedKey(e.hash))
    if (!obj) throw new Error(`kept file ${e.hash} disappeared`)
    for await (const chunk of obj.body as Readable) yield chunk as Uint8Array
    return
  }
  const bytes = await e.from.getContent(e.hash)
  if (!bytes) throw new Error(`Content server no longer has ${e.hash}`)
  if (!e.hash.startsWith('Qm') && (await dclHash(bytes)) !== e.hash) throw new Error(`Content server sent bytes that don't match ${e.hash}`)
  yield bytes
}

/**
 * The zip of `entries`, streamed: one file at a time, stored as is (scene files are mostly compressed models and
 * images already). A file that fails partway ends the stream with an error, so a broken zip never looks complete.
 */
export function zipEntries(entries: Entry[]): Readable {
  const out = new PassThrough()
  const zip = new Zip((err, chunk, final) => {
    if (err) return void out.destroy(err)
    out.write(chunk)
    if (final) out.end()
  })
  void (async () => {
    for (const e of entries) {
      const f = new ZipPassThrough(e.path)
      zip.add(f)
      for await (const chunk of bytesOf(e)) {
        f.push(chunk)
        if (out.writableNeedDrain) await Promise.race([once(out, 'drain'), once(out, 'close')])
        if (out.destroyed) return
      }
      f.push(new Uint8Array(0), true)
    }
    zip.end()
  })().catch((err) => {
    console.error('[deployed-files] download failed:', err instanceof Error ? err.message : err)
    zip.terminate()
    out.destroy(err instanceof Error ? err : new Error(String(err)))
  })
  return out
}
