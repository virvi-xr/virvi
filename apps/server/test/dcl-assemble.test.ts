import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { DCL_MAX_FILE_BYTES } from '@virvixr/shared'
import { config } from '../src/config.js'
import { db } from '../src/db/connection.js'
import { eq } from 'drizzle-orm'
import { assetLibraryItems, scenes } from '../src/db/schema.js'
import {
  assembleFresh, assembleImported, assembleRedeploy, modelsInScene, pendingModels, wizardSceneJson, defaultModelFetcher, virviFileFetcher, FileTooBig, ModelRefused,
  type ModelNeed,
} from '../src/services/dcl/assemble.js'
import { dclHash } from '../src/services/dcl/entity.js'
import { runtimeFiles, DCL_RUNTIME_VERSION } from '../src/services/dcl/runtime.js'
import type { LiveEntity } from '../src/services/dcl/worlds-client.js'
import { createUser, createScene, createElement, createInstance } from './helpers/factories.js'

const CDN = 'https://cdn.virvi.test'
const enc = (s: string) => new TextEncoder().encode(s)
const need = (n: string, url = `${CDN}/m/${n}.glb`): ModelNeed => ({
  elementId: n, name: n, url, file: `models/virvi/${n}.glb`, triangles: 100, bytes: 10, instances: 1,
})

let savedCdn: string | null
beforeEach(() => { savedCdn = config.cdnUrl; (config as { cdnUrl: string | null }).cdnUrl = CDN })
afterEach(() => { (config as { cdnUrl: string | null }).cdnUrl = savedCdn })

const fetcher = () => vi.fn(async (url: string) => enc(`bytes of ${url}`))

/**
 * A live wizard World on runtime `runtime` (default: the current one). The current version carries its real runtime
 * files; an older one (no longer shipped) carries a stand-in bin/index.js only, as v1 Worlds did.
 */
async function live(over: Partial<LiveEntity['metadata']> = {}, runtime = DCL_RUNTIME_VERSION): Promise<LiveEntity> {
  const rt = runtime === DCL_RUNTIME_VERSION ? await runtimeFiles() : new Map([['bin/index.js', enc(`runtime v${runtime}`)]])
  const meta = { ...wizardSceneJson({ title: 'T', world: 'w.dcl.eth', base: '0,0', parcels: ['0,0'], spawn: { x: 8, y: 0, z: 8 } }), ...over }
  if (meta.virvi) meta.virvi = { ...meta.virvi, runtime }
  return {
    id: 'bafyold', pointers: ['0,0'], metadata: meta,
    content: [
      ...(await Promise.all([...rt].map(async ([file, bytes]) => ({ file, hash: await dclHash(bytes) })))),
      { file: 'scene.json', hash: await dclHash(enc('scene')) },
      { file: 'models/virvi/a.glb', hash: await dclHash(enc('a')) },
    ],
  }
}

