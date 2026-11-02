import { describe, it, expect } from 'vitest'
import { zipSync, strToU8 } from 'fflate'
import { readSceneZip, ImportError } from '../src/services/import/scene-zip.js'

const enc = (o: unknown) => strToU8(JSON.stringify(o))
const world = { main: 'bin/index.js', runtimeVersion: '7', scene: { parcels: ['0,0', '0,1'], base: '0,0' }, worldConfiguration: { name: 'My.DCL.eth' } }
const parcels = { main: 'bin/index.js', ecs7: true, scene: { parcels: ['10,20'], base: '10,20' } }
const zip = (files: Record<string, Uint8Array>) => zipSync(files)
const code = (fn: () => unknown) => { try { fn() } catch (e) { return e instanceof ImportError ? [e.status, e.code] : e } return null }

describe('readSceneZip', () => {
  it('reads a Creator Hub scene', () => {
    const s = readSceneZip(zip({ 'scene.json': enc(world), 'assets/scene/main.composite': strToU8('{}'), 'src/index.ts': strToU8('x') }))
    expect(s.kind).toBe('creator-hub')
    expect(s.location).toEqual({ kind: 'world', world: 'my.dcl.eth', parcels: ['0,0', '0,1'], base: '0,0' })
    expect([...s.files.keys()].sort()).toEqual(['assets/scene/main.composite', 'scene.json', 'src/index.ts'])
    expect(s.sceneJson.main).toBe('bin/index.js')
  })
  it('reads an SDK7 code scene', () => {
    const s = readSceneZip(zip({ 'scene.json': enc(world), 'src/index.ts': strToU8('x') }))
    expect(s.kind).toBe('sdk7')
  })
  it('strips a single top-level folder', () => {
    const s = readSceneZip(zip({ 'my-scene/scene.json': enc(world), 'my-scene/src/index.ts': strToU8('x') }))
    expect([...s.files.keys()].sort()).toEqual(['scene.json', 'src/index.ts'])
  })
  it('drops node_modules, bin, .git and __MACOSX', () => {
    const s = readSceneZip(zip({
      'scene.json': enc(world), 'src/index.ts': strToU8('x'), '.DS_Store': strToU8('x'),
      'node_modules/a/index.js': strToU8('x'), 'bin/index.js': strToU8('x'), '.git/HEAD': strToU8('x'), '__MACOSX/._scene.json': strToU8('x'),
    }))
    expect([...s.files.keys()].sort()).toEqual(['scene.json', 'src/index.ts'])
  })
  it('refuses paths that escape the scene', () => {
    expect(code(() => readSceneZip(zip({ 'scene.json': enc(world), '../x': strToU8('x') })))).toEqual([422, 'unsafe_path'])
    expect(code(() => readSceneZip(zip({ 'scene.json': enc(world), '/etc/passwd': strToU8('x') })))).toEqual([422, 'unsafe_path'])
    expect(code(() => readSceneZip(zip({ 'scene.json': enc(world), 'a/../../x': strToU8('x') })))).toEqual([422, 'unsafe_path'])
    expect(code(() => readSceneZip(zip({ 'scene.json': enc(world), 'C:/x': strToU8('x') })))).toEqual([422, 'unsafe_path'])
    expect(code(() => readSceneZip(zip({ 'scene.json': enc(world), '..\\x': strToU8('x') })))).toEqual([422, 'unsafe_path'])
  })
  it('refuses a zip without scene.json', () => {
    expect(code(() => readSceneZip(zip({ 'src/index.ts': strToU8('x') })))).toEqual([422, 'no_scene_json'])
  })
  it('refuses a zip with bad JSON', () => {
    expect(code(() => readSceneZip(zip({ 'scene.json': strToU8('{nope') })))).toEqual([422, 'bad_scene_json'])
  })
  it("refuses a zip that isn't SDK7", () => {
    expect(code(() => readSceneZip(zip({ 'scene.json': enc({ ...world, runtimeVersion: undefined }) })))).toEqual([422, 'not_sdk7'])
    expect(code(() => readSceneZip(zip({ 'scene.json': enc({ ...world, main: undefined }) })))).toEqual([422, 'not_sdk7'])
  })
  it("refuses something that isn't a zip", () => {
    expect(code(() => readSceneZip(strToU8('hello, not a zip')))).toEqual([400, 'not_a_zip'])
  })
  it('refuses a world name that is not .eth', () => {
    const j = { ...world, worldConfiguration: { name: 'plain' } }
    expect(code(() => readSceneZip(zip({ 'scene.json': enc(j) })))).toEqual([422, 'bad_world_name'])
  })
  it('refuses a world name that only becomes ASCII when lower-cased (the Kelvin sign folds to k)', () => {
    const j = { ...world, worldConfiguration: { name: 'Kiosk.dcl.eth' } }
    expect(code(() => readSceneZip(zip({ 'scene.json': enc(j) })))).toEqual([422, 'bad_world_name'])
  })
  it('a parcels scene reads as kind parcels', () => {
    const s = readSceneZip(zip({ 'scene.json': enc(parcels) }))
    expect(s.location).toEqual({ kind: 'parcels', parcels: ['10,20'], base: '10,20' })
  })
  it('refuses too many files', () => {
    const files: Record<string, Uint8Array> = { 'scene.json': enc(world) }
    for (let i = 0; i < 2000; i++) files[`f/${i}.txt`] = new Uint8Array(0)
    expect(code(() => readSceneZip(zip(files)))).toEqual([413, 'too_many_files'])
  })
  it('refuses a zip bomb before expanding it', () => {
    const patched = (sizes: number[]) => {
      const files: Record<string, Uint8Array> = { 'scene.json': enc(world) }
      sizes.forEach((_, n) => { files[`f${n}.bin`] = strToU8('tiny') })
      const z = zip(files)
      const dv = new DataView(z.buffer, z.byteOffset, z.byteLength)
      let k = 0
      for (let o = 0; o + 46 <= z.length; o++) {
        if (dv.getUint32(o, true) !== 0x02014b50) continue
        const nameLen = dv.getUint16(o + 28, true)
        const name = new TextDecoder().decode(z.subarray(o + 46, o + 46 + nameLen))
        const m = /^f(\d+)\.bin$/.exec(name)
        if (m) { dv.setUint32(o + 24, sizes[Number(m[1])]!, true); k++ }
      }
      expect(k).toBe(sizes.length)
      return z
    }
    expect(code(() => readSceneZip(patched([301 * 1024 * 1024])))).toEqual([413, 'too_big'])
    expect(code(() => readSceneZip(patched([160 * 1024 * 1024, 160 * 1024 * 1024])))).toEqual([413, 'too_big'])
  })
  it('keeps src/bin but drops bin at the scene root', () => {
    const s = readSceneZip(zip({ 'scene.json': enc(world), 'src/bin/x.ts': strToU8('x'), 'bin/index.js': strToU8('x') }))
    expect([...s.files.keys()].sort()).toEqual(['scene.json', 'src/bin/x.ts'])
  })
  it('drops bin inside a wrapper folder', () => {
    const s = readSceneZip(zip({ 'top/scene.json': enc(world), 'top/bin/index.js': strToU8('x'), 'top/src/a.ts': strToU8('x') }))
    expect([...s.files.keys()].sort()).toEqual(['scene.json', 'src/a.ts'])
  })
  it('still strips a wrapper folder in a macOS zip with root __MACOSX', () => {
    const s = readSceneZip(zip({ 'top/scene.json': enc(world), 'top/src/a.ts': strToU8('x'), '__MACOSX/top/._scene.json': strToU8('x'), 'top/.DS_Store': strToU8('x') }))
    expect([...s.files.keys()].sort()).toEqual(['scene.json', 'src/a.ts'])
  })
  it('refuses odd world names', () => {
    for (const name of ['.eth', 'a/b.eth', 'x y.eth', '../x.eth', 'a..eth']) {
      expect(code(() => readSceneZip(zip({ 'scene.json': enc({ ...world, worldConfiguration: { name } }) })))).toEqual([422, 'bad_world_name'])
    }
  })
  it('refuses two entries that normalise to the same path', () => {
    expect(code(() => readSceneZip(zip({ 'scene.json': enc(world), 'a//b': strToU8('1'), 'a/b': strToU8('2') })))).toEqual([422, 'unsafe_path'])
    expect(code(() => readSceneZip(zip({ 'scene.json': enc(world), './x': strToU8('1'), x: strToU8('2') })))).toEqual([422, 'unsafe_path'])
  })
  it('refuses NUL and backslash-dotdot names', () => {
    expect(code(() => readSceneZip(zip({ 'scene.json': enc(world), 'a\0b': strToU8('x') })))).toEqual([422, 'unsafe_path'])
    expect(code(() => readSceneZip(zip({ 'scene.json': enc(world), 'a\\..\\b': strToU8('x') })))).toEqual([422, 'unsafe_path'])
  })
  it('keeps ./scene.json as scene.json', () => {
    const s = readSceneZip(zip({ './scene.json': enc(world) }))
    expect([...s.files.keys()]).toEqual(['scene.json'])
  })
  it('prefers a root scene.json and does not strip', () => {
    const s = readSceneZip(zip({ 'scene.json': enc(world), 'sub/scene.json': enc(parcels), 'sub/a.ts': strToU8('x') }))
    expect(s.location.kind).toBe('world')
    expect([...s.files.keys()].sort()).toEqual(['scene.json', 'sub/a.ts', 'sub/scene.json'])
  })
  it('accepts exactly 2000 files', () => {
    const files: Record<string, Uint8Array> = { 'scene.json': enc(world) }
    for (let i = 0; i < 1999; i++) files[`f/${i}.txt`] = new Uint8Array(0)
    expect(readSceneZip(zip(files)).files.size).toBe(2000)
  })
})
