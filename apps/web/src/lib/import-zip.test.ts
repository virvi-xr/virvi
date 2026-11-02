import { describe, it, expect } from 'vitest'
import { unzipSync } from 'fflate'
import { scenePathMap, zipSceneFiles } from './import-zip'

const bytes = (s: string) => new TextEncoder().encode(s)
const file = (path: string, text = path) => ({ path, bytes: bytes(text) })
const names = (zip: Uint8Array) => Object.keys(unzipSync(zip)).sort()

describe('zipSceneFiles', () => {
  it('drops node_modules, bin and .git and keeps paths', () => {
    const zip = zipSceneFiles([
      file('my-scene/scene.json', '{"a":1}'),
      file('my-scene/package.json'),
      file('my-scene/src/index.ts'),
      file('my-scene/assets/models/tree.glb'),
      file('my-scene/node_modules/@dcl/sdk/index.js'),
      file('my-scene/bin/index.js'),
      file('my-scene/.git/HEAD'),
      file('my-scene/.DS_Store'),
    ])
    expect(names(zip)).toEqual(['assets/models/tree.glb', 'package.json', 'scene.json', 'src/index.ts'])
    expect(new TextDecoder().decode(unzipSync(zip)['scene.json'])).toBe('{"a":1}')
  })

  it('drops bin/ only at the scene root, the rest at any depth (Ruling R4)', () => {
    const zip = zipSceneFiles([
      file('my-scene/scene.json'),
      file('my-scene/assets/bin/x.png'),
      file('my-scene/assets/node_modules/y.js'),
      file('my-scene/src/.git/config'),
      file('my-scene/assets/__MACOSX/._tree.glb'),
      file('my-scene/assets/.DS_Store'),
    ])
    expect(names(zip)).toEqual(['assets/bin/x.png', 'scene.json'])
  })

  it('keeps paths as they are when scene.json is already at the top', () => {
    const zip = zipSceneFiles([file('scene.json'), file('src/index.ts'), file('bin/index.js')])
    expect(names(zip)).toEqual(['scene.json', 'src/index.ts'])
  })

  it('scenePathMap names what to read, without the dropped files', () => {
    const map = scenePathMap(['s/scene.json', 's/node_modules/a.js', 's/bin/index.js', 's/src/index.ts'])
    expect([...map.entries()]).toEqual([['s/scene.json', 'scene.json'], ['s/src/index.ts', 'src/index.ts']])
  })
})
