/**
 * Assembles a Decentraland deployment: the entity plus the files that still need uploading.
 *
 * A fresh deployment is the generic Virvi runtime + scene.json + every model. A redeploy starts
 * from the World's live entity: every live file stays (by hash), only missing models are fetched
 * and added, and a wizard-made scene on an older runtime gets the current one. Adopted scenes, and any
 * live scene without Virvi's `virvi` block (not made by the wizard), never have their code or metadata touched.
 */
import { and, count, eq, inArray } from 'drizzle-orm'
import { DCL_MAX_FILE_BYTES, localModelFile } from '@virvixr/shared'
import { config } from '../../config.js'
import { db } from '../../db/connection.js'
import { assetLibraryItems, mediaAssets, sceneElementInstances, sceneElements, scenes } from '../../db/schema.js'
import { assertPublicHttpUrl } from '../../net/public-url.js'
import { buildEntity, dclHash, type ContentRef, type SceneMetadata } from './entity.js'
import { DCL_RUNTIME_VERSION, runtimeFiles } from './runtime.js'
import type { LiveEntity } from './worlds-client.js'

export interface ModelNeed {
  elementId: string
  name: string
  url: string
  /** Deployed path, `models/virvi/<basename>.glb`. */
  file: string
  /** Of one copy of the model. */
  triangles: number | null
  bytes: number | null
  /** Placed instances of every element using this file (the wizard counts triangles per instance). */
  instances: number
}

export class ModelRefused extends Error {
  constructor(public reason: string) {
    super(reason)
    this.name = 'ModelRefused'
  }
}

export type ModelFetcher = (url: string) => Promise<Uint8Array>

export interface Assembled {
  entityId: string
  /** The entity file plus the new files, keyed by hash (what gets uploaded). */
  files: Map<string, Uint8Array>
  pointers: string[]
  /** Every content path in the entity. */
  deployedFiles: string[]
  /** Model files added by this deployment. */
  added: string[]
  /** Models left out, with the deployed path they would have had. */
  refused: Array<{ name: string; file: string; reason: string }>
  /** False when the World would get nothing new: no model added and no runtime upgrade. */
  changed: boolean
  triangles: number
  newBytes: number
  newFileSources: Array<{ file: string; hash: string; url: string }>
  /** Content entries referenced by hash, not uploaded. */
  existing: ContentRef[]
  metadata: SceneMetadata
}

/** The active preset's Virvi-hosted `.glb` model elements, one per deployed file. */
export async function modelsInScene(sceneId: string): Promise<ModelNeed[]> {
  const rows = await db
    .select({ id: sceneElements.id, name: sceneElements.name, properties: sceneElements.properties })
    .from(sceneElements)
    .innerJoin(scenes, eq(scenes.activePresetId, sceneElements.presetId))
    .where(and(eq(scenes.id, sceneId), eq(sceneElements.type, 'model')))
    .orderBy(sceneElements.createdAt, sceneElements.id)

  const placed = rows.length
    ? await db
        .select({ elementId: sceneElementInstances.elementId, n: count() })
        .from(sceneElementInstances)
        .where(inArray(sceneElementInstances.elementId, rows.map((r) => r.id)))
        .groupBy(sceneElementInstances.elementId)
    : []
  const placedBy = new Map(placed.map((p) => [p.elementId, Number(p.n)]))

  const picked: Array<{ id: string; name: string; url: string; file: string; instances: number }> = []
  const byFile = new Map<string, (typeof picked)[number]>()
  for (const r of rows) {
    const url = (r.properties as { modelSrc?: unknown } | null)?.modelSrc
    if (typeof url !== 'string') continue
    const file = localModelFile(url)
    if (!file) continue
    const instances = placedBy.get(r.id) ?? 0
    const seen = byFile.get(file)
    if (seen) { seen.instances += instances; continue }
    const p = { id: r.id, name: r.name, url, file, instances }
    byFile.set(file, p)
    picked.push(p)
  }
  if (picked.length === 0) return []

  const urls = picked.map((p) => p.url)
  const lib = await db
    .select({ url: assetLibraryItems.cdnUrl, triangles: assetLibraryItems.triangleCount, bytes: assetLibraryItems.fileSizeBytes })
    .from(assetLibraryItems)
    .where(inArray(assetLibraryItems.cdnUrl, urls))
  const media = await db
    .select({ url: mediaAssets.publicUrl, bytes: mediaAssets.sizeBytes })
    .from(mediaAssets)
    .where(inArray(mediaAssets.publicUrl, urls))
  const libByUrl = new Map(lib.map((l) => [l.url, l]))
  const mediaByUrl = new Map(media.map((m) => [m.url, m]))

  return picked.map((p) => {
    const l = libByUrl.get(p.url)
    const m = mediaByUrl.get(p.url)
    return {
      elementId: p.id,
      name: p.name,
      url: p.url,
      file: p.file,
      triangles: l?.triangles ?? null,
      bytes: l?.bytes ?? m?.bytes ?? null,
      instances: p.instances,
    }
  })
}