describe('assembleRedeploy', () => {
  it('uploads only models that are not already live', async () => {
    const l = await live()
    const f = fetcher()
    const r = await assembleRedeploy({ live: l, adopted: false, models: [need('a'), need('b')], timestamp: 1, fetch: f })
    expect(f).toHaveBeenCalledTimes(1)
    expect(r.added).toEqual(['models/virvi/b.glb'])
    expect(r.pointers).toEqual(['0,0'])
    expect(r.deployedFiles).toEqual(['bin/index.js', 'images/virvi/hud-v.png', 'models/virvi/a.glb', 'models/virvi/b.glb', 'scene.json'])
    for (const c of l.content) expect(r.existing).toContainEqual(c)
    expect(r.newFileSources).toEqual([{ file: 'models/virvi/b.glb', hash: await dclHash(enc(`bytes of ${CDN}/m/b.glb`)), url: `${CDN}/m/b.glb` }])
    expect(r.files.size).toBe(2) // entity file + b
    expect(r.triangles).toBe(200)
  })

  it('leaves adopted scenes (no virvi block) untouched', async () => {
    const l = await live()
    delete (l.metadata as { virvi?: unknown }).virvi
    const before = JSON.stringify(l.metadata)
    const r = await assembleRedeploy({ live: l, adopted: true, models: [need('a')], timestamp: 1, fetch: fetcher() })
    expect(r.added).toEqual([])
    expect(r.existing.find((c) => c.file === 'bin/index.js')).toEqual(l.content[0])
    expect(JSON.stringify(r.metadata)).toBe(before)
  })

  it("never swaps in Virvi's runtime on a scene without a virvi block, even when not marked adopted", async () => {
    const l = await live()
    delete (l.metadata as { virvi?: unknown }).virvi
    l.content[0].hash = await dclHash(enc('owner code'))
    const before = JSON.stringify(l.metadata)
    const r = await assembleRedeploy({ live: l, adopted: false, models: [need('a'), need('b')], timestamp: 1, fetch: fetcher() })
    expect(r.existing.find((c) => c.file === 'bin/index.js')).toEqual(l.content[0])
    expect(JSON.stringify(r.metadata)).toBe(before)
    expect(r.added).toEqual(['models/virvi/b.glb'])
  })

  it("a new scene name is a change: a wizard World's title follows it", async () => {
    const r = await assembleRedeploy({ live: await live(), adopted: false, models: [need('a')], timestamp: 1, fetch: fetcher(), title: 'New name' })
    expect(r.changed).toBe(true)
    expect(r.metadata.display.title).toBe('New name')
    expect(JSON.parse(new TextDecoder().decode(r.files.get(r.entityId)!)).metadata.display.title).toBe('New name')
    const same = await assembleRedeploy({ live: await live(), adopted: false, models: [need('a')], timestamp: 1, fetch: fetcher(), title: 'T' })
    expect(same.changed).toBe(false)
  })

  it("an adopted World keeps its own title when the scene's name differs", async () => {
    const r = await assembleRedeploy({ live: await live(), adopted: true, models: [need('a'), need('b')], timestamp: 1, fetch: fetcher(), title: 'New name' })
    expect(r.metadata.display.title).toBe('T')
    const none = await assembleRedeploy({ live: await live(), adopted: true, models: [need('a')], timestamp: 1, fetch: fetcher(), title: 'New name' })
    expect(none.changed).toBe(false)
  })

  it('says whether anything would change: a new model or a runtime upgrade', async () => {
    const same = await assembleRedeploy({ live: await live(), adopted: false, models: [need('a')], timestamp: 1, fetch: fetcher() })
    expect(same.changed).toBe(false)
    const refusedOnly = await assembleRedeploy({ live: await live(), adopted: false, models: [need('a'), need('x', 'https://evil.example/x.glb')], timestamp: 1, fetch: fetcher() })
    expect([refusedOnly.changed, refusedOnly.refused.length]).toEqual([false, 1])
    const added = await assembleRedeploy({ live: await live(), adopted: false, models: [need('a'), need('b')], timestamp: 1, fetch: fetcher() })
    expect(added.changed).toBe(true)
    const old = await live({}, 0)
    old.content[0].hash = await dclHash(enc('old runtime'))
    expect((await assembleRedeploy({ live: old, adopted: false, models: [need('a')], timestamp: 1, fetch: fetcher() })).changed).toBe(true)
  })

  it('upgrades the runtime of a wizard scene on an older version', async () => {
    const l = await live({}, 0)
    l.content[0].hash = await dclHash(enc('old runtime'))
    const r = await assembleRedeploy({ live: l, adopted: false, models: [need('a')], timestamp: 1, fetch: fetcher() })
    const newHash = await dclHash((await runtimeFiles()).get('bin/index.js')!)
    expect(r.existing.find((c) => c.file === 'bin/index.js')).toBeUndefined()
    expect(r.files.has(newHash)).toBe(true)
    expect(r.metadata.virvi?.runtime).toBe(DCL_RUNTIME_VERSION)
    expect(r.deployedFiles).toContain('bin/index.js')
  })

  it('upgrading a v1 World adds the HUD icon and replaces bin/index.js', async () => {
    const l = await live({}, 1)
    expect(l.content.map((c) => c.file)).not.toContain('images/virvi/hud-v.png')
    const r = await assembleRedeploy({ live: l, adopted: false, models: [need('a')], timestamp: 1, fetch: fetcher() })
    expect(r.changed).toBe(true)
    expect(r.deployedFiles).toEqual(['bin/index.js', 'images/virvi/hud-v.png', 'models/virvi/a.glb', 'scene.json'])
    for (const [, bytes] of await runtimeFiles()) expect(r.files.has(await dclHash(bytes))).toBe(true)
    expect(r.existing.map((c) => c.file).sort()).toEqual(['models/virvi/a.glb', 'scene.json'])
    expect(r.metadata.virvi?.runtime).toBe(DCL_RUNTIME_VERSION)
  })

  it('upgrading a World built before the rename points it at the current API and drops the old model folder', async () => {
    const old = ['vlm', 'gg'].join('.') // virvi-rename: keep
    const l = await live({}, 1)
    l.metadata.virvi = { ...l.metadata.virvi!, apiUrl: `https://api.${old}`, wssUrl: `wss://api.${old}` }
    l.content.push({ file: 'models/vlm/old.glb', hash: await dclHash(enc('old')) }) // virvi-rename: keep
    const r = await assembleRedeploy({ live: l, adopted: false, models: [need('a')], timestamp: 1, fetch: fetcher() })
    expect(r.metadata.virvi?.apiUrl).toBe(config.publicUrl)
    expect(r.metadata.virvi?.wssUrl).toBe(config.publicUrl.replace(/^http/i, 'ws'))
    expect(r.deployedFiles.some((f) => f.startsWith('models/vlm/'))).toBe(false) // virvi-rename: keep
  })

  it('upgrading keeps a self-hosted API address', async () => {
    const l = await live({}, 1)
    l.metadata.virvi = { ...l.metadata.virvi!, apiUrl: 'https://virvi.example.org', wssUrl: 'wss://virvi.example.org' }
    const r = await assembleRedeploy({ live: l, adopted: false, models: [need('a')], timestamp: 1, fetch: fetcher() })
    expect(r.metadata.virvi?.apiUrl).toBe('https://virvi.example.org')
  })

  it('refuses foreign and private model hosts without fetching them', async () => {
    const f = fetcher()
    const r = await assembleRedeploy({
      live: await live(), adopted: false, timestamp: 1, fetch: f,
      models: [need('evil', 'https://evil.example/x.glb'), need('priv', 'https://10.0.0.1/x.glb'), need('http', 'http://cdn.virvi.test/x.glb'), need('ok')],
    })
    expect(r.refused.map((x) => x.name)).toEqual(['evil', 'priv', 'http'])
    expect(r.refused.every((x) => x.reason.length > 0)).toBe(true)
    expect(f).toHaveBeenCalledTimes(1)
    expect(r.added).toEqual(['models/virvi/ok.glb'])
  })
})

