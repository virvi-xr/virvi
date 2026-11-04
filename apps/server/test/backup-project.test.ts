import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { eq, sql } from 'drizzle-orm'
import { strFromU8, strToU8, zipSync } from 'fflate'
import { config } from '../src/config.js'
import { db } from '../src/db/connection.js'
import { assetLibraryItems, catalogPacks, dclWorldDestinations, mediaAssets, sceneElementInstances, sceneImports, scenePresets, streamingServers } from '../src/db/schema.js'
import { ModelRefused } from '../src/services/dcl/assemble.js'
import { BackupError, backupProject, sizeLabel } from '../src/services/backup/project.js'
import { memoryPrivateStore, setImportStore } from '../src/storage/private-store.js'
import { resetDb } from './helpers/db.js'
import { createElement, createScene, createUser, randomWallet } from './helpers/factories.js'

const CDN = 'https://cdn.virvi.test'
const TEMPLATE = resolve(dirname(fileURLToPath(import.meta.url)), '../../../dcl-runtime')
const SCENE_JSON = '{"main":"bin/index.js","runtimeVersion":"7","scene":{"parcels":["0,0"],"base":"0,0"}}'
const PKG = JSON.stringify({ name: 'my-scene', version: '1.0.0', devDependencies: { '@dcl/sdk': 'latest' } }, null, 2) + '\n'
const MAIN = "import { engine } from '@dcl/sdk/ecs'\n\nexport function main() {\n  engine.addSystem(() => {})\n}\n"

const enc = (s: string) => new TextEncoder().encode(s)
const text = (m: Map<string, Uint8Array>, p: string) => strFromU8(m.get(p)!)
const fetcher = () => vi.fn(async (url: string) => enc(`bytes of ${url}`))
const calls = (src: string) => src.split('bakeVirviContent()').length - 1

let store: ReturnType<typeof memoryPrivateStore>
let user: Awaited<ReturnType<typeof createUser>>
let savedCdn: string | null

beforeEach(async () => {
  await resetDb()
  store = memoryPrivateStore()
  setImportStore(store)
  savedCdn = config.cdnUrl
  ;(config as { cdnUrl: string | null }).cdnUrl = CDN
  user = await createUser({ wallet: randomWallet() })
})
afterEach(() => {
  setImportStore(null)
  ;(config as { cdnUrl: string | null }).cdnUrl = savedCdn
})

/** A deployed import of the scene whose kept original is `files`. */
async function imported(sceneId: string, files: Record<string, string>) {
  const zip = Buffer.from(zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strToU8(v)]))))
  const [row] = await db.insert(sceneImports).values({ userId: user.id, sceneId, worldName: `w${Math.random().toString(36).slice(2)}.dcl.eth`, kind: 'sdk7', sourceKey: 'x', status: 'deployed', finishedAt: new Date() }).returning()
  const key = `imports/${row.id}/original.zip`
  await store.put(key, zip, 'application/zip')
  await store.put(`imports/${row.id}/source.zip`, zip, 'application/zip')
  await db.update(sceneImports).set({ originalKey: key, sourceKey: `imports/${row.id}/source.zip` }).where(eq(sceneImports.id, row.id))
}

async function destination(sceneId: string, o: Partial<typeof dclWorldDestinations.$inferInsert> = {}) {
  await db.insert(dclWorldDestinations).values({
    sceneId, ownerUserId: user.id, ownerWallet: user.wallet!, worldName: 'moon.dcl.eth', base: '0,0', parcels: ['0,0', '1,0'],
    mode: 'virvi', grantedAt: new Date(), lastEntityId: 'bafy', ...o,
  })
}

async function upload(name: string, sizeBytes = 1) {
  const url = `${CDN}/u/${name}`
  await db.insert(mediaAssets).values({ ownerId: user.id, filename: name, contentType: 'application/octet-stream', sizeBytes, publicUrl: url })
  return url
}

async function placed(presetId: string, type: 'image' | 'video' | 'sound' | 'model' | 'ad_space' | 'widget', name: string, properties: Record<string, unknown>) {
  const el = await createElement(presetId, { type, name, properties })
  const [inst] = await db.insert(sceneElementInstances).values({ elementId: el.id, position: { x: 1, y: 2, z: 3 } }).returning()
  return { el, inst }
}

