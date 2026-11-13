import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { zipSync } from 'fflate'
import { eq } from 'drizzle-orm'
import { db } from '../src/db/connection.js'
import { sceneImports } from '../src/db/schema.js'
import { memoryPrivateStore, setImportStore } from '../src/storage/private-store.js'
import { resetDb } from './helpers/db.js'
import { createScene, createUser } from './helpers/factories.js'
import { strToU8, strFromU8 } from 'fflate'
import { installVirvi } from '../src/services/import/install-virvi.js'
import { sceneSourceFor, uninstallVirvi } from '../src/services/import/uninstall-virvi.js'
import type { SceneFolder } from '../src/services/import/scene-zip.js'

const sceneJson = { main: 'bin/index.js', runtimeVersion: '7', scene: { parcels: ['0,0'], base: '0,0' } }
const pkg = (deps?: Record<string, string>) => JSON.stringify({ name: 'my-scene', version: '1.0.0', ...(deps ? { dependencies: deps } : {}), devDependencies: { '@dcl/sdk': 'latest' } }, null, 2) + '\n'

function folder(src: Record<string, string>, kind: SceneFolder['kind'] = 'sdk7'): SceneFolder {
  const files = new Map<string, Uint8Array>()
  files.set('scene.json', strToU8('{"main":"bin/index.js","runtimeVersion":"7","scene":{"parcels":["0,0"],"base":"0,0"}}'))
  for (const [k, v] of Object.entries(src)) files.set(k, strToU8(v))
  return { files, sceneJson, kind, location: { kind: 'parcels', parcels: ['0,0'], base: '0,0' } }
}

/** Installs, un-installs and expects every file back byte for byte. */
async function roundTrips(f: SceneFolder) {
  const installed = await installVirvi(f)
  const back = uninstallVirvi(installed.files)
  expect([...back.files.keys()].sort()).toEqual([...f.files.keys()].sort())
  for (const [k, v] of f.files) expect(strFromU8(back.files.get(k)!), k).toBe(strFromU8(v))
  expect(back.leftovers).toEqual([])
}

const MAIN = "import { engine } from '@dcl/sdk/ecs'\n\nexport function main() {\n  engine.addSystem(() => {})\n}\n"

