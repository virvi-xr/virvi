import { S3Client, PutObjectCommand, GetObjectCommand, ListObjectsV2Command, DeleteObjectsCommand } from '@aws-sdk/client-s3'
import { mkdir, readFile, writeFile, rm, readdir, stat } from 'node:fs/promises'
import { createReadStream, createWriteStream } from 'node:fs'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { config } from '../config.js'

/**
 * A private object bucket: nothing in it is ever served from a public URL. The Design Studio keeps its files in one
 * (studio/store.ts) and scene imports keep uploaded sources, built output and build logs in another (getImportStore).
 */
export interface PrivateStore {
  put(key: string, body: Buffer, contentType: string): Promise<void>
  get(key: string): Promise<{ body: Buffer; contentType: string } | null>
  deletePrefix(prefix: string): Promise<number>
  /** Deletes one object; 1 when it was there (a store that can't tell says 1). */
  delete(key: string): Promise<number>
  /** Deletes these objects, in batches the store can take; how many were asked for. */
  deleteKeys(keys: string[]): Promise<number>
  /** Every key under `prefix` with its size in bytes and, when the store knows it, when it was last written; sorted by key. */
  list(prefix: string): Promise<StoredObject[]>
  /** Large objects stream through, never held whole in memory. */
  putStream(key: string, body: Readable, length: number, contentType: string): Promise<void>
  getStream(key: string): Promise<{ body: Readable; contentType: string; length?: number } | null>
}

export interface StoredObject { key: string; size: number; modifiedAt?: Date }

async function collect(body: Readable): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const c of body) chunks.push(Buffer.from(c))
  return Buffer.concat(chunks)
}

const DELETE_BATCH = 1000

export function r2PrivateStore(uri: string): PrivateStore {
  const u = new URL(uri)
  const bucket = u.pathname.replace(/^\/+|\/+$/g, '')
  const client = new S3Client({
    region: 'auto',
    endpoint: `https://${u.host}`,
    forcePathStyle: true,
    credentials: { accessKeyId: decodeURIComponent(u.username), secretAccessKey: decodeURIComponent(u.password) },
  })
  async function deleteKeys(keys: string[]) {
    for (let i = 0; i < keys.length; i += DELETE_BATCH) {
      const res = await client.send(new DeleteObjectsCommand({
        Bucket: bucket,
        Delete: { Objects: keys.slice(i, i + DELETE_BATCH).map((Key) => ({ Key })), Quiet: true },
      }))
      if (res.Errors?.length) throw new Error(`failed to delete ${res.Errors.length} objects from the private bucket`)
    }
    return keys.length
  }
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
    async list(prefix) {
      const out: StoredObject[] = []
      let token: string | undefined
      do {
        const res = await client.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token }))
        for (const o of res.Contents ?? []) if (o.Key?.startsWith(prefix)) out.push({ key: o.Key, size: o.Size ?? 0, modifiedAt: o.LastModified })
        token = res.IsTruncated ? res.NextContinuationToken : undefined
      } while (token)
      return out.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    },
    async deletePrefix(prefix) {
      const keys: string[] = []
      let token: string | undefined
      do {
        const res = await client.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token }))
        for (const o of res.Contents ?? []) if (o.Key?.startsWith(prefix)) keys.push(o.Key)
        token = res.IsTruncated ? res.NextContinuationToken : undefined
      } while (token)
      return deleteKeys(keys)
    },
    async delete(key) {
      return deleteKeys([key])
    },
    deleteKeys,
  }
}

