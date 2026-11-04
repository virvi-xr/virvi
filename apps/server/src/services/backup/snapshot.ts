/**
 * Snapshot of a scene's live preset for the downloadable backup: every placed item with its stored transform,
 * and every file it uses classified as bundled, referenced (licence forbids bundling) or linked.
 * Only reads; the code generator and project assembler consume the result.
 */
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { eq } from 'drizzle-orm'
import type { Vec3 } from '@virvixr/shared'
import { db } from '../../db/connection.js'
import { assetLibraryItems, catalogPacks, mediaAssets, roomSets, scenePresets, scenes } from '../../db/schema.js'
import { withLiveStatus, normalizeUrl } from '../../streaming/live-status.js'
import { config } from '../../config.js'
import { serializePreset, type SerializedElement } from '../scene-serializer.js'

export type AssetUse = 'model' | 'texture' | 'video' | 'audio'
export type AssetPlan =
  | { kind: 'bundle'; url: string; path: string; use: AssetUse; attribution?: { pack: string; text: string } }
  | { kind: 'reference'; url: string; path: string; use: AssetUse; pack: string; license: string; sourceUrl: string }
  | { kind: 'link'; url: string; use: AssetUse }

export interface BakedItem {
  type: 'model' | 'image' | 'video' | 'sound' | 'ad_space'
  name: string
  position: Vec3
  rotation: Vec3
  scale: Vec3
  withCollisions: boolean
  /** Non-URL settings only; every URL lives in `assets`. */
  props: Record<string, unknown>
  /** Keyed by role: model, texture, offImage, liveSrc, `playlist.<n>`, audio, fallbackImage. */
  assets: Record<string, AssetPlan>
}

export interface BackupSnapshot {
  sceneName: string
  presetName: string
  otherPresets: string[]
  items: BakedItem[]
  skipped: { name: string; type: string; why: string }[]
  /** Names of baked items whose element or instance has a click event (not baked). */
  withClickEvents: string[]
}

const NOT_SHOWN = 'not shown in Decentraland by Virvi today'
const FOLDER: Record<AssetUse, string> = { model: 'models', texture: 'images', video: 'videos', audio: 'sounds' }
const CATALOG_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../../catalog')

type Pack = typeof catalogPacks.$inferSelect
type Known =
  | { kind: 'bundle'; attribution?: { pack: string; text: string } }
  | { kind: 'reference'; pack: Pack; sourceRef: string | null }

const tagFiles = new Map<string, { sourceRef: string; file: string }[]>()
function tagRows(source: string) {
  let rows = tagFiles.get(source)
  if (!rows) {
    try {
      rows = JSON.parse(readFileSync(resolve(CATALOG_DIR, 'tags', `${source}.json`), 'utf8'))
    } catch {
      rows = []
    }
    tagFiles.set(source, rows!)
  }
  return rows!
}

/** Where a person finds the file: the pack's repo, at the tag file's path minus its leading repo folder. */
function sourceUrlFor(pack: Pack, sourceRef: string | null): string {
  const file = sourceRef ? tagRows(pack.source).find((r) => r.sourceRef === sourceRef)?.file : undefined
  const rest = file?.split('/').slice(1).map(encodeURIComponent).join('/')
  return rest ? `${pack.sourceUrl.replace(/\/$/, '')}/blob/HEAD/${rest}` : pack.sourceUrl
}

async function knownUrls(): Promise<Map<string, Known>> {
  const known = new Map<string, Known>()
  const rooms = await db.select({ url: roomSets.glbUrl }).from(roomSets)
  for (const r of rooms) known.set(r.url, { kind: 'bundle' })
  const media = await db.select({ url: mediaAssets.publicUrl }).from(mediaAssets)
  for (const m of media) if (m.url) known.set(m.url, { kind: 'bundle' })
  const lib = await db
    .select({ url: assetLibraryItems.cdnUrl, sourceRef: assetLibraryItems.sourceRef, pack: catalogPacks })
    .from(assetLibraryItems)
    .leftJoin(catalogPacks, eq(catalogPacks.id, assetLibraryItems.packId))
  for (const l of lib) {
    if (!l.url) continue
    if (!l.pack) known.set(l.url, { kind: 'bundle' })
    else if (l.pack.license === 'mit') known.set(l.url, { kind: 'bundle', attribution: { pack: l.pack.name, text: l.pack.attribution } })
    else known.set(l.url, { kind: 'reference', pack: l.pack, sourceRef: l.sourceRef })
  }
  return known
}

