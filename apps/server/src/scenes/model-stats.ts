import { inArray } from 'drizzle-orm'
import { ImageUtils, NodeIO, type Node } from '@gltf-transform/core'
import { DCL_MAX_FILE_BYTES, localModelFile } from '@virvixr/shared'
import { db } from '../db/connection.js'
import { modelStats } from '../db/schema.js'
import { virviFileFetcher } from '../services/dcl/assemble.js'

/**
 * What each Virvi-hosted model costs to draw (LIV-41): triangles and textures, read from its GLB once and kept by URL.
 * Measured in the background, a couple at a time, the first time a scene's budget asks; until then a model counts as 0.
 */

export interface ModelCost { triangles: number; textureCount: number; textureBytes: number; maxTexturePx: number }
export type ModelStatsRow = typeof modelStats.$inferSelect

const TRIANGLES = 4
const COLLIDER = /_collider(_(box|sphere|capsule))?$/i
/** RGBA, the shape a texture takes on the GPU when its format can't be read */
const RGBA = 4

/** Triangles drawn (colliders left out) and every texture's size and estimated GPU memory, mipmaps included. */
export async function measureGlb(buf: Uint8Array): Promise<ModelCost> {
  const doc = await new NodeIO().readBinary(buf)
  const root = doc.getRoot()
  const scene = root.getDefaultScene() ?? root.listScenes()[0]
  let triangles = 0
  scene?.traverse((node: Node) => {
    if (COLLIDER.test(node.getName()) || COLLIDER.test(node.getMesh()?.getName() ?? '')) return
    for (const prim of node.getMesh()?.listPrimitives() ?? []) {
      if (prim.getMode() !== TRIANGLES) continue
      triangles += Math.floor((prim.getIndices()?.getCount() ?? prim.getAttribute('POSITION')?.getCount() ?? 0) / 3)
    }
  })
  let textureBytes = 0
  let maxTexturePx = 0
  const textures = root.listTextures()
  for (const t of textures) {
    const image = t.getImage()
    const mime = t.getMimeType() || (image ? ImageUtils.getMimeType(image) : null) || ''
    if (!image) continue
    const size = ImageUtils.getSize(image, mime)
    const vram = ImageUtils.getVRAMByteLength(image, mime) ?? (size ? Math.round(size[0] * size[1] * RGBA * 4 / 3) : 0)
    textureBytes += vram
    if (size) maxTexturePx = Math.max(maxTexturePx, size[0], size[1])
  }
  return { triangles, textureCount: textures.length, textureBytes, maxTexturePx }
}

export async function statsFor(urls: string[]): Promise<Map<string, ModelStatsRow>> {
  if (!urls.length) return new Map()
  const rows = await db.select().from(modelStats).where(inArray(modelStats.url, [...new Set(urls)]))
  return new Map(rows.map((r) => [r.url, r]))
}

type Fetch = (url: string) => Promise<Uint8Array>
let fetchModel: Fetch = (url) => virviFileFetcher(DCL_MAX_FILE_BYTES, 'The model')(url) as Promise<Uint8Array>
/** Tests: fetch models from somewhere else. */
export function setModelFetcher(f: Fetch | null) { fetchModel = f ?? ((url) => virviFileFetcher(DCL_MAX_FILE_BYTES, 'The model')(url) as Promise<Uint8Array>) }

const inFlight = new Map<string, Promise<void>>()
const queue: string[] = []
const CONCURRENCY = 2
export const RETRY_FAILED_MS = 24 * 60 * 60_000
let running = 0

async function measureOne(url: string): Promise<void> {
  let row: typeof modelStats.$inferInsert
  try {
    const cost = await measureGlb(await fetchModel(url))
    row = { url, ...cost, error: null, measuredAt: new Date() }
  } catch (err) {
    row = { url, triangles: null, textureCount: null, textureBytes: null, maxTexturePx: null, error: (err instanceof Error ? err.message : String(err)).slice(0, 300), measuredAt: new Date() }
  }
  await db.insert(modelStats).values(row).onConflictDoUpdate({ target: modelStats.url, set: row })
}

function pump() {
  while (running < CONCURRENCY && queue.length) {
    const url = queue.shift()!
    running++
    const done = measureOne(url).catch((err) => console.error('[model-stats] not saved:', err instanceof Error ? err.message : err)).finally(() => {
      running--
      inFlight.delete(url)
      pump()
    })
    inFlight.set(url, done)
  }
}

/** Starts measuring the Virvi-hosted GLBs among `urls` that have no row yet. Returns how many are still waiting or running. */
export function measureMissing(urls: string[], known: Map<string, ModelStatsRow>): number {
  let pending = 0
  for (const url of new Set(urls)) {
    const row = known.get(url)
    // A file that couldn't be read is tried again a day later (a network blip shouldn't stick)
    if ((row && !(row.error && Date.now() - row.measuredAt.getTime() > RETRY_FAILED_MS)) || !localModelFile(url)) continue
    pending++
    if (inFlight.has(url) || queue.includes(url)) continue
    queue.push(url)
  }
  pump()
  return pending
}

/** Tests: wait for every measurement started so far. */
export async function measurementsSettled(): Promise<void> {
  while (inFlight.size || queue.length) {
    if (inFlight.size) await Promise.all([...inFlight.values()])
    else await new Promise((r) => setTimeout(r, 5))
  }
}
