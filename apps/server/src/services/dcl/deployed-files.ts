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
import { getWorldsClient } from './worlds-client.js'

export const FILES_GONE = "Some of this deploy's files are no longer stored anywhere, so it can't be downloaded."
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
    await store.put(deployedKey(hash), Buffer.from(bytes), 'application/octet-stream')
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
interface Entry { path: string; hash: string; from: 'store' | 'worlds' }

/** Every file of the deployment, path to hash: its kept list, else (older rows) the live entity's while it is still the live one. */
async function contentOf(dep: DeployedRow, world: string): Promise<ContentRef[]> {
  const kept = (dep.assetBundle as { content?: ContentRef[] } | null)?.content
  if (Array.isArray(kept)) return kept
  let live
  try {
    live = (await getWorldsClient().getWorldEntities(world)).find((e) => e.id === dep.catalystEntityId)
  } catch {
    throw new DownloadError(503, 'world_unreachable', UNREACHABLE)
  }
  if (!live) throw new DownloadError(409, 'files_gone', FILES_GONE)
  return live.content
}

/**
 * Where each file of a deployed World deployment comes from, decided before anything is sent: a file in neither the
 * store nor the Worlds server is 409 files_gone. Paths go through the import's safe-path check; an unsafe one (or a
 * second file at the same path) is left out, so nothing in the zip can land outside the folder it is unpacked in.
 */
export async function planDownload(dep: DeployedRow): Promise<{ filename: string; entries: Entry[] }> {
  const world = (dep.target as { world?: unknown } | null)?.world
  if (dep.status !== 'deployed' || !dep.catalystEntityId || typeof world !== 'string') {
    throw new DownloadError(409, 'not_deployed', NOT_DEPLOYED)
  }
  const content = await contentOf(dep, world)
  const store = getImportStore()
  const source = new Map<string, Entry['from']>()
  const entries: Entry[] = []
  const paths = new Set<string>()
  for (const { file, hash } of content) {
    let path: string
    try {
      path = safeSegments(String(file)).join('/')
    } catch {
      path = ''
    }
    // A content hash is a CID (letters and digits): anything else could reach outside `deployed/`
    if (!path || paths.has(path) || typeof hash !== 'string' || !/^[a-zA-Z0-9]{1,128}$/.test(hash)) {
      console.error('[deployed-files] left out a content path that is unsafe or repeated:', JSON.stringify(String(file)).slice(0, 200))
      continue
    }
    paths.add(path)
    let from = source.get(hash)
    if (!from) {
      if (await isStored(store, deployedKey(hash))) from = 'store'
      else {
        let there: boolean
        try {
          there = await getWorldsClient().hasContent(hash)
        } catch {
          throw new DownloadError(503, 'world_unreachable', UNREACHABLE)
        }
        if (!there) throw new DownloadError(409, 'files_gone', FILES_GONE)
        from = 'worlds'
      }
      source.set(hash, from)
    }
    entries.push({ path, hash, from })
  }
  return { filename: `${filenameSafe(world)}-${utcStamp(dep.deployedAt ?? new Date())}.zip`, entries }
}

const filenameSafe = (s: string) => s.replace(/[^a-zA-Z0-9._-]+/g, '-')
const pad = (n: number) => String(n).padStart(2, '0')
/** YYYYMMDD-HHmm, in UTC. */
const utcStamp = (d: Date) =>
  `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}-${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}`

/** The bytes of one entry: streamed from the store, or fetched from the Worlds server and checked against the hash. */
async function* bytesOf(e: Entry): AsyncGenerator<Uint8Array> {
  if (e.from === 'store') {
    const obj = await getImportStore().getStream(deployedKey(e.hash))
    if (!obj) throw new Error(`kept file ${e.hash} disappeared`)
    for await (const chunk of obj.body as Readable) yield chunk as Uint8Array
    return
  }
  const bytes = await getWorldsClient().getContent(e.hash)
  if (!bytes) throw new Error(`Worlds server no longer has ${e.hash}`)
  if ((await dclHash(bytes)) !== e.hash) throw new Error(`Worlds server sent bytes that don't match ${e.hash}`)
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