describe('assembleFresh', () => {
  it('holds exactly the runtime, scene.json and one file per model', async () => {
    const metadata = wizardSceneJson({ title: 'T', world: 'w.dcl.eth', base: '0,0', parcels: ['0,0', '1,0'], spawn: { x: 8, y: 0, z: 8 } })
    const r = await assembleFresh({ metadata, models: [need('a'), need('b')], timestamp: 1, fetch: fetcher() })
    expect(r.deployedFiles).toEqual(['bin/index.js', 'images/virvi/hud-v.png', 'models/virvi/a.glb', 'models/virvi/b.glb', 'scene.json'])
    expect(r.added).toEqual(['models/virvi/a.glb', 'models/virvi/b.glb'])
    expect(r.pointers).toEqual(['0,0', '1,0'])
    expect(r.existing).toEqual([])
    const sceneHash = await dclHash(enc(JSON.stringify(metadata)))
    const sceneJson = JSON.parse(new TextDecoder().decode(r.files.get(sceneHash)!))
    expect(sceneJson.worldConfiguration.name).toBe('w.dcl.eth')
    expect(sceneJson.scene.parcels).toEqual(['0,0', '1,0'])
  })

  it('wizardSceneJson points the runtime at this server', () => {
    const m = wizardSceneJson({ title: 'T', world: 'w', base: '0,0', parcels: ['0,0'], spawn: { x: 1, y: 0, z: 2 } })
    expect(m).toMatchObject({ main: 'bin/index.js', ecs7: true, runtimeVersion: '7', virvi: { runtime: DCL_RUNTIME_VERSION, apiUrl: config.publicUrl } })
    expect(m.virvi!.wssUrl).toMatch(/^wss?:\/\//)
    expect(m.spawnPoints).toHaveLength(1)
  })
})

describe('defaultModelFetcher', () => {
  it('refuses foreign hosts and plain http', async () => {
    await expect(defaultModelFetcher('https://evil.example/x.glb')).rejects.toMatchObject({ name: 'ModelRefused' })
    await expect(defaultModelFetcher('http://cdn.virvi.test/x.glb')).rejects.toMatchObject({ name: 'ModelRefused' })
  })
})

describe('defaultModelFetcher streaming cap', () => {
  const URL_OK = 'https://8.8.8.8/m/big.glb' // public literal: no DNS in tests
  beforeEach(() => { (config as { cdnUrl: string | null }).cdnUrl = 'https://8.8.8.8' })
  afterEach(() => vi.unstubAllGlobals())

  it('aborts an unbounded body without content-length before buffering it all', async () => {
    const chunk = new Uint8Array(8 * 1024 * 1024)
    let pulled = 0
    let cancelled = false
    const body = new ReadableStream<Uint8Array>({
      pull(c) { pulled++; if (pulled > 100) return c.close(); c.enqueue(chunk) },
      cancel() { cancelled = true },
    })
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body)))
    await expect(defaultModelFetcher(URL_OK)).rejects.toMatchObject({ name: 'ModelRefused' })
    expect(cancelled).toBe(true)
    expect(pulled * chunk.byteLength).toBeLessThan(DCL_MAX_FILE_BYTES + 3 * chunk.byteLength)
    expect(pulled).toBeLessThan(100)
  })

  it('rejects a non-numeric content-length', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array(4), { headers: { 'content-length': 'abc' } })))
    await expect(defaultModelFetcher(URL_OK)).rejects.toMatchObject({ name: 'ModelRefused' })
  })

  it('a caller\'s signal aborts the download in flight; an over-cap file is FileTooBig', async () => {
    const ac = new AbortController()
    let seen: AbortSignal | undefined
    vi.stubGlobal('fetch', vi.fn((_url: string, init: RequestInit) => new Promise<Response>((_, reject) => {
      seen = init.signal ?? undefined
      init.signal?.addEventListener('abort', () => reject(init.signal!.reason))
    })))
    const pending = virviFileFetcher(1024, 'Video', ac.signal)(URL_OK)
    await vi.waitFor(() => expect(seen).toBeDefined())
    ac.abort(new Error('deadline'))
    await expect(pending).rejects.toThrow('deadline')

    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array(2048))))
    const big = await virviFileFetcher(1024, 'Video')(URL_OK).catch((e) => e)
    expect(big).toBeInstanceOf(FileTooBig)
    expect(big).toBeInstanceOf(ModelRefused)
  })

  it('returns a small body', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array([1, 2, 3]))))
    expect(Array.from(await defaultModelFetcher(URL_OK))).toEqual([1, 2, 3])
  })
})