describe('uninstallVirvi', () => {
  it('reverses installVirvi on an SDK7 scene', async () => {
    await roundTrips(folder({ 'package.json': pkg(), 'src/index.ts': MAIN }))
  })

  it('reverses installVirvi on a Creator Hub scene', async () => {
    await roundTrips(folder({ 'package.json': pkg(), 'assets/scene/main.composite': '{"version":1}', 'src/index.ts': MAIN }, 'creator-hub'))
  })

  it('reverses the main forms installVirvi edits', async () => {
    for (const src of [
      'export function main() {}\n',
      'export function main() { x() }\n',
      'export async function main(): Promise<void> {\n  await x()\n}\n',
      'export const main = (): void => {\n  x()\n}\n',
      "/// <reference types=\"x\" />\nimport a from 'a'\r\nexport function main() {\r\n  x()\r\n}\r\n".replaceAll('\r\n', '\n'),
      "import a from 'a'\r\nexport function main() {\r\n  x()\r\n}\r\n",
    ]) await roundTrips(folder({ 'package.json': pkg({ left: '1.0.0' }), 'src/index.ts': src }))
    await roundTrips(folder({ 'package.json': pkg(), 'src/index.js': 'export function main() {}\n' }))
  })

  it('takes out a dependency an earlier Virvi installed, at any range Virvi has used', async () => {
    for (const old of ['^2.5.0', '^2.6.0', '^2.7.0', '^2.8.0']) {
      const installed = (await installVirvi(folder({ 'package.json': pkg({ left: '1.0.0' }), 'src/index.ts': MAIN }))).files
      // As an older Virvi left it: the same edits, its own range
      const p = JSON.parse(strFromU8(installed.get('package.json')!))
      p.dependencies['@virvixr/dcl'] = old
      installed.set('package.json', strToU8(JSON.stringify(p, null, 2) + '\n'))
      const back = uninstallVirvi(installed)
      expect(JSON.parse(strFromU8(back.files.get('package.json')!)).dependencies, old).toEqual({ left: '1.0.0' })
    }
  })

  it('keeps a dependency the original already had, and reports the creator\'s own Virvi code', async () => {
    const own = "import { startVirviManager } from '@virvixr/dcl'\nexport class VirviManager { start() { startVirviManager() } }\n"
    const f = folder({ 'package.json': pkg({ '@virvixr/dcl': '^2.4.0' }), 'src/index.ts': MAIN, 'src/own.ts': own })
    const back = uninstallVirvi((await installVirvi(f)).files)
    expect(back.leftovers).toEqual(['src/own.ts'])
    expect(JSON.parse(strFromU8(back.files.get('package.json')!)).dependencies['@virvixr/dcl']).toBe('^2.14.0')
    expect(strFromU8(back.files.get('src/own.ts')!)).toBe(own)
  })

  it("reports the creator's own Virvi code it can't remove", async () => {
    const withOwn = "import { createVirvi } from '@virvixr/dcl'\nexport function main() {\n  void createVirvi()\n}\n"
    const installed = await installVirvi(folder({ 'package.json': pkg(), 'src/index.ts': withOwn }))
    expect(installed.alreadyInstalled).toBe(true)
    const back = uninstallVirvi(installed.files, { alreadyInstalled: true })
    expect(back.leftovers).toEqual(['src/index.ts'])
    expect(strFromU8(back.files.get('src/index.ts')!)).toBe(withOwn)
    expect(JSON.parse(strFromU8(back.files.get('package.json')!)).dependencies['@virvixr/dcl']).toBeTruthy()
  })

  it('removes the Creator Hub script, the sync manifest and unused models, keeps models something uses', async () => {
    const files = new Map<string, Uint8Array>([
      ['package.json', strToU8(pkg({ '@virvixr/dcl': '^2.6.0' }))],
      ['src/index.ts', strToU8("import { createVirvi } from '@virvixr/dcl'\nexport function main() {\n  void createVirvi()\n}\n")],
      ['assets/scene/Scripts/VirviManager.ts', strToU8("import { startVirviManager } from '@virvixr/dcl'\n")],
      ['assets/scene/main.composite', strToU8('{"src":"models/virvi/used.glb"}')],
      ['models/virvi/.virvi-sync.json', strToU8('{}')],
      ['models/virvi/used.glb', strToU8('a')],
      ['models/virvi/unused.glb', strToU8('b')],
      ['images/virvi/hud-v.png', strToU8('png')],
      ['models/mine.glb', strToU8('c')],
    ])
    const back = uninstallVirvi(files)
    expect([...back.files.keys()].sort()).toEqual(['assets/scene/main.composite', 'models/mine.glb', 'models/virvi/used.glb', 'package.json', 'src/index.ts'])
    expect(back.leftovers).toEqual([])
    expect(strFromU8(back.files.get('src/index.ts')!)).toBe('export function main() {}\n')
  })

  it('does not mutate its input', async () => {
    const installed = await installVirvi(folder({ 'package.json': pkg(), 'src/index.ts': MAIN }))
    const keys = [...installed.files.keys()]
    uninstallVirvi(installed.files)
    expect([...installed.files.keys()]).toEqual(keys)
  })
})

