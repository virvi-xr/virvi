import { S3Client, PutObjectCommand, GetObjectCommand, ListObjectsV2Command, DeleteObjectsCommand } from '@aws-sdk/client-s3'
import { mkdir, readFile, writeFile, rm, readdir, stat } from 'node:fs/promises'
import { createReadStream, createWriteStream } from 'node:fs'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { config } from '../config.js'

/**
 * The private studio bucket. Every design file (workspace, GLBs, checker reports, render frames) lives here, never in
 * the public uploads bucket; the browser only ever gets render frames, through signed URLs (render-urls.ts).
 */
export interface StudioStore {
  put(key: string, body: Buffer, contentType: string): Promise<void>
  get(key: string): Promise<{ body: Buffer; contentType: string } | null>
  deletePrefix(prefix: string): Promise<number>
  /** Workspaces are large: they stream through, never held whole in memory. */
  putStream(key: string, body: Readable, length: number, contentType: string): Promise<void>
  getStream(key: string): Promise<{ body: Readable; contentType: string; length?: number } | null>
}

async function collect(body: Readable): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const c of body) chunks.push(Buffer.from(c))
  return Buffer.concat(chunks)
}

export const workspaceKey = (designId: string) => `designs/${designId}/workspace.tar.gz`
export const jobFileKey = (designId: string, jobId: string, path: string) => `designs/${designId}/jobs/${jobId}/${path}`
/** A file the owner uploaded (studio/uploads.ts). */
export const uploadKey = (designId: string, uploadId: string) => `designs/${designId}/uploads/${uploadId}`

// The worker's file paths, from apps/studio-worker/CONTRACT.md
// pieces/<category>/<file>.glb|json, checks/<category>.txt, checks/<category>/<view>-blank-<nnn>.png (a render's blank
// frame), renders/<category>/<viewKey>/<nnn>.webp, final/<category>/package.zip and, for a scene piece,
// final/<category>/thumbnail.png
const FILE_PATH = /^(pieces\/([a-z_]+)\/[A-Za-z0-9._-]+\.(glb|json)|checks\/([a-z_]+)(?:\.txt|\/[a-z0-9-]+\.png)|renders\/([a-z_]+)\/[a-z0-9-]+\/[0-9]{3}\.webp|final\/([a-z_]+)\/(?:package\.zip|thumbnail\.png))$/
const MAX_PATH = 200

export function checkFilePath(
  path: string,
): { ok: true; kind: 'piece' | 'check' | 'render' | 'final'; category: string } | { ok: false; reason: string } {
  if (path.length > MAX_PATH) return { ok: false, reason: `path is longer than ${MAX_PATH} characters` }
  if (path.split('/').some((seg) => seg === '..' || seg === '.')) return { ok: false, reason: 'path has a relative segment' }
  const m = FILE_PATH.exec(path)
  if (!m) return { ok: false, reason: 'path is not a piece, check, render or package file' }
  if (m[2]) return { ok: true, kind: 'piece', category: m[2] }
  if (m[4]) return { ok: true, kind: 'check', category: m[4] }
  if (m[5]) return { ok: true, kind: 'render', category: m[5] }
  return { ok: true, kind: 'final', category: m[6] }
}

const DELETE_BATCH = 1000

export function r2StudioStore(uri = config.studioS3Uri): StudioStore {
  if (!uri) throw new Error('STUDIO_S3_URI is not set')
  const u = new URL(uri)
  const bucket = u.pathname.replace(/^\/+|\/+$/g, '')
  const client = new S3Client({
    region: 'auto',
    endpoint: `https://${u.host}`,
    forcePathStyle: true,
    credentials: { accessKeyId: decodeURIComponent(u.username), secretAccessKey: decodeURIComponent(u.password) },
  })
  return {
    async put(key, body, contentType) {
      await client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: contentType }))
    },
    async putStream(key, body, length, contentType) {
      await client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentLength: length, ContentType: contentType }))
    },
    async getStream(key) {
      try {
        const res = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }))
        return { body: res.Body as Readable, contentType: res.ContentType ?? 'application/octet-stream', length: res.ContentLength }
      } catch (err) {
        if ((err as { name?: string }).name === 'NoSuchKey') return null
        throw err
      }
    },
    async get(key) {
      try {
        const res = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }))
        const bytes = await res.Body!.transformToByteArray()
        return { body: Buffer.from(bytes), contentType: res.ContentType ?? 'application/octet-stream' }
      } catch (err) {
        if ((err as { name?: string }).name === 'NoSuchKey') return null
        throw err
      }
    },
    async deletePrefix(prefix) {
      const keys: string[] = []
      let token: string | undefined
      do {
        const res = await client.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token }))
        for (const o of res.Contents ?? []) if (o.Key?.startsWith(prefix)) keys.push(o.Key)
        token = res.IsTruncated ? res.NextContinuationToken : undefined
      } while (token)
      for (let i = 0; i < keys.length; i += DELETE_BATCH) {
        const res = await client.send(new DeleteObjectsCommand({
          Bucket: bucket,
          Delete: { Objects: keys.slice(i, i + DELETE_BATCH).map((Key) => ({ Key })), Quiet: true },
        }))
        if (res.Errors?.length) throw new Error(`failed to delete ${res.Errors.length} objects from the studio bucket`)
      }
      return keys.length
    },
  }
}