describe('modelsInScene / pendingModels', () => {
  it('reads the active preset, de-duplicates and fills sizes', async () => {
    const user = await createUser()
    const { scene, preset } = await createScene(user)
    const url = `${CDN}/m/Chair.glb`
    await db.insert(assetLibraryItems).values({ name: 'Chair', cdnUrl: url, storageKey: 'k', fileSizeBytes: 1234, triangleCount: 99 } as never)
    const chair = await createElement(preset.id, { type: 'model', name: 'Chair', properties: { modelSrc: url } })
    const chair2 = await createElement(preset.id, { type: 'model', name: 'Chair 2', properties: { modelSrc: url } })
    for (const id of [chair.id, chair.id, chair2.id]) await createInstance(id)
    await createElement(preset.id, { type: 'model', name: 'Bad', properties: { modelSrc: 'https://x.example/thing.fbx' } })
    await createElement(preset.id, { type: 'model', name: 'Other', properties: { modelSrc: `${CDN}/m/Table.glb` } })
    const models = await modelsInScene(scene.id)
    expect(models.map((m) => m.file)).toEqual(['models/virvi/Chair.glb', 'models/virvi/Table.glb'])
    expect(models[0]).toMatchObject({ triangles: 99, bytes: 1234, instances: 3 }) // placed instances of every element using the file
    expect(models[1]).toMatchObject({ triangles: null, bytes: null, instances: 0 })
    const pending = await pendingModels({ sceneId: scene.id, deployedFiles: ['MODELS/Virvi/chair.glb'] })
    expect(pending.map((m) => m.file)).toEqual(['models/virvi/Table.glb'])
  })
})