describe('sceneSourceFor', () => {
  let store: ReturnType<typeof memoryPrivateStore>
  beforeEach(async () => { await resetDb(); store = memoryPrivateStore(); setImportStore(store) })
  afterEach(() => setImportStore(null))

  const zip = (files: Map<string, Uint8Array>) => Buffer.from(zipSync(Object.fromEntries(files)))
  async function seed(sceneId: string, userId: string, o: { status?: 'deployed' | 'failed'; at: Date; original?: Buffer; source: Buffer }) {
    const [row] = await db.insert(sceneImports).values({ userId, sceneId, worldName: 'moon.dcl.eth', kind: 'sdk7', sourceKey: 'x', status: o.status ?? 'deployed', finishedAt: o.at, createdAt: o.at }).returning()
    const p = `imports/${row.id}/`
    await store.put(`${p}source.zip`, o.source, 'application/zip')
    const originalKey = o.original ? `${p}original.zip` : null
    if (o.original) await store.put(originalKey!, o.original, 'application/zip')
    await db.update(sceneImports).set({ sourceKey: `${p}source.zip`, originalKey }).where(eq(sceneImports.id, row.id))
    return row.id
  }

  it('reads the newest deployed import: its original, else its source un-installed, else none', async () => {
    const user = await createUser()
    const { scene } = await createScene(user, 'Moon')
    expect((await sceneSourceFor(scene.id, { userId: user.id, fullAccess: true })).origin).toBe('none')

    const f = folder({ 'package.json': pkg(), 'src/index.ts': MAIN })
    const installed = (await installVirvi(f)).files
    const d = (days: number) => new Date(Date.UTC(2026, 10, 1) - days * 86_400_000)
    await seed(scene.id, user.id, { at: d(5), source: zip(installed) })
    const uninstalled = await sceneSourceFor(scene.id, { userId: user.id, fullAccess: true })
    expect(uninstalled.origin).toBe('uninstalled')
    expect(strFromU8(uninstalled.files.get('src/index.ts')!)).toBe(MAIN)
    expect(uninstalled.files.has('images/virvi/hud-v.png')).toBe(false)

    const withOriginal = new Map(f.files).set('src/index.ts', strToU8('// the original\nexport function main() {}\n'))
    await seed(scene.id, user.id, { at: d(2), original: zip(withOriginal), source: zip(installed) })
    await seed(scene.id, user.id, { status: 'failed', at: d(0), source: zip(installed) })
    const kept = await sceneSourceFor(scene.id, { userId: user.id, fullAccess: true })
    expect(kept.origin).toBe('original')
    expect(strFromU8(kept.files.get('src/index.ts')!)).toBe('// the original\nexport function main() {}\n')
  })

  it("reports the creator's own Virvi code in an original, and falls back to the source when the original is unreadable", async () => {
    const user = await createUser()
    const { scene } = await createScene(user, 'Moon')
    const own = "import { createVirvi } from '@virvixr/dcl'\nexport function main() {\n  void createVirvi()\n}\n"
    const f = folder({ 'package.json': pkg({ '@virvixr/dcl': '^2.6.0' }), 'src/index.ts': own })
    const installed = (await installVirvi(f)).files
    const id = await seed(scene.id, user.id, { at: new Date(Date.UTC(2026, 10, 1)), original: zip(f.files), source: zip(installed) })
    const r = await sceneSourceFor(scene.id, { userId: user.id, fullAccess: true })
    expect([r.origin, r.leftovers]).toEqual(['original', ['src/index.ts']])

    await store.put(`imports/${id}/original.zip`, Buffer.from('not a zip'), 'application/zip')
    expect((await sceneSourceFor(scene.id, { userId: user.id, fullAccess: true })).origin).toBe('uninstalled')
  })

  it("withholds the creator's source from anyone but its importer and full-access members", async () => {
    const user = await createUser()
    const other = await createUser()
    const { scene } = await createScene(user, 'Moon')
    const f = folder({ 'package.json': pkg(), 'src/index.ts': MAIN })
    await seed(scene.id, user.id, { at: new Date(Date.UTC(2026, 10, 1)), original: zip(f.files), source: zip((await installVirvi(f)).files) })
    expect((await sceneSourceFor(scene.id, { userId: user.id, fullAccess: false })).origin).toBe('original')
    expect((await sceneSourceFor(scene.id, { userId: other.id, fullAccess: true })).origin).toBe('original')
    const withheld = await sceneSourceFor(scene.id, { userId: other.id, fullAccess: false })
    expect(withheld).toMatchObject({ origin: 'withheld', leftovers: [] })
    expect(withheld.files.size).toBe(0)
  })

  it("is 'expired' when an import's files are gone or unreadable, or the scene's imports never deployed", async () => {
    const user = await createUser()
    const caller = { userId: user.id, fullAccess: true }
    const { scene: never } = await createScene(user, 'Never')
    await seed(never.id, user.id, { status: 'failed', at: new Date(), source: Buffer.from('x') })
    expect((await sceneSourceFor(never.id, caller)).origin).toBe('expired')

    const { scene: gone } = await createScene(user, 'Gone')
    const id = await seed(gone.id, user.id, { at: new Date(), original: Buffer.from('not a zip'), source: Buffer.from('not a zip either') })
    expect((await sceneSourceFor(gone.id, caller)).origin).toBe('expired')
    await store.delete(`imports/${id}/source.zip`)
    await store.delete(`imports/${id}/original.zip`)
    expect((await sceneSourceFor(gone.id, caller)).origin).toBe('expired')
  })

  it('leaves the icon, script and sync manifest alone when the scene started Virvi itself', () => {
    const files = new Map<string, Uint8Array>([
      ['src/index.ts', strToU8(MAIN)], ['images/virvi/hud-v.png', strToU8('p')],
      ['assets/scene/Scripts/VirviManager.ts', strToU8('x')], ['models/virvi/.virvi-sync.json', strToU8('{}')],
    ])
    expect([...uninstallVirvi(files, { alreadyInstalled: true }).files.keys()].sort()).toEqual([...files.keys()].sort())
  })
})