const noVirviCode = (files: Map<string, Uint8Array>) => {
  for (const [path, bytes] of files) {
    if (!/\.(?:ts|tsx|js|json)$/.test(path)) continue
    expect(strFromU8(bytes), path).not.toMatch(/@virvixr|createVirvi/)
  }
}

describe('backupProject', () => {
  it('an imported scene keeps its own code and gains one call', async () => {
    const { scene, preset } = await createScene(user, 'Cafe')
    const creator = {
      'scene.json': '{"main":"bin/index.js","runtimeVersion":"7","scene":{"parcels":["0,0"],"base":"0,0"},"virvi":{"apiUrl":"https://x.test"}}',
      'package.json': PKG,
      'src/index.ts': MAIN,
      'src/other.ts': 'export const a = 1\n',
      'assets/scene/main.composite': '{"version":1}',
      'models/chair.glb': 'the creator chair',
      'README.md': '# My cafe\n',
    }
    await imported(scene.id, creator)
    await placed(preset.id, 'image', 'Logo', { textureSrc: await upload('logo.png') })
    await placed(preset.id, 'model', 'Chair', { modelSrc: await upload('chair.glb') })

    const f = fetcher()
    const r = await backupProject(scene.id, { fetch: f })
    expect(r.problems).toEqual([])
    for (const p of ['package.json', 'src/other.ts', 'assets/scene/main.composite', 'models/chair.glb']) {
      expect(text(r.files, p), p).toBe(creator[p as keyof typeof creator])
    }
    expect(text(r.files, 'src/index.ts')).toBe(
      "import { bakeVirviContent } from './virvi-baked'\nimport { engine } from '@dcl/sdk/ecs'\n\nexport function main() {\n  bakeVirviContent()\n  engine.addSystem(() => {})\n}\n",
    )
    expect(JSON.parse(text(r.files, 'scene.json'))).toEqual({ main: 'bin/index.js', runtimeVersion: '7', scene: { parcels: ['0,0'], base: '0,0' } })
    const baked = text(r.files, 'src/virvi-baked.ts')
    expect(baked).toContain('export function bakeVirviContent(): void {')
    expect(baked).toContain('"images/logo.png"')
    // The creator's own models/chair.glb is kept; Virvi's chair goes beside it
    expect(baked).toContain('"models/chair-2.glb"')
    expect(text(r.files, 'models/chair-2.glb')).toBe(`bytes of ${CDN}/u/chair.glb`)
    expect(text(r.files, 'images/logo.png')).toBe(`bytes of ${CDN}/u/logo.png`)
    const readme = text(r.files, 'README.md')
    expect(readme).toContain('npm install')
    expect(readme).toContain('npx @dcl/sdk-commands deploy')
    expect(readme).toContain('Creator Hub')
    expect(readme.endsWith('\n---\n\n# My cafe\n')).toBe(true) // the creator's own README is kept, under the backup's
    expect(r.files.has('ATTRIBUTION.md')).toBe(false)
    expect(r.files.has('MISSING-ASSETS.md')).toBe(false)
    noVirviCode(r.files)
  })

  it('adds the call to every main() form install-virvi accepts', async () => {
    const forms: Array<[string, string, string]> = [
      ['src/index.ts', 'export async function main(): Promise<void> {\n  await x()\n}\n', 'Promise<void> {\n  bakeVirviContent()\n  await x()\n}'],
      ['src/index.ts', 'export const main = async () => {\n  x()\n}\n', '=> {\n  bakeVirviContent()\n  x()\n}'],
      ['src/index.ts', 'export const main = (): void => {\n  x()\n}\n', '=> {\n  bakeVirviContent()\n  x()\n}'],
      ['src/index.ts', 'export function main() {}\n', 'export function main() {\n  bakeVirviContent()\n}\n'],
      ['src/index.ts', 'export function main() { x() }\n', '{\n  bakeVirviContent()\n x() }'],
      ['src/index.ts', "import a from 'a'\r\nexport function main() {\r\n  x()\r\n}\r\n", "import { bakeVirviContent } from './virvi-baked'\r\nimport a from 'a'\r\nexport function main() {\r\n  bakeVirviContent()\r\n  x()\r\n}\r\n"],
      ['src/index.ts', "/// <reference types=\"x\" />\n'use strict'\nexport function main() {}\n", "/// <reference types=\"x\" />\n'use strict'\nimport { bakeVirviContent } from './virvi-baked'\nexport function main() {"],
      ['src/index.ts', '/* export function main() { */\nexport function main() {\n  x()\n}\n', '*/\nexport function main() {\n  bakeVirviContent()\n  x()'],
      ['src/index.tsx', 'export function main() {}\n', 'bakeVirviContent()'],
      ['src/index.js', 'export function main() {}\n', 'bakeVirviContent()'],
    ]
    for (const [path, src, want] of forms) {
      const { scene } = await createScene(user, 'Form')
      await imported(scene.id, { 'scene.json': SCENE_JSON, 'package.json': PKG, [path]: src })
      const r = await backupProject(scene.id, { fetch: fetcher() })
      const out = text(r.files, path)
      expect(out, src).toContain(want)
      expect(calls(out), src).toBe(1)
      expect(out.split("import { bakeVirviContent } from './virvi-baked'").length - 1, src).toBe(1)
      expect(r.problems, src).toEqual([])
    }

    // A backup imported again already calls it: no second call
    const { scene: again } = await createScene(user, 'Again')
    const done = "import { bakeVirviContent } from './virvi-baked'\nexport function main() {\n  bakeVirviContent()\n}\n"
    await imported(again.id, { 'scene.json': SCENE_JSON, 'package.json': PKG, 'src/index.ts': done, 'src/virvi-baked.ts': 'export function bakeVirviContent(): void {}\n' })
    expect(text((await backupProject(again.id, { fetch: fetcher() })).files, 'src/index.ts')).toBe(done)

    // No main to call it from: still a project, with the problem named
    const { scene: bare } = await createScene(user, 'Bare')
    await imported(bare.id, { 'scene.json': SCENE_JSON, 'package.json': PKG, 'src/index.ts': 'export function start() {}\n' })
    const r = await backupProject(bare.id, { fetch: fetcher() })
    expect(text(r.files, 'src/index.ts')).toBe('export function start() {}\n')
    expect(r.problems).toHaveLength(1)
    expect(r.problems[0]).toMatch(/main\(\)/)
    expect(text(r.files, 'README.md')).toContain(r.problems[0])
  })

  it('a Virvi-built World gets the template with no virvi block', async () => {
    const { scene, preset } = await createScene(user, 'Moon Base')
    await destination(scene.id, { spawn: { x: 4, y: 0, z: 2 } })
    await placed(preset.id, 'image', 'Logo', { textureSrc: await upload('logo.png') })
    const r = await backupProject(scene.id, { fetch: fetcher() })
    expect([...r.files.keys()].sort()).toEqual(['README.md', 'images/logo.png', 'package.json', 'scene.json', 'src/index.ts', 'src/virvi-baked.ts', 'tsconfig.json'])

    const tpl = JSON.parse(readFileSync(resolve(TEMPLATE, 'package.json'), 'utf8'))
    const pkg = JSON.parse(text(r.files, 'package.json'))
    expect(pkg.devDependencies).toEqual(tpl.devDependencies)
    expect(pkg.dependencies).toBeUndefined()
    expect(pkg.scripts.build).toBe('sdk-commands build')
    expect(text(r.files, 'tsconfig.json')).toBe(readFileSync(resolve(TEMPLATE, 'tsconfig.json'), 'utf8'))

    const sj = JSON.parse(text(r.files, 'scene.json'))
    expect(sj.virvi).toBeUndefined()
    expect(sj).toMatchObject({
      display: { title: 'Moon Base' }, main: 'bin/index.js', ecs7: true, runtimeVersion: '7',
      scene: { parcels: ['0,0', '1,0'], base: '0,0' }, worldConfiguration: { name: 'moon.dcl.eth' },
    })
    expect(sj.spawnPoints[0].position).toEqual({ x: 4, y: 0, z: 2 })
    const index = text(r.files, 'src/index.ts')
    expect(index).toContain("import { bakeVirviContent } from './virvi-baked'")
    expect(index).toMatch(/export function main\(\)[^{]*\{\s*bakeVirviContent\(\)/)
    noVirviCode(r.files)
  })

  it('a Virvi-built Genesis City scene has parcels and no worldConfiguration', async () => {
    const { scene } = await createScene(user, 'Plaza')
    await destination(scene.id, { kind: 'parcels', worldName: null, base: '10,20', parcels: ['10,20', '11,20'] })
    const sj = JSON.parse(text((await backupProject(scene.id, { fetch: fetcher() })).files, 'scene.json'))
    expect(sj.worldConfiguration).toBeUndefined()
    expect(sj.virvi).toBeUndefined()
    expect(sj.scene).toEqual({ parcels: ['10,20', '11,20'], base: '10,20' })
    expect(sj.spawnPoints).toHaveLength(1)
  })

  it('a scene with no import and no Decentraland destination is not_decentraland', async () => {
    const { scene } = await createScene(user, 'Nowhere')
    await expect(backupProject(scene.id, { fetch: fetcher() })).rejects.toMatchObject({ status: 422, code: 'not_decentraland' })
  })

  it('an empty live preset', async () => {
    const { scene } = await createScene(user, 'Empty')
    await destination(scene.id)
    const f = fetcher()
    const r = await backupProject(scene.id, { fetch: f })
    expect(f).not.toHaveBeenCalled()
    expect(r.problems).toEqual([])
    expect(text(r.files, 'src/virvi-baked.ts')).toContain('export function bakeVirviContent(): void {\n}')
    expect(calls(text(r.files, 'src/index.ts'))).toBe(1)
    expect(text(r.files, 'README.md')).toMatch(/nothing placed/i)

    const { scene: imp } = await createScene(user, 'Empty import')
    await imported(imp.id, { 'scene.json': SCENE_JSON, 'package.json': PKG, 'src/index.ts': MAIN })
    const r2 = await backupProject(imp.id, { fetch: f })
    expect(calls(text(r2.files, 'src/index.ts'))).toBe(1)
    expect([...r2.files.keys()].sort()).toEqual(['README.md', 'package.json', 'scene.json', 'src/index.ts', 'src/virvi-baked.ts'])
  })

  it('a referenced asset is listed with its source URL and not bundled', async () => {
    const { scene, preset } = await createScene(user, 'Shop')
    await destination(scene.id)
    await db.insert(catalogPacks).values([
      { id: 'dcl-builder-fantasy', name: 'Decentraland Builder: Fantasy', source: 'decentraland', license: 'cc-by-nc-3.0', attribution: 'Decentraland, CC BY-NC 3.0', sourceUrl: 'https://github.com/decentraland/builder-assets' },
      { id: 'dhingia-dj', name: 'Mr Dhingia: DJ & Club Kit', source: 'dhingia', license: 'mit', attribution: 'MIT (c) Mr Dhingia', sourceUrl: 'https://github.com/MrDhingia/DhingiaBuilds' },
    ])
    await db.insert(assetLibraryItems).values([
      { name: 'Anvil', storageKey: 'a', cdnUrl: `${CDN}/c/anvil.glb`, packId: 'dcl-builder-fantasy', sourceRef: '05_Fantasy_Pack/Anvil_01' },
      { name: 'Deck', storageKey: 'b', cdnUrl: `${CDN}/c/deck.glb`, packId: 'dhingia-dj', sourceRef: 'deck' },
    ])
    await placed(preset.id, 'model', 'Anvil', { modelSrc: `${CDN}/c/anvil.glb` })
    await placed(preset.id, 'model', 'Deck', { modelSrc: `${CDN}/c/deck.glb` })
    const f = fetcher()
    const r = await backupProject(scene.id, { fetch: f })
    expect(f.mock.calls.map((c) => c[0])).toEqual([`${CDN}/c/deck.glb`])
    expect(r.files.has('models/anvil.glb')).toBe(false)
    expect(text(r.files, 'src/virvi-baked.ts')).toContain('"models/anvil.glb"')
    const missing = text(r.files, 'MISSING-ASSETS.md')
    expect(missing).toContain('models/anvil.glb')
    expect(missing).toContain('https://github.com/decentraland/builder-assets/blob/HEAD/assets/05_Fantasy_Pack/Anvil_01/Anvil_01.glb')
    expect(missing).toContain('cc-by-nc-3.0')
    expect(missing).not.toContain(`${CDN}/c/anvil.glb`)
    expect(text(r.files, 'models/deck.glb')).toBe(`bytes of ${CDN}/c/deck.glb`)
    const attribution = text(r.files, 'ATTRIBUTION.md')
    expect(attribution).toContain('Mr Dhingia: DJ & Club Kit')
    expect(attribution).toContain('MIT (c) Mr Dhingia')
    expect(attribution).toContain('models/deck.glb')
    expect(attribution).not.toContain('anvil')
    expect(text(r.files, 'README.md')).toContain('MISSING-ASSETS.md')
  })

  it('a failed asset fetch is reported, not fatal', async () => {
    const { scene, preset } = await createScene(user, 'Flaky')
    await destination(scene.id)
    const good = await upload('good.png')
    const bad = await upload('bad.png')
    const broken = await upload('broken.glb')
    const huge = await upload('huge.png')
    await placed(preset.id, 'image', 'Good', { textureSrc: good })
    await placed(preset.id, 'image', 'Bad', { textureSrc: bad })
    await placed(preset.id, 'model', 'Broken', { modelSrc: broken })
    await placed(preset.id, 'image', 'Huge', { textureSrc: huge })
    const f = vi.fn(async (url: string) => {
      if (url === bad) throw new ModelRefused('Image download failed (404)')
      if (url === broken) throw new Error('socket hang up')
      if (url === huge) return new Uint8Array(10 * 1024 * 1024 + 1)
      return enc('ok')
    })
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const r = await backupProject(scene.id, { fetch: f })
    err.mockRestore()
    expect(text(r.files, 'images/good.png')).toBe('ok')
    for (const p of ['images/bad.png', 'models/broken.glb', 'images/huge.png']) expect(r.files.has(p), p).toBe(false)
    expect(r.problems).toHaveLength(3)
    expect(r.problems.find((p) => p.includes('images/bad.png'))).toContain('Image download failed (404)')
    expect(r.problems.find((p) => p.includes('models/broken.glb'))).toContain('could not download')
    expect(r.problems.find((p) => p.includes('images/huge.png'))).toContain('10 MB')
    const readme = text(r.files, 'README.md')
    for (const p of r.problems) expect(readme).toContain(p)
    expect(readme).toContain(bad)
  })

  it('a file not hosted by Virvi is never fetched', async () => {
    const { scene, preset } = await createScene(user, 'Hosts')
    await destination(scene.id)
    // Classified as a bundle by an exact match, but not on a Virvi host
    await db.insert(mediaAssets).values({ ownerId: user.id, filename: 'x.png', contentType: 'image/png', sizeBytes: 1, publicUrl: 'https://evil.example/x.png' })
    await placed(preset.id, 'image', 'Evil', { textureSrc: 'https://evil.example/x.png' })
    const f = fetcher()
    const r = await backupProject(scene.id, { fetch: f })
    expect(f).not.toHaveBeenCalled()
    expect(r.problems).toHaveLength(1)
    expect(r.problems[0]).toMatch(/not hosted by Virvi/)
  })

  it('the README lists what was not baked', async () => {
    const { scene, preset } = await createScene(user, 'Club')
    await imported(scene.id, {
      'scene.json': SCENE_JSON, 'package.json': PKG, 'src/index.ts': MAIN,
      'src/own.ts': "import { createVirvi } from '@virvixr/dcl'\nexport const v = createVirvi\n",
    })
    await db.insert(scenePresets).values({ sceneId: scene.id, name: 'Night' })
    await db.insert(streamingServers).values({ ownerId: user.id, name: 's', status: 'live', hlsPlaylistUrl: 'https://stream.virvi.test/live.m3u8' })
    const { el: button } = await placed(preset.id, 'image', 'Button', {})
    await db.execute(sql`update scene_elements set click_event = '{"type":1,"url":"https://x.test"}' where id = ${button.id}`)
    await placed(preset.id, 'video', 'Stage screen', { liveSrc: 'https://stream.virvi.test/live.m3u8', enableLiveStream: true, offType: 0 })
    await placed(preset.id, 'widget', 'Toggle', {})
    await placed(preset.id, 'sound', 'Silent', {})
    await placed(preset.id, 'image', 'Linked', { textureSrc: `${CDN}/not-an-upload.png` })
    const r = await backupProject(scene.id, { fetch: fetcher() })
    const readme = text(r.files, 'README.md')
    expect(readme).toContain('Button') // click events (R1)
    expect(readme).toContain('Night') // other presets (R3)
    expect(readme).toContain('Default')
    expect(readme).toContain('Stage screen') // live stream (R4)
    expect(readme).toContain('https://stream.virvi.test/live.m3u8')
    expect(readme).toContain('Toggle') // skipped
    expect(readme).toContain('not shown in Decentraland by Virvi today')
    expect(readme).toContain('Silent') // a sound with no clip
    expect(readme).toContain(`${CDN}/not-an-upload.png`) // a Virvi-hosted file kept as a link
    expect(readme).toContain('src/own.ts') // leftovers
  })

  it('over 500 MB is refused', async () => {
    // Sizes Virvi already knows: refused before anything is downloaded
    const { scene, preset } = await createScene(user, 'Big')
    await destination(scene.id)
    for (let i = 0; i < 11; i++) await placed(preset.id, 'model', `M${i}`, { modelSrc: await upload(`m${i}.glb`, 50 * 1024 * 1024) })
    await placed(preset.id, 'image', 'Tiny', { textureSrc: await upload('tiny.png', 2048) })
    const f = vi.fn(async () => new Uint8Array(1))
    const e = await backupProject(scene.id, { fetch: f }).catch((x) => x)
    expect(f).not.toHaveBeenCalled()
    expect(e).toBeInstanceOf(BackupError)
    expect(e).toMatchObject({ status: 413, code: 'backup_too_big' })
    expect(e.message).toMatch(/500 MB/)
    expect(e.message).toMatch(/models\/m\d+\.glb \(50\.0 MB\)/)

    // Sizes Virvi doesn't know: stops at the first file over the limit and fetches no more
    const { scene: s2, preset: p2 } = await createScene(user, 'Big unknown')
    await destination(s2.id, { worldName: 'big2.dcl.eth' })
    for (let i = 0; i < 15; i++) await placed(p2.id, 'model', `N${i}`, { modelSrc: await upload(`n${i}.glb`) })
    const big = new Uint8Array(50 * 1024 * 1024)
    const g = vi.fn(async () => big)
    const e2 = await backupProject(s2.id, { fetch: g }).catch((x) => x)
    expect(e2).toMatchObject({ status: 413, code: 'backup_too_big' })
    expect(e2.message).toMatch(/models\/n\d+\.glb/)
    expect(g).toHaveBeenCalledTimes(10) // ten 50 MiB files and the project files pass 500 MB; the other five are never fetched
  })

  it('sizes in the refusal read right for small files', () => {
    expect(sizeLabel(2048)).toBe('2 KB')
    expect(sizeLabel(10)).toBe('1 KB')
    expect(sizeLabel(1.5 * 1024 * 1024)).toBe('1.5 MB')
    expect(sizeLabel(50 * 1024 * 1024)).toBe('50.0 MB')
  })

  it('a World destination with no World name is not_decentraland', async () => {
    const { scene } = await createScene(user, 'Nameless')
    await destination(scene.id, { worldName: null })
    await expect(backupProject(scene.id, { fetch: fetcher() })).rejects.toMatchObject({ status: 422, code: 'not_decentraland' })
  })

  it('an imported bakeVirviContent that main() never calls gets the call', async () => {
    const { scene } = await createScene(user, 'Uncalled')
    const src = "import { bakeVirviContent } from './virvi-baked'\nexport function main() {\n  x()\n}\n"
    await imported(scene.id, { 'scene.json': SCENE_JSON, 'package.json': PKG, 'src/index.ts': src })
    const r = await backupProject(scene.id, { fetch: fetcher() })
    expect(text(r.files, 'src/index.ts')).toBe("import { bakeVirviContent } from './virvi-baked'\nexport function main() {\n  bakeVirviContent()\n  x()\n}\n")
    expect(r.problems).toEqual([])
  })

  it("the creator's readme.md is merged whatever its case", async () => {
    const { scene } = await createScene(user, 'Cases')
    await imported(scene.id, { 'scene.json': SCENE_JSON, 'package.json': PKG, 'src/index.ts': MAIN, 'readme.md': '# lower\n' })
    const r = await backupProject(scene.id, { fetch: fetcher() })
    expect([...r.files.keys()].filter((k) => k.toLowerCase() === 'readme.md')).toEqual(['README.md'])
    expect(text(r.files, 'README.md').endsWith('\n---\n\n# lower\n')).toBe(true)
  })
})
