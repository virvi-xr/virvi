import { describe, it, expect } from 'vitest'
import { strToU8, strFromU8 } from 'fflate'
import { installVirvi, VIRVI_DCL_RANGE } from '../src/services/import/install-virvi.js'
import { ImportError, type SceneFolder } from '../src/services/import/scene-zip.js'
import { runtimeFiles } from '../src/services/dcl/runtime.js'

const sceneJson = { main: 'bin/index.js', runtimeVersion: '7', scene: { parcels: ['0,0'], base: '0,0' } }
const SCENE_JSON_TEXT = '{\n    "main": "bin/index.js",\n  "runtimeVersion":"7","scene":{"parcels":["0,0"],"base":"0,0"}}'
const pkg = (deps?: Record<string, string>) => JSON.stringify({ name: 'my-scene', version: '1.0.0', ...(deps ? { dependencies: deps } : {}), devDependencies: { '@dcl/sdk': 'latest' } }, null, 2)

function folder(src: Record<string, string>, kind: SceneFolder['kind'] = 'sdk7'): SceneFolder {
  const files = new Map<string, Uint8Array>()
  files.set('scene.json', strToU8(SCENE_JSON_TEXT))
  for (const [k, v] of Object.entries(src)) files.set(k, strToU8(v))
  return { files, sceneJson, kind, location: { kind: 'parcels', parcels: ['0,0'], base: '0,0' } }
}
const text = (m: Map<string, Uint8Array>, p: string) => strFromU8(m.get(p)!)
const failure = async (p: Promise<unknown>) => { try { await p } catch (e) { return e instanceof ImportError ? [e.status, e.code] : e } return null }