/** Files on disk, for development and the local end-to-end run. Content types sit beside the objects, under types/. */
export function localStudioStore(dir: string): StudioStore {
  const root = resolve(dir)
  const path = (area: 'objects' | 'types', key: string) => {
    const p = resolve(root, area, key)
    if (!p.startsWith(join(root, area) + sep)) throw new Error('studio store key escapes its folder')
    return p
  }
  async function walk(d: string): Promise<string[]> {
    const out: string[] = []
    for (const e of await readdir(d, { withFileTypes: true }).catch(() => [])) {
      const p = join(d, e.name)
      if (e.isDirectory()) out.push(...(await walk(p)))
      else out.push(p)
    }
    return out
  }
  return {
    async put(key, body, contentType) {
      const o = path('objects', key), t = path('types', key)
      await mkdir(dirname(o), { recursive: true })
      await mkdir(dirname(t), { recursive: true })
      await writeFile(o, body)
      await writeFile(t, contentType)
    },
    async putStream(key, body, _length, contentType) {
      const o = path('objects', key), t = path('types', key)
      await mkdir(dirname(o), { recursive: true })
      await mkdir(dirname(t), { recursive: true })
      await pipeline(body, createWriteStream(o))
      await writeFile(t, contentType)
    },
    async getStream(key) {
      const o = path('objects', key)
      const st = await stat(o).catch(() => null)
      if (!st?.isFile()) return null
      const contentType = await readFile(path('types', key), 'utf8').catch(() => 'application/octet-stream')
      return { body: createReadStream(o), contentType, length: st.size }
    },
    async get(key) {
      const o = path('objects', key)
      try {
        const body = await readFile(o)
        const contentType = await readFile(path('types', key), 'utf8').catch(() => 'application/octet-stream')
        return { body, contentType }
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT' || (err as NodeJS.ErrnoException).code === 'EISDIR') return null
        throw err
      }
    },
    async deletePrefix(prefix) {
      const base = join(root, 'objects') + sep
      const keys = (await walk(join(root, 'objects')))
        .map((p) => p.slice(base.length).split(sep).join('/'))
        .filter((k) => k.startsWith(prefix))
      for (const k of keys) {
        await rm(path('objects', k), { force: true })
        await rm(path('types', k), { force: true })
      }
      return keys.length
    },
  }
}

export function memoryStudioStore(): StudioStore & { keys(): string[] } {
  const objects = new Map<string, { body: Buffer; contentType: string }>()
  return {
    async put(key, body, contentType) { objects.set(key, { body: Buffer.from(body), contentType }) },
    async get(key) { return objects.get(key) ?? null },
    async deletePrefix(prefix) {
      let n = 0
      for (const k of [...objects.keys()]) if (k.startsWith(prefix)) { objects.delete(k); n++ }
      return n
    },
    async putStream(key, body, _length, contentType) { objects.set(key, { body: await collect(body), contentType }) },
    async getStream(key) {
      const o = objects.get(key)
      return o ? { body: Readable.from([o.body]), contentType: o.contentType, length: o.body.length } : null
    },
    keys: () => [...objects.keys()].sort(),
  }
}

let store: StudioStore | null = null

/** The configured store: file:// is local, anything else R2. Tests replace it with setStudioStore. */
export function getStudioStore(): StudioStore {
  if (!store) {
    const uri = config.studioS3Uri
    store = uri?.startsWith('file://') ? localStudioStore(fileURLToPath(uri)) : r2StudioStore(uri)
  }
  return store
}

export function setStudioStore(s: StudioStore | null): void {
  store = s
}