/** Models in the scene that the destination does not hold yet. */
export async function pendingModels(dest: { sceneId: string; deployedFiles: string[] }): Promise<ModelNeed[]> {
  const have = new Set(dest.deployedFiles.map((f) => f.toLowerCase()))
  return (await modelsInScene(dest.sceneId)).filter((m) => !have.has(m.file.toLowerCase()))
}

/** https, and a host that is ours: the CDN or the public API. Throws ModelRefused otherwise. */
function assertVirviHosted(url: string): URL {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    throw new ModelRefused('Not a valid URL')
  }
  if (u.protocol !== 'https:') throw new ModelRefused('Model is not served over https')
  const ours = [config.cdnUrl, config.publicUrl].flatMap((b) => {
    try { return b ? [new URL(b).host.toLowerCase()] : [] } catch { return [] }
  })
  if (!ours.includes(u.host.toLowerCase())) throw new ModelRefused('Model is not hosted by Virvi')
  return u
}

/** The live scene runs Virvi's own runtime (its `virvi` block carries the runtime version), so Virvi owns its
 *  scene.json and code. Anything else is the owner's own scene: adopted, its code and title never touched. */
export function builtByVirvi(metadata: { virvi?: { runtime?: unknown } } | undefined): boolean {
  return typeof metadata?.virvi?.runtime === 'number'
}

export const defaultModelFetcher: ModelFetcher = async (url) => {
  assertVirviHosted(url)
  try {
    await assertPublicHttpUrl(url)
  } catch (e) {
    throw new ModelRefused((e as Error).message)
  }
  const res = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(60_000) })
  if (!res.ok) throw new ModelRefused(`Model download failed (${res.status})`)
  const lenHeader = res.headers.get('content-length')
  if (lenHeader !== null) {
    const declared = Number(lenHeader)
    if (!/^\d+$/.test(lenHeader.trim()) || !Number.isFinite(declared)) throw new ModelRefused('Model has an invalid content-length')
    if (declared > DCL_MAX_FILE_BYTES) throw new ModelRefused('Model is over the 50 MB file limit')
  }
  if (!res.body) throw new ModelRefused('Model download had no body')
  // Enforce the cap while streaming: content-length may be absent or wrong.
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > DCL_MAX_FILE_BYTES) {
      await reader.cancel().catch(() => {})
      throw new ModelRefused('Model is over the 50 MB file limit')
    }
    chunks.push(value)
  }
  const buf = new Uint8Array(total)
  let off = 0
  for (const c of chunks) { buf.set(c, off); off += c.byteLength }
  return buf
}

export function wizardSceneJson(d: {
  title: string
  world: string
  base: string
  parcels: string[]
  spawn: { x: number; y: number; z: number }
}): SceneMetadata {
  return {
    display: { title: d.title },
    owner: '',
    contact: {},
    main: 'bin/index.js',
    scene: { parcels: d.parcels, base: d.base },
    ecs7: true,
    runtimeVersion: '7',
    worldConfiguration: { name: d.world },
    spawnPoints: [{ name: 'spawn1', default: true, position: { x: d.spawn.x, y: d.spawn.y, z: d.spawn.z }, cameraTarget: { x: d.spawn.x, y: d.spawn.y, z: d.spawn.z + 8 } }],
    virvi: {
      runtime: DCL_RUNTIME_VERSION,
      apiUrl: config.publicUrl,
      wssUrl: config.publicUrl.replace(/^http/i, 'ws'),
    },
  }
}

/** Fetches each model (after the host check); failures become `refused`, never abort the rest. */
async function fetchModels(models: ModelNeed[], fetcher: ModelFetcher) {
  const got = new Map<string, Uint8Array>()
  const sources: Array<{ file: string; url: string }> = []
  const refused: Assembled['refused'] = []
  for (const m of models) {
    try {
      assertVirviHosted(m.url)
      const bytes = await fetcher(m.url)
      if (bytes.byteLength > DCL_MAX_FILE_BYTES) throw new ModelRefused('Model is over the 50 MB file limit')
      got.set(m.file, bytes)
      sources.push({ file: m.file, url: m.url })
    } catch (e) {
      if (!(e instanceof ModelRefused)) console.error('[assemble] model fetch failed:', m.url, (e as Error)?.message ?? e)
      refused.push({ name: m.name, file: m.file, reason: e instanceof ModelRefused ? e.reason : 'Virvi could not download it' })
    }
  }
  return { got, sources, refused }
}