describe('scene thumbnail in a deployment (LIV-88)', () => {
  const HASH = '0123456789abcdef'
  const FILE = `images/scene-thumbnail-${HASH}.png`
  const OLD = 'images/scene-thumbnail-fedcba9876543210.jpg'
  const thumb = (file = FILE): ModelNeed => ({
    elementId: '', name: 'Scene thumbnail', url: `${CDN}/scenes/s/thumbnail-${file.slice(-20, -4)}.png`, file, triangles: null, bytes: 50, instances: 0, kind: 'thumbnail',
  })
  const enc2 = (s2: string) => new TextEncoder().encode(s2)

  it('modelsInScene lists the thumbnail after the models; pendingModels says when it is new or was removed', async () => {
    const user = await createUser()
    const { scene, preset } = await createScene(user)
    await createElement(preset.id, { type: 'model', name: 'Chair', properties: { modelSrc: `${CDN}/m/Chair.glb` } })
    expect((await modelsInScene(scene.id)).map((m) => m.file)).toEqual(['models/virvi/Chair.glb'])
    // The scene's thumbnail was deployed, then removed in Virvi
    expect((await pendingModels({ sceneId: scene.id, deployedFiles: ['models/virvi/chair.glb', FILE] })).map((m) => [m.file, m.kind, m.removed])).toEqual([
      [FILE, 'thumbnail', true],
    ])

    const key = `scenes/${scene.id}/thumbnail-${HASH}.png`
    await db.update(scenes).set({ thumbnailKey: key, thumbnailUrl: `${CDN}/${key}`, thumbnailBytes: 4321 }).where(eq(scenes.id, scene.id))
    const models = await modelsInScene(scene.id)
    expect(models.map((m) => m.file)).toEqual(['models/virvi/Chair.glb', FILE])
    expect(models[1]).toMatchObject({ name: 'Scene thumbnail', url: `${CDN}/${key}`, bytes: 4321, instances: 0, triangles: null, kind: 'thumbnail' })
    expect((await pendingModels({ sceneId: scene.id, deployedFiles: ['models/virvi/chair.glb'] })).map((m) => m.file)).toEqual([FILE])
    expect(await pendingModels({ sceneId: scene.id, deployedFiles: ['models/virvi/chair.glb', FILE] })).toEqual([])
    // Replaced: the new one is pending (the old one goes with it)
    expect((await pendingModels({ sceneId: scene.id, deployedFiles: ['models/virvi/chair.glb', OLD] })).map((m) => m.file)).toEqual([FILE])
  })

  it('a fresh deploy includes the image and sets display.navmapThumbnail to it', async () => {
    const metadata = wizardSceneJson({ title: 'T', world: 'w.dcl.eth', base: '0,0', parcels: ['0,0'], spawn: { x: 8, y: 0, z: 8 } })
    const r = await assembleFresh({ metadata, models: [need('a'), thumb()], timestamp: 1, fetch: fetcher() })
    expect(r.deployedFiles).toContain(FILE)
    expect(r.added).toContain(FILE)
    expect(r.metadata.display).toEqual({ title: 'T', navmapThumbnail: FILE })
    const sceneJson = JSON.parse(new TextDecoder().decode(r.files.get(await dclHash(enc2(JSON.stringify(r.metadata))))!))
    expect(sceneJson.display.navmapThumbnail).toBe(FILE)
    expect(r.triangles).toBe(100)
    // Without one there is no navmapThumbnail
    const none = await assembleFresh({ metadata, models: [need('a')], timestamp: 1, fetch: fetcher() })
    expect(none.metadata.display).toEqual({ title: 'T' })
  })

  it('a thumbnail Virvi could not fetch is refused and not named in scene.json', async () => {
    const metadata = wizardSceneJson({ title: 'T', world: 'w.dcl.eth', base: '0,0', parcels: ['0,0'], spawn: { x: 8, y: 0, z: 8 } })
    const r = await assembleFresh({ metadata, models: [{ ...thumb(), url: 'https://evil.example/t.png' }], timestamp: 1, fetch: fetcher() })
    expect(r.refused.map((x) => x.file)).toEqual([FILE])
    expect(r.refused[0].reason).toMatch(/^Thumbnail /)
    expect(r.deployedFiles).not.toContain(FILE)
    expect(r.metadata.display.navmapThumbnail).toBeUndefined()
  })

  it('a redeploy of a Virvi-built World adds a new thumbnail, drops the old file, and is a change', async () => {
    const l = await live({ display: { title: 'T', navmapThumbnail: OLD } })
    l.content.push({ file: OLD, hash: await dclHash(enc2('old thumb')) })
    const r = await assembleRedeploy({ live: l, adopted: false, models: [need('a'), thumb()], timestamp: 1, fetch: fetcher() })
    expect(r.changed).toBe(true)
    expect(r.added).toEqual([FILE])
    expect(r.deployedFiles).toContain(FILE)
    expect(r.deployedFiles).not.toContain(OLD)
    expect(r.metadata.display).toEqual({ title: 'T', navmapThumbnail: FILE })
  })

  it('removing the thumbnail removes the file and navmapThumbnail on the next redeploy', async () => {
    const l = await live({ display: { title: 'T', navmapThumbnail: FILE } })
    l.content.push({ file: FILE, hash: await dclHash(enc2('thumb')) })
    const r = await assembleRedeploy({ live: l, adopted: false, models: [need('a')], timestamp: 1, fetch: fetcher() })
    expect(r.changed).toBe(true)
    expect(r.deployedFiles).not.toContain(FILE)
    expect(r.metadata.display).toEqual({ title: 'T' })
  })

  it('a World already showing the thumbnail has nothing new', async () => {
    const l = await live({ display: { title: 'T', navmapThumbnail: FILE } })
    l.content.push({ file: FILE, hash: await dclHash(enc2('thumb')) })
    const f = fetcher()
    const r = await assembleRedeploy({ live: l, adopted: false, models: [need('a'), thumb()], timestamp: 1, fetch: f })
    expect(f).not.toHaveBeenCalled()
    expect(r.changed).toBe(false)
    expect(r.metadata.display).toEqual({ title: 'T', navmapThumbnail: FILE })
  })

  it("an adopted scene changes only display.navmapThumbnail, and only when a thumbnail is set in Virvi", async () => {
    const l = await live({ display: { title: 'Mine', navmapThumbnail: 'images/mine.png', description: 'd' } })
    delete (l.metadata as { virvi?: unknown }).virvi
    const before = structuredClone(l.metadata)
    const r = await assembleRedeploy({ live: l, adopted: true, models: [need('a'), thumb()], timestamp: 1, fetch: fetcher(), title: 'Other' })
    expect(r.changed).toBe(true)
    expect(r.added).toEqual([FILE])
    expect(r.metadata).toEqual({ ...before, display: { ...before.display, navmapThumbnail: FILE } })

    // No thumbnail in Virvi: the owner's own navmapThumbnail stays, nothing changes
    const none = await assembleRedeploy({ live: l, adopted: true, models: [need('a')], timestamp: 1, fetch: fetcher() })
    expect(none.changed).toBe(false)
    expect(none.metadata).toEqual(before)

    // Removed in Virvi after it was deployed: Virvi's own file and navmapThumbnail go, nothing else
    const shown = structuredClone(l)
    shown.metadata.display = { ...shown.metadata.display, navmapThumbnail: FILE }
    shown.content.push({ file: FILE, hash: await dclHash(enc2('thumb')) })
    const removed = await assembleRedeploy({ live: shown, adopted: true, models: [need('a')], timestamp: 1, fetch: fetcher() })
    expect(removed.changed).toBe(true)
    expect(removed.deployedFiles).not.toContain(FILE)
    const { navmapThumbnail: _n, ...display } = before.display
    expect(removed.metadata).toEqual({ ...before, display })
  })

  it('an imported scene gets only navmapThumbnail and the image when a thumbnail is set; otherwise its scene.json is untouched', async () => {
    const files = new Map([['scene.json', enc2('{}')], ['bin/index.js', enc2('code')]])
    const metadata = { ...wizardSceneJson({ title: 'Theirs', world: 'w.dcl.eth', base: '0,0', parcels: ['0,0'], spawn: { x: 8, y: 0, z: 8 } }), display: { title: 'Theirs', navmapThumbnail: 'images/theirs.png' } }
    delete (metadata as { virvi?: unknown }).virvi
    const before = structuredClone(metadata)
    const withThumb = await assembleImported({ files, metadata, timestamp: 1, models: [thumb()], fetch: fetcher() })
    expect(withThumb.metadata).toEqual({ ...before, display: { title: 'Theirs', navmapThumbnail: FILE } })
    expect(withThumb.deployedFiles).toEqual(['bin/index.js', FILE, 'scene.json'])
    expect(withThumb.added).toEqual([FILE])
    const without = await assembleImported({ files, metadata, timestamp: 1, models: [], fetch: fetcher() })
    expect(without.metadata).toEqual(before)
    expect(without.deployedFiles).toEqual(['bin/index.js', 'scene.json'])
  })
})