function fileName(url: string, use: AssetUse): string {
  let base = ''
  try {
    base = decodeURIComponent(new URL(url).pathname.split('/').pop() ?? '')
  } catch {
    base = url.split(/[?#]/)[0].split('/').pop() ?? ''
  }
  base = base.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^\.+/, '')
  if (!base) base = use === 'model' ? 'model.glb' : 'file'
  if (use === 'model' && !/\.glb$/i.test(base)) base += '.glb'
  return base
}

/** Local path per distinct URL; a second distinct file with the same name gets -2, -3, … before the extension. */
function pathAllocator() {
  const byUrl = new Map<string, string>()
  const taken = new Set<string>()
  return (url: string, use: AssetUse): string => {
    const key = `${use}\u0000${url}`
    const have = byUrl.get(key)
    if (have) return have
    const name = fileName(url, use)
    const dot = name.lastIndexOf('.')
    const stem = dot > 0 ? name.slice(0, dot) : name
    const ext = dot > 0 ? name.slice(dot) : ''
    let n = 1
    let path = `${FOLDER[use]}/${name}`
    while (taken.has(path.toLowerCase())) path = `${FOLDER[use]}/${stem}-${++n}${ext}`
    taken.add(path.toLowerCase())
    byUrl.set(key, path)
    return path
  }
}

const isVirviHosted = (url: string): boolean => {
  try {
    const u = new URL(url)
    if (u.protocol !== 'https:') return false
    return [config.cdnUrl, config.publicUrl].some((b) => {
      try { return !!b && new URL(b).host.toLowerCase() === u.host.toLowerCase() } catch { return false }
    })
  } catch {
    return false
  }
}

const hasClick = (v: unknown): boolean =>
  !!v && (typeof v !== 'object' || Object.keys(v as object).length > 0)

const vec = (v: unknown, d: Vec3): Vec3 => {
  const o = (v && typeof v === 'object' ? v : {}) as Partial<Vec3>
  return { x: Number(o.x ?? d.x), y: Number(o.y ?? d.y), z: Number(o.z ?? d.z) }
}

const pick = (el: Record<string, unknown>, keys: string[]) =>
  Object.fromEntries(keys.filter((k) => el[k] !== undefined).map((k) => [k, el[k]]))

export async function backupSnapshot(sceneId: string): Promise<BackupSnapshot> {
  const scene = await db.query.scenes.findFirst({ where: eq(scenes.id, sceneId) })
  if (!scene) throw new Error('Scene not found')
  const presets = await db.query.scenePresets.findMany({
    where: eq(scenePresets.sceneId, sceneId),
    with: { elements: { with: { instances: true } } },
    orderBy: scenePresets.createdAt,
  })
  const active = presets.find((p) => p.id === scene.activePresetId)
  const snap: BackupSnapshot = {
    sceneName: scene.name,
    presetName: active?.name ?? '',
    otherPresets: presets.filter((p) => p.id !== active?.id).map((p) => p.name),
    items: [],
    skipped: [],
    withClickEvents: [],
  }
  if (!active) return snap

  const s = await withLiveStatus(serializePreset(active))
  const known = await knownUrls()
  const alloc = pathAllocator()

  /** Plan for one URL; null when it cannot be carried (a model not hosted by Virvi). */
  const plan = (rawUrl: unknown, use: AssetUse): AssetPlan | null => {
    const url = normalizeUrl(rawUrl)
    if (!url) return null
    const k = known.get(url)
    if (k?.kind === 'bundle') return { kind: 'bundle', url, path: alloc(url, use), use, ...(k.attribution ? { attribution: k.attribution } : {}) }
    if (k?.kind === 'reference') {
      return { kind: 'reference', url, path: alloc(url, use), use, pack: k.pack.name, license: k.pack.license, sourceUrl: sourceUrlFor(k.pack, k.sourceRef) }
    }
    return use === 'model' ? null : { kind: 'link', url, use }
  }

  const baked = (type: BakedItem['type'], el: SerializedElement, inst: SerializedElement['instances'][number], props: Record<string, unknown>, assets: Record<string, AssetPlan>): BakedItem => {
    if (hasClick(el.clickEvent) || hasClick(inst.clickEvent)) {
      if (!snap.withClickEvents.includes(el.name)) snap.withClickEvents.push(el.name)
    }
    return {
      type, name: el.name,
      position: vec(inst.position, { x: 0, y: 0, z: 0 }),
      rotation: vec(inst.rotation, { x: 0, y: 0, z: 0 }),
      scale: vec(inst.scale, { x: 1, y: 1, z: 1 }),
      withCollisions: inst.withCollisions,
      props, assets,
    }
  }

  const add = (el: SerializedElement, type: BakedItem['type'], build: () => { props: Record<string, unknown>; assets: Record<string, AssetPlan> } | { skip: string }) => {
    const live = el.instances.filter((i) => i.enabled)
    if (!el.enabled || live.length === 0) return
    const r = build()
    if ('skip' in r) {
      snap.skipped.push({ name: el.name, type, why: r.skip })
      return
    }
    for (const inst of live) snap.items.push(baked(type, el, inst, r.props, r.assets))
  }

  const put = (assets: Record<string, AssetPlan>, key: string, url: unknown, use: AssetUse) => {
    const p = plan(url, use)
    if (p) assets[key] = p
  }

  for (const el of s.models) {
    add(el, 'model', () => {
      const p = plan(el.modelSrc, 'model')
      if (!p) {
        const url = normalizeUrl(el.modelSrc)
        if (!url) return { skip: 'no model chosen' }
        return { skip: isVirviHosted(url) ? 'model file is not in the Virvi library or uploads, so it cannot be bundled' : 'model is not hosted by Virvi, so it cannot be bundled' }
      }
      return { props: {}, assets: { model: p } }
    })
  }
  for (const el of s.images) {
    add(el, 'image', () => {
      const assets: Record<string, AssetPlan> = {}
      put(assets, 'texture', el.textureSrc, 'texture')
      return { props: pick(el, ['emission', 'isTransparent']), assets }
    })
  }
  for (const el of s.videos) {
    add(el, 'video', () => {
      const assets: Record<string, AssetPlan> = {}
      put(assets, 'liveSrc', el.liveSrc, 'video')
      put(assets, 'offImage', el.offImageSrc, 'texture')
      const list = Array.isArray(el.playlist) ? el.playlist : []
      list.forEach((u, i) => put(assets, `playlist.${i}`, u, 'video'))
      return { props: pick(el, ['isLive', 'enableLiveStream', 'offType', 'volume', 'emission', 'adShape']), assets }
    })
  }
  for (const el of s.sounds) {
    add(el, 'sound', () => {
      const assets: Record<string, AssetPlan> = {}
      put(assets, 'audio', el.audioSrc, 'audio')
      return { props: pick(el, ['volume', 'sourceType']), assets }
    })
  }
  for (const el of s.adSpaces) {
    add(el, 'ad_space', () => {
      const assets: Record<string, AssetPlan> = {}
      put(assets, 'fallbackImage', el.fallbackImageSrc, 'texture')
      return { props: pick(el, ['shape', 'formats']), assets }
    })
  }
  for (const [list, type] of [[s.nfts, 'nft'], [s.widgets, 'widget'], [s.claimPoints, 'claim_point']] as const) {
    for (const el of list) {
      if (el.enabled && el.instances.some((i) => i.enabled)) snap.skipped.push({ name: el.name, type, why: NOT_SHOWN })
    }
  }
  return snap
}