async function finish(input: {
  pointers: string[]
  metadata: SceneMetadata
  existing: ContentRef[]
  newFiles: Map<string, Uint8Array>
  timestamp: number
  modelFiles: Map<string, Uint8Array>
  sources: Array<{ file: string; url: string }>
  refused: Assembled['refused']
  models: ModelNeed[]
  changed: boolean
}): Promise<Assembled> {
  const { entityId, files } = await buildEntity(input)
  const newFileSources = await Promise.all(
    input.sources.map(async (s) => ({ ...s, hash: await dclHash(input.modelFiles.get(s.file)!) })),
  )
  const deployedFiles = [...input.existing.map((e) => e.file), ...input.newFiles.keys()].sort()
  const deployed = new Set(deployedFiles.map((f) => f.toLowerCase()))
  let newBytes = 0
  for (const b of input.newFiles.values()) newBytes += b.byteLength
  return {
    entityId,
    files,
    pointers: input.pointers,
    deployedFiles,
    added: input.sources.map((s) => s.file).sort(),
    refused: input.refused,
    changed: input.changed,
    triangles: input.models.filter((m) => deployed.has(m.file.toLowerCase())).reduce((n, m) => n + (m.triangles ?? 0) * m.instances, 0),
    newBytes,
    newFileSources,
    existing: input.existing,
    metadata: input.metadata,
  }
}

export async function assembleFresh(input: {
  metadata: SceneMetadata
  models: ModelNeed[]
  timestamp: number
  fetch?: ModelFetcher
}): Promise<Assembled> {
  const { got, sources, refused } = await fetchModels(input.models, input.fetch ?? defaultModelFetcher)
  const newFiles = new Map<string, Uint8Array>(await runtimeFiles())
  newFiles.set('scene.json', new TextEncoder().encode(JSON.stringify(input.metadata)))
  for (const [file, bytes] of got) newFiles.set(file, bytes)
  return finish({
    pointers: input.metadata.scene.parcels,
    metadata: input.metadata,
    existing: [],
    newFiles,
    timestamp: input.timestamp,
    modelFiles: got,
    sources,
    refused,
    models: input.models,
    changed: true,
  })
}

const LEGACY_MODEL_DIR = 'models/vlm/' // virvi-rename: keep

/** True when `url` is on the pre-rename hosted domain (any subdomain). */
function onLegacyHost(url: string | undefined): boolean {
  try {
    return !!url && /(^|\.)vlm\.gg$/i.test(new URL(url).hostname) // virvi-rename: keep
  } catch {
    return false
  }
}

export async function assembleRedeploy(input: {
  live: LiveEntity
  adopted: boolean
  models: ModelNeed[]
  timestamp: number
  fetch?: ModelFetcher
  /** The scene's name: a World Virvi built is redeployed under it when it differs from the live title. An adopted
   *  World keeps its own title, from the owner's scene.json. */
  title?: string
}): Promise<Assembled> {
  const { live } = input
  const have = new Set(live.content.map((c) => c.file.toLowerCase()))
  const missing = input.models.filter((m) => !have.has(m.file.toLowerCase()))
  const { got, sources, refused } = await fetchModels(missing, input.fetch ?? defaultModelFetcher)

  let existing = live.content
  let metadata = live.metadata
  const newFiles = new Map<string, Uint8Array>(got)
  // Only a scene Virvi built (it carries the `virvi` block) gets Virvi's runtime; anything else is the owner's code.
  const upgrade = !input.adopted && !!live.metadata.virvi && live.metadata.virvi.runtime < DCL_RUNTIME_VERSION
  if (upgrade) {
    for (const [file, bytes] of await runtimeFiles()) {
      existing = existing.filter((c) => c.file !== file)
      newFiles.set(file, bytes)
    }
    // Models deployed before the rename live under the old folder, which the current runtime never reads.
    existing = existing.filter((c) => !c.file.toLowerCase().startsWith(LEGACY_MODEL_DIR))
    const current = { apiUrl: config.publicUrl, wssUrl: config.publicUrl.replace(/^http/i, 'ws') }
    const prior = live.metadata.virvi!
    metadata = {
      ...live.metadata,
      virvi: {
        ...current,
        ...prior,
        // A World built against the pre-rename hosted API follows the current one; a self-hosted address stays.
        ...(onLegacyHost(prior.apiUrl) ? { apiUrl: current.apiUrl } : {}),
        ...(onLegacyHost(prior.wssUrl) ? { wssUrl: current.wssUrl } : {}),
        runtime: DCL_RUNTIME_VERSION,
      },
    }
  }
  const renamed = !input.adopted && !!input.title && input.title !== metadata.display?.title
  if (renamed) metadata = { ...metadata, display: { ...metadata.display, title: input.title! } }
  return finish({
    pointers: live.pointers,
    metadata,
    existing,
    newFiles,
    timestamp: input.timestamp,
    modelFiles: got,
    sources,
    refused,
    models: input.models,
    changed: got.size > 0 || upgrade || renamed,
  })
}