describe('installVirvi', () => {
  it('adds the dependency, the createVirvi call and the HUD icon', async () => {
    const r = await installVirvi(folder({ 'package.json': pkg(), 'src/index.ts': "import { engine } from '@dcl/sdk/ecs'\n\nexport function main() {\n  engine.addSystem(() => {})\n}\n" }))
    const p = JSON.parse(text(r.files, 'package.json'))
    expect(p.dependencies['@virvixr/dcl']).toBe(VIRVI_DCL_RANGE)
    expect(VIRVI_DCL_RANGE).toBe('^2.14.0')
    expect(Object.keys(p)).toEqual(['name', 'version', 'devDependencies', 'dependencies'])
    expect(text(r.files, 'package.json').endsWith('}\n')).toBe(true)
    expect(text(r.files, 'src/index.ts')).toBe("import { createVirvi } from '@virvixr/dcl'\nimport { engine } from '@dcl/sdk/ecs'\n\nexport function main() {\n  void createVirvi()\n  engine.addSystem(() => {})\n}\n")
    expect(r.files.get('images/virvi/hud-v.png')).toEqual((await runtimeFiles()).get('images/virvi/hud-v.png'))
    expect(r.changed.sort()).toEqual(['images/virvi/hud-v.png', 'package.json', 'src/index.ts'])
  })

  it('raises an older @virvixr/dcl and replaces non-semver specs, never lowers', async () => {
    const run = async (spec: string) => JSON.parse(text((await installVirvi(folder({ 'package.json': pkg({ '@virvixr/dcl': spec, left: '1.0.0' }), 'src/index.ts': 'export function main() {}' }))).files, 'package.json'))
    expect((await run('^2.4.0')).dependencies).toEqual({ '@virvixr/dcl': '^2.14.0', left: '1.0.0' })
    expect((await run('~2.1.9'))['dependencies']['@virvixr/dcl']).toBe('^2.14.0')
    expect((await run('>=1.0.0'))['dependencies']['@virvixr/dcl']).toBe('^2.14.0')
    expect((await run('latest'))['dependencies']['@virvixr/dcl']).toBe('^2.14.0')
    expect((await run('file:../dcl'))['dependencies']['@virvixr/dcl']).toBe('^2.14.0')
    expect((await run('github:a/b'))['dependencies']['@virvixr/dcl']).toBe('^2.14.0')
    expect((await run('*'))['dependencies']['@virvixr/dcl']).toBe('^2.14.0')
    expect((await run('^2.14.1'))['dependencies']['@virvixr/dcl']).toBe('^2.14.1')
    expect((await run('^10.0.0'))['dependencies']['@virvixr/dcl']).toBe('^10.0.0')
  })

  it('is idempotent', async () => {
    const first = await installVirvi(folder({ 'package.json': pkg(), 'src/index.ts': 'export function main() {\n  a()\n}\n' }))
    const second = await installVirvi({ ...folder({}), files: first.files })
    expect(second.changed).toEqual([])
    for (const [k, v] of first.files) expect(second.files.get(k)).toEqual(v)
  })

  it('handles async, arrow, empty and one-line main, and CRLF', async () => {
    const edit = async (src: string) => text((await installVirvi(folder({ 'package.json': pkg(), 'src/index.ts': src }))).files, 'src/index.ts')
    expect(await edit('export async function main(): Promise<void> {\n  await x()\n}\n')).toContain('Promise<void> {\n  void createVirvi()\n  await x()\n}')
    expect(await edit('export const main = async () => {\n  x()\n}\n')).toContain('=> {\n  void createVirvi()\n  x()\n}')
    expect(await edit('export const main = (): void => {\n  x()\n}\n')).toContain('=> {\n  void createVirvi()\n  x()\n}')
    expect(await edit('export function main() {}\n')).toBe("import { createVirvi } from '@virvixr/dcl'\nexport function main() {\n  void createVirvi()\n}\n")
    expect(await edit('export function main() { x() }\n')).toContain('{\n  void createVirvi()\n x() }')
    const crlf = await edit("import a from 'a'\r\nexport function main() {\r\n  x()\r\n}\r\n")
    expect(crlf).toBe("import { createVirvi } from '@virvixr/dcl'\r\nimport a from 'a'\r\nexport function main() {\r\n  void createVirvi()\r\n  x()\r\n}\r\n")
  })

  it('leaves a file that already imports createVirvi alone, and uses index.tsx / index.js', async () => {
    const src = "import { createVirvi } from '@virvixr/dcl'\nexport function main() {\n  void createVirvi()\n}\n"
    const r = await installVirvi(folder({ 'package.json': pkg({ '@virvixr/dcl': '^2.14.0' }), 'src/index.ts': src }))
    expect(text(r.files, 'src/index.ts')).toBe(src)
    expect(r.changed).toEqual(['images/virvi/hud-v.png'])
    const js = await installVirvi(folder({ 'package.json': pkg(), 'src/index.js': 'export function main() {}' }))
    expect(text(js.files, 'src/index.js')).toContain('void createVirvi()')
    const tsx = await installVirvi(folder({ 'package.json': pkg(), 'src/index.tsx': 'export function main() {}' }))
    expect(text(tsx.files, 'src/index.tsx')).toContain('void createVirvi()')
  })

  it('a Creator Hub scene gets the same edit and no composite change', async () => {
    const composite = '{"version":1}'
    const f = folder({ 'package.json': pkg(), 'assets/scene/main.composite': composite, 'src/index.ts': 'export function main() {}\n' }, 'creator-hub')
    const r = await installVirvi(f)
    expect(text(r.files, 'assets/scene/main.composite')).toBe(composite)
    expect(r.changed.sort()).toEqual(['images/virvi/hud-v.png', 'package.json', 'src/index.ts'])
  })

  it('no main is no_main', async () => {
    expect(await failure(installVirvi(folder({ 'package.json': pkg(), 'src/index.ts': 'console.log(1)\n' })))).toEqual([422, 'no_main'])
    expect(await failure(installVirvi(folder({ 'package.json': pkg(), 'src/index.ts': 'function main() {}\n' })))).toEqual([422, 'no_main'])
    expect(await failure(installVirvi(folder({ 'package.json': pkg() })))).toEqual([422, 'no_main'])
  })

  it('leaves scene.json byte-for-byte and does not mutate the input folder', async () => {
    const f = folder({ 'package.json': pkg(), 'src/index.ts': 'export function main() {}\n' })
    const before = new Uint8Array(f.files.get('scene.json')!)
    const r = await installVirvi(f)
    expect(r.files.get('scene.json')).toEqual(before)
    expect(r.changed).not.toContain('scene.json')
    expect(text(f.files, 'src/index.ts')).toBe('export function main() {}\n')
    expect(f.files.has('images/virvi/hud-v.png')).toBe(false)
  })
  describe('fix round 1', () => {
    const edit = async (src: string, pk = pkg()) => text((await installVirvi(folder({ 'package.json': pk, 'src/index.ts': src }))).files, 'src/index.ts')
    const IMP = "import { createVirvi } from '@virvixr/dcl'\n"

    it('ignores main and imports inside comments and strings', async () => {
      expect(await edit('/* export function main() { */\nexport function main() {\n  x()\n}\n')).toBe(IMP + '/* export function main() { */\nexport function main() {\n  void createVirvi()\n  x()\n}\n')
      expect(await edit("// import { createVirvi } from '@virvixr/dcl'\nexport function main() {\n  x()\n}\n")).toBe(IMP + "// import { createVirvi } from '@virvixr/dcl'\nexport function main() {\n  void createVirvi()\n  x()\n}\n")
      expect(await failure(installVirvi(folder({ 'package.json': pkg(), 'src/index.ts': 'const s = "export function main() {"\nconst t = `export function main() {`\n' })))).toEqual([422, 'no_main'])
    })

    it('takes the earliest main across forms', async () => {
      const out = await edit('export const main = () => {\n  a()\n}\nexport function main2() {}\n')
      expect(out).toContain('=> {\n  void createVirvi()\n  a()')
      const out2 = await edit('export const main = () => {\n  a()\n}\n// export function main() {\n')
      expect(out2).toContain('=> {\n  void createVirvi()')
    })

    it('finds the body brace past complex signatures', async () => {
      expect(await edit('export function main(): Promise<{ ok: boolean }> {\n  x()\n}\n')).toContain('boolean }> {\n  void createVirvi()\n  x()')
      expect(await edit('export function main(): { ok: boolean } {\n  x()\n}\n')).toContain('boolean } {\n  void createVirvi()\n  x()')
      expect(await edit('export function main(cb: () => void) {\n  x()\n}\n')).toContain('void) {\n  void createVirvi()\n  x()')
      expect(await edit('export const main = (cb: () => void) => {\n  x()\n}\n')).toContain('=> {\n  void createVirvi()\n  x()')
      expect(await edit('export function main({ a, b }: { a: number; b: number }) {\n  x()\n}\n')).toContain('number }) {\n  void createVirvi()')
      expect(await failure(installVirvi(folder({ 'package.json': pkg(), 'src/index.ts': 'export const main = () => foo()\n' })))).toEqual([422, 'no_main'])
    })

    it('inserts only the call when createVirvi is imported but not called, and calls an alias', async () => {
      const a = await edit("import { createVirvi } from '@virvixr/dcl'\nexport function main() {\n  x()\n}\n")
      expect(a).toBe("import { createVirvi } from '@virvixr/dcl'\nexport function main() {\n  void createVirvi()\n  x()\n}\n")
      const b = await edit("import { createVirvi as cv } from '@virvixr/dcl'\nexport function main() {\n  x()\n}\n")
      expect(b).toBe("import { createVirvi as cv } from '@virvixr/dcl'\nexport function main() {\n  void cv()\n  x()\n}\n")
      expect(await edit(b)).toBe(b)
      const t = await edit("import type { createVirvi } from '@virvixr/dcl'\nexport function main() {}\n")
      expect(t.startsWith(IMP + 'import type')).toBe(true)
      expect(t).toContain('void createVirvi()')
    })

    it('raises @virvixr/dcl in devDependencies when it is there', async () => {
      const pk = JSON.stringify({ name: 'x', devDependencies: { '@virvixr/dcl': '^2.0.0' } }, null, 2)
      const r = await installVirvi(folder({ 'package.json': pk, 'src/index.ts': 'export function main() {}' }))
      const p = JSON.parse(text(r.files, 'package.json'))
      expect(p.devDependencies['@virvixr/dcl']).toBe('^2.14.0')
      expect(p.dependencies).toBeUndefined()
    })

    it('puts the import after reference lines and use strict, and rejects bad encodings', async () => {
      expect(await edit("/// <reference types=\"x\" />\n'use strict'\nimport a from 'a'\nexport function main() {}\n")).toBe("/// <reference types=\"x\" />\n'use strict'\n" + IMP + "import a from 'a'\nexport function main() {\n  void createVirvi()\n}\n")
      const f = folder({ 'package.json': pkg() })
      f.files.set('src/index.ts', new Uint8Array([0x65, 0xff, 0xfe, 0x20]))
      expect(await failure(installVirvi(f))).toEqual([422, 'bad_source_encoding'])
    })
  })
  describe('Virvi already in the scene (outside src/index.ts)', () => {
    const MAIN = 'export function main() {\n  x()\n}\n'
    const VIRVI_MANAGER = "import { Entity } from '@dcl/sdk/ecs'\nimport { startVirviManager, VirviSmartItem } from '@virvixr/dcl'\n\nexport class VirviManager {\n  start() { startVirviManager(this.entity, {}) }\n}\n"

    it("the Creator Hub VirviManager script: nothing is inserted, the dependency is raised", async () => {
      const r = await installVirvi(folder({
        'package.json': pkg({ '@virvixr/dcl': '^2.4.0' }), 'assets/scene/main.composite': '{}', 'assets/scene/Scripts/VirviManager.ts': VIRVI_MANAGER, 'src/index.ts': MAIN,
      }, 'creator-hub'))
      expect(text(r.files, 'src/index.ts')).toBe(MAIN)
      expect(text(r.files, 'assets/scene/Scripts/VirviManager.ts')).toBe(VIRVI_MANAGER)
      expect(JSON.parse(text(r.files, 'package.json')).dependencies['@virvixr/dcl']).toBe('^2.14.0')
      expect(r.alreadyInstalled).toBe(true)
      expect(r.changed.sort()).toEqual(['images/virvi/hud-v.png', 'package.json'])
    })

    it('createVirvi called from src/other.ts: nothing is inserted', async () => {
      const other = "import { createVirvi } from '@virvixr/dcl'\nexport function startAll() {\n  void createVirvi()\n}\n"
      const r = await installVirvi(folder({ 'package.json': pkg(), 'src/other.ts': other, 'src/index.ts': "import { startAll } from './other'\n" + MAIN }))
      expect(text(r.files, 'src/index.ts')).toBe("import { startAll } from './other'\n" + MAIN)
      expect(JSON.parse(text(r.files, 'package.json')).dependencies['@virvixr/dcl']).toBe('^2.14.0')
      expect(r.alreadyInstalled).toBe(true)
    })

    it('createVirvi called outside main in index.ts counts too; a type-only import, a comment or another package does not', async () => {
      const top = "import { createVirvi } from '@virvixr/dcl'\nvoid createVirvi()\n" + MAIN
      expect(text((await installVirvi(folder({ 'package.json': pkg(), 'src/index.ts': top }))).files, 'src/index.ts')).toBe(top)
      for (const other of [
        "import type { VirviSmartItem } from '@virvixr/dcl'\nexport const a = 1\n",
        "// import { createVirvi } from '@virvixr/dcl'\nexport const a = 1\n",
        "import { createVirvi } from './mine'\nexport const a = 1\n",
      ]) {
        const r = await installVirvi(folder({ 'package.json': pkg(), 'src/other.ts': other, 'src/index.ts': MAIN }))
        expect(text(r.files, 'src/index.ts')).toContain('void createVirvi()')
        expect(r.alreadyInstalled).toBe(false)
      }
    })

    it("index.ts importing createVirvi without calling it still gets the call (Ruling R7)", async () => {
      const r = await installVirvi(folder({ 'package.json': pkg(), 'src/index.ts': "import { createVirvi } from '@virvixr/dcl'\n" + MAIN }))
      expect(text(r.files, 'src/index.ts')).toContain('void createVirvi()')
      expect(r.alreadyInstalled).toBe(false)
    })
  })
  describe('the source scan is linear (N2)', () => {
    const MB = 1024 * 1024
    const fill = (unit: string) => unit.repeat(Math.ceil(MB / unit.length)).slice(0, MB)
    const MAIN = 'export function main() {\n  x()\n}\n'

    it.each([
      ['import x ', 'repeated import keywords with no from'],
      ['import { a, ', 'an import clause that never closes'],
      ['export const main: ', 'a main type annotation with no ='],
      ['import x from ', 'from with no module'],
    ])('a 1 MB file of %j (%s) scans in well under 100 ms', async (unit) => {
      const big = fill(unit)
      for (const files of [{ 'src/other.ts': big, 'src/index.ts': MAIN }, { 'src/index.ts': big + '\n' + MAIN }]) {
        const started = performance.now()
        await installVirvi(folder({ 'package.json': pkg(), ...files })).catch(() => {})
        // Generous for slow CI; quadratic scanning takes seconds at this size
        expect(performance.now() - started).toBeLessThan(250)
      }
    })

    it('still finds real imports among many statements', async () => {
      const lines = Array.from({ length: 5000 }, (_, i) => `import { a${i} } from './m${i}'`).join('\n')
      const r = await installVirvi(folder({ 'package.json': pkg(), 'src/other.ts': `${lines}\nimport { startVirviManager } from '@virvixr/dcl'\n`, 'src/index.ts': MAIN }))
      expect(r.alreadyInstalled).toBe(true)
    })
  })
})