/** Files on disk, for development and the local end-to-end run. Content types sit beside the objects, under types/. */
export function localPrivateStore(dir: string): PrivateStore {
  const root = resolve(dir)
  const path = (area: 'objects' | 'types', key: string) => {
    if (key.split('/').some((seg) => seg === '..')) throw new Error('private store key escapes its folder')
    const p = resolve(root, area, key)
    if (!p.startsWith(join(root, area) + sep)) throw new Error('private store key escapes its folder')
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
  async function deleteKeys(keys: string[]) {
    for (const k of keys) {
      await rm(path('objects', k), { force: true })
      await rm(path('types', k), { force: true })
    }
    return keys.length
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
    async list(prefix) {
      const base = join(root, 'objects') + sep
      const out: StoredObject[] = []
      for (const p of await walk(join(root, 'objects'))) {
        const key = p.slice(base.length).split(sep).join('/')
        if (!key.startsWith(prefix)) continue
        const st = await stat(p)
        out.push({ key, size: st.size, modifiedAt: st.mtime })
      }
      return out.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    },
    async deletePrefix(prefix) {
      const base = join(root, 'objects') + sep
      const keys = (await walk(join(root, 'objects')))
        .map((p) => p.slice(base.length).split(sep).join('/'))
        .filter((k) => k.startsWith(prefix))
      return deleteKeys(keys)
    },
    async delete(key) {
      const there = await stat(path('objects', key)).then((st) => st.isFile(), () => false)
      await deleteKeys([key])
      return there ? 1 : 0
    },
    deleteKeys,
  }
}

export function memoryPrivateStore(): PrivateStore & { keys(): string[]; setModifiedAt(key: string, at: Date): void } {
  const objects = new Map<string, { body: Buffer; contentType: string; modifiedAt: Date }>()
  return {
    async put(key, body, contentType) { objects.set(key, { body: Buffer.from(body), contentType, modifiedAt: new Date() }) },
    async get(key) { const o = objects.get(key); return o ? { body: o.body, contentType: o.contentType } : null },
    async deletePrefix(prefix) {
      let n = 0
      for (const k of [...objects.keys()]) if (k.startsWith(prefix)) { objects.delete(k); n++ }
      return n
    },
    async delete(key) { return objects.delete(key) ? 1 : 0 },
    async deleteKeys(keys) { for (const k of keys) objects.delete(k); return keys.length },
    async list(prefix) {
      return [...objects.entries()].filter(([k]) => k.startsWith(prefix)).map(([key, o]) => ({ key, size: o.body.length, modifiedAt: o.modifiedAt }))
        .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    },
    async putStream(key, body, _length, contentType) { objects.set(key, { body: await collect(body), contentType, modifiedAt: new Date() }) },
    async getStream(key) {
      const o = objects.get(key)
      return o ? { body: Readable.from([o.body]), contentType: o.contentType, length: o.body.length } : null
    },
    keys: () => [...objects.keys()].sort(),
    /** Tests: backdates an object. */
    setModifiedAt(key, at) { const o = objects.get(key); if (o) o.modifiedAt = at },
  }
}

/** file:// is a local directory, anything else is R2. */
export function privateStoreFromUri(uri: string): PrivateStore {
  return uri.startsWith('file://') ? localPrivateStore(fileURLToPath(uri)) : r2PrivateStore(uri)
}

let importStore: PrivateStore | null = null

/**
 * Where scene imports keep sources, built output and logs. Tests replace it with setImportStore. Only single mode may fall
 * back to local disk (outside the served uploads folder); scalable and cloud need a shared bucket.
 */
export function getImportStore(): PrivateStore {
  if (!importStore) {
    let uri = config.sceneImportS3Uri
    if (!uri && config.mode === 'single') {
      // The uploads folder is served publicly at /uploads/, so the private folder must never sit in it
      const root = resolve(config.localStoragePath)
      const dir = resolve(config.privateStoragePath)
      if (dir === root || dir.startsWith(root + sep)) {
        throw new Error(`PRIVATE_STORAGE_PATH (${dir}) must be outside LOCAL_STORAGE_PATH (${root}), which is served publicly`)
      }
      uri = pathToFileURL(dir).href
    }
    if (!uri) throw new Error('SCENE_IMPORT_S3_URI is not set')
    importStore = privateStoreFromUri(uri)
  }
  return importStore
}

export function setImportStore(s: PrivateStore | null): void {
  importStore = s
}

