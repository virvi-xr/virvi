import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { bakeModule, HEIGHT_PER_WIDTH } from '../src/services/backup/bake-code.js'
import type { AssetPlan, BackupSnapshot, BakedItem } from '../src/services/backup/snapshot.js'

const CDN = 'https://cdn.virvi.test'

const bundle = (path: string, use: AssetPlan['use'] = 'texture'): AssetPlan => ({ kind: 'bundle', url: `${CDN}/${path}`, path, use })
const link = (url: string, use: AssetPlan['use'] = 'video'): AssetPlan => ({ kind: 'link', url, use })

function item(type: BakedItem['type'], o: Partial<BakedItem> = {}): BakedItem {
  return {
    type, name: `A ${type}`,
    position: { x: 1, y: 2, z: 3 }, rotation: { x: 0, y: 90, z: 0 }, scale: { x: 2, y: 1, z: 1 },
    withCollisions: false, props: {}, assets: {}, ...o,
  }
}

function snap(items: BakedItem[]): BackupSnapshot {
  return { sceneName: 'Cafe', presetName: 'Main', otherPresets: [], items, skipped: [], withClickEvents: [] }
}

/** The source of one item's block (the generator emits one `{ … }` block per item, in order). */
const bake = (...items: BakedItem[]) => bakeModule(snap(items))

describe('bakeModule', () => {
  it('exports bakeVirviContent and places a transform for each item', () => {
    const out = bake(item('model', { assets: { model: bundle('models/chair.glb', 'model') } }))
    expect(out).toContain('export function bakeVirviContent(): void {')
    expect(out).toContain('Transform.create(e, { position: Vector3.create(1, 2, 3), rotation: Quaternion.fromEulerDegrees(0, 90, 0), scale: Vector3.create(2, 1, 1) })')
    expect(out).toContain('Name.create(e, { value: "A model" })')
  })

  it('a model loads its bundled path, with mesh collisions only when asked (R2)', () => {
    const plain = bake(item('model', { assets: { model: bundle('models/chair.glb', 'model') } }))
    expect(plain).toContain('GltfContainer.create(e, { src: "models/chair.glb" })')
    expect(plain).not.toContain('MeshCollider')
    const solid = bake(item('model', { withCollisions: true, assets: { model: { kind: 'reference', url: `${CDN}/t.glb`, path: 'models/tree.glb', use: 'model', pack: 'P', license: 'cc-by-nc-3.0', sourceUrl: 'https://x' } } }))
    expect(solid).toContain('GltfContainer.create(e, { src: "models/tree.glb", visibleMeshesCollisionMask: ColliderLayer.CL_PHYSICS | ColliderLayer.CL_POINTER })')
    expect(solid).not.toContain('MeshCollider')
  })

  it('an image is a two-sided plane with the PBR material Virvi uses', () => {
    const out = bake(item('image', { withCollisions: true, props: { emission: 2, isTransparent: true }, assets: { texture: bundle('images/p.png') } }))
    expect(out).toContain('MeshRenderer.setPlane(e, [0, 0, 0, 1, 1, 1, 1, 0, 0, 0, 0, 1, 1, 1, 1, 0])')
    expect(out).toContain('Material.setPbrMaterial(e, { texture: Material.Texture.Common({ src: "images/p.png" }), emissiveTexture: Material.Texture.Common({ src: "images/p.png" }), emissiveIntensity: 2, emissiveColor: Color3.White(), roughness: 1, metallic: 0, specularIntensity: 0, transparencyMode: 2 })')
    expect(out).toContain('MeshCollider.setBox(e)')
  })

  it('an image defaults to no emission and opaque, and a linked texture uses its URL', () => {
    const out = bake(item('image', { assets: { texture: link('https://elsewhere.test/p.png', 'texture') } }))
    expect(out).toContain('src: "https://elsewhere.test/p.png"')
    expect(out).toContain('emissiveIntensity: 0,')
    expect(out).toContain('transparencyMode: 0 })')
    expect(out).not.toContain('MeshCollider')
  })

  it('an image without a texture is a plain plane', () => {
    const out = bake(item('image'))
    expect(out).toContain('MeshRenderer.setPlane(e,')
    expect(out).not.toContain('Material.')
  })

  it('a playlist plays from a separate player entity and advances on end', () => {
    const out = bake(item('video', {
      withCollisions: true,
      props: { offType: 2, volume: 40 },
      assets: { 'playlist.1': bundle('videos/b.mp4', 'video'), 'playlist.0': bundle('videos/a.mp4', 'video'), 'playlist.10': link('https://v.test/k.mp4') },
    }))
    expect(out).toContain('const player = engine.addEntity()')
    expect(out).toContain('VideoPlayer.create(player, { src: "videos/a.mp4", playing: true, volume: 0.4, loop: false })')
    expect(out).toContain('Material.Texture.Video({ videoPlayerEntity: player })')
    expect(out).toContain('playInOrder(player, ["videos/a.mp4", "videos/b.mp4", "https://v.test/k.mp4"])')
    expect(out.match(/engine\.addSystem\(/g)).toHaveLength(1)
    expect(out).toContain('videoEventsSystem.getVideoState(player)')
    expect(out).toContain('VideoState.VS_PAUSED')
    expect(out).toContain('MeshCollider.setBox(e)')
  })

  it('a playlist of one item loops without the advance system', () => {
    const out = bake(item('video', { props: { offType: 2 }, assets: { 'playlist.0': bundle('videos/a.mp4', 'video') } }))
    expect(out).toContain('VideoPlayer.create(player, { src: "videos/a.mp4", playing: true, volume: 1, loop: true })')
    expect(out).not.toContain('addSystem')
    expect(out).not.toContain('playInOrder')
    expect(out).not.toContain('videoEventsSystem')
  })

  it('a live screen plays its stream as a looping link (R4)', () => {
    const out = bake(item('video', {
      props: { isLive: true, enableLiveStream: true, offType: 2, volume: 100 },
      assets: { liveSrc: link('https://live.test/s.m3u8'), 'playlist.0': bundle('videos/a.mp4', 'video'), 'playlist.1': bundle('videos/b.mp4', 'video') },
    }))
    expect(out).toContain('VideoPlayer.create(player, { src: "https://live.test/s.m3u8", playing: true, volume: 1, loop: true })')
    expect(out).not.toContain('videos/a.mp4')
    expect(out).not.toContain('addSystem')
  })

  it('a screen not live falls back to its off mode', () => {
    const out = bake(item('video', {
      props: { isLive: false, enableLiveStream: true, offType: 1, emission: 1.5 },
      assets: { liveSrc: link('https://live.test/s.m3u8'), offImage: bundle('images/off.png') },
    }))
    expect(out).not.toContain('VideoPlayer')
    expect(out).not.toContain('s.m3u8')
    expect(out).toContain('texture: Material.Texture.Common({ src: "images/off.png" })')
    expect(out).toContain('emissiveIntensity: 1.5,')
  })

  it('a screen in ads mode bakes as its off image or a blank plane, never an ad (R4)', () => {
    const withImage = bake(item('video', { props: { offType: 4 }, assets: { offImage: bundle('images/off.png') } }))
    expect(withImage).toContain('src: "images/off.png"')
    expect(withImage).not.toContain('VideoPlayer')
    const blank = bake(item('video', { props: { offType: 4 } }))
    expect(blank).toContain('MeshRenderer.setPlane(e,')
    expect(blank).not.toContain('Material.')
    const playlistAds = bake(item('video', { props: { offType: 5 }, assets: { 'playlist.0': bundle('videos/a.mp4', 'video'), 'playlist.1': bundle('videos/b.mp4', 'video') } }))
    expect(playlistAds).toContain('playInOrder(player, ["videos/a.mp4", "videos/b.mp4"])')
    const emptyPlaylistAds = bake(item('video', { props: { offType: 5 }, assets: { offImage: bundle('images/off.png') } }))
    expect(emptyPlaylistAds).toContain('src: "images/off.png"')
    expect(emptyPlaylistAds).not.toContain('VideoPlayer')
  })

  it('a looping sound autoplays; a clip waits (R4)', () => {
    const loop = bake(item('sound', { props: { sourceType: 1, volume: 50 }, assets: { audio: bundle('sounds/rain.mp3', 'audio') } }))
    expect(loop).toContain('AudioSource.create(e, { audioClipUrl: "sounds/rain.mp3", playing: true, loop: true, volume: 0.5 })')
    const clip = bake(item('sound', { props: { sourceType: 0 }, assets: { audio: link('https://a.test/ding.mp3', 'audio') } }))
    expect(clip).toContain('AudioSource.create(e, { audioClipUrl: "https://a.test/ding.mp3", playing: false, loop: false, volume: 1 })')
  })

  it('a sound without a clip is left out', () => {
    const out = bake(item('sound', { props: { sourceType: 1 } }))
    expect(out).not.toContain('engine.addEntity')
    expect(out).not.toContain('AudioSource')
  })

  it('an ad space gets the shape\'s aspect and never an ad creative', () => {
    const tall = bake(item('ad_space', { scale: { x: 2, y: 7, z: 1 }, props: { shape: '9:16', formats: 'both' }, assets: { fallbackImage: bundle('images/house.png') } }))
    expect(tall).toContain(`scale: Vector3.create(2, ${2 * (16 / 9)}, 1)`)
    expect(tall).toContain('texture: Material.Texture.Common({ src: "images/house.png" })')
    expect(tall).not.toMatch(/ads?\.virvi|creative/i)
    const empty = bake(item('ad_space', { withCollisions: true, props: { shape: '2:5' } }))
    expect(empty).toContain('scale: Vector3.create(2, 5, 1)')
    expect(empty).toContain('albedoColor: Color4.create(0.1, 0.1, 0.1, 1)')
    expect(empty).not.toContain('Texture')
    expect(empty).toContain('MeshCollider.setBox(e)')
    for (const props of [{}, { shape: 'constructor' }]) {
      expect(bake(item('ad_space', { props }))).toContain(`scale: Vector3.create(2, ${2 * (9 / 16)}, 1)`)
    }
  })

  it('pins the ad shapes to the runtime\'s aspect table', () => {
    expect(HEIGHT_PER_WIDTH).toEqual({ '16:9': 9 / 16, '1:1': 1, '9:16': 16 / 9, '2:5': 5 / 2 })
  })

  it('strings are escaped', () => {
    const evil = `x'); engine.removeEntity(e); ("\n*/   \``
    const out = bake(item('image', { name: evil, assets: { texture: link(`https://x.test/a".png?q=');alert(1)//`, 'texture') } }))
    expect(out).toContain(`Name.create(e, { value: ${JSON.stringify(evil)} })`)
    expect(out).toContain(JSON.stringify(`https://x.test/a".png?q=');alert(1)//`))
    // No raw newline from the name leaks into the source.
    expect(out.split('\n').some((l) => l.startsWith('*/'))).toBe(false)
  })

  it('non-finite numbers become 0 rather than broken source', () => {
    const out = bake(item('model', { position: { x: Number.NaN, y: Infinity, z: 1 }, assets: { model: bundle('models/a.glb', 'model') } }))
    expect(out).toContain('position: Vector3.create(0, 0, 1)')
  })

  it('no Virvi imports in the output', () => {
    const out = bakeModule(fullSnapshot())
    const imports = out.split('\n').filter((l) => /^\s*import\b|require\(/.test(l))
    expect(imports.length).toBeGreaterThan(0)
    // Decentraland's own modules only: the SDK, and its ~system actions for click actions
    for (const l of imports) expect(l).toMatch(/from '(@dcl\/sdk\/(ecs|math)|~system\/(RestrictedActions|UserActionModule))'$/)
    expect(out).not.toMatch(/virvixr|createVirvi|@virvi/i)
  })

  it('is deterministic with two-space indent', () => {
    const a = bakeModule(fullSnapshot())
    expect(bakeModule(fullSnapshot())).toBe(a)
    for (const l of a.split('\n')) expect(l).toMatch(/^( {2})*\S|^$/)
    expect(a.endsWith('\n')).toBe(true)
  })

  it('an empty snapshot still exports bakeVirviContent', () => {
    const out = bakeModule(snap([]))
    expect(out).toContain('export function bakeVirviContent(): void {')
  })

  const here = dirname(fileURLToPath(import.meta.url))
  const dclModules = resolve(here, '../../../dcl-runtime/node_modules')
  const haveSdk = existsSync(join(dclModules, '@dcl/sdk/package.json'))
  if (!haveSdk) console.warn(`[backup-bake-code] compile check skipped: ${dclModules} is absent (run \`cd dcl-runtime && npm ci\`)`)

  it('bakes click actions with their hover text, importing the actions they use (LIV-126)', () => {
    const out = bake(
      item('image', { name: 'Tickets', click: { type: 1, externalLink: 'https://t.example/show', hoverText: 'Get tickets', showFeedback: true } }),
      item('model', { click: { type: 5, teleportTo: '52,-20', showFeedback: false }, assets: { model: bundle('models/door.glb', 'model') } }),
      item('image', { click: { type: 4, moveTo: { position: { x: 8, y: 0, z: 8 }, cameraTarget: { x: 1, y: 2, z: 3 } }, showFeedback: false } }),
      item('image', { click: { type: 2, sound: `${CDN}/sounds/ding.mp3`, showFeedback: false }, assets: { clickSound: bundle('sounds/ding.mp3', 'audio') } }),
    )
    expect(out).toContain('pointerEventsSystem.onPointerDown({ entity: e, opts: { button: InputAction.IA_POINTER, hoverText: "Get tickets", showFeedback: true } }, () => { void openExternalUrl({ url: "https://t.example/show" }) })')
    expect(out).toContain('void requestTeleport({ destination: "52,-20" })')
    expect(out).toContain('void movePlayerTo({ newRelativePosition: Vector3.create(8, 0, 8), cameraTarget: Vector3.create(1, 2, 3) })')
    expect(out).toContain('AudioSource.createOrReplace(e, { audioClipUrl: "sounds/ding.mp3", playing: true, loop: false, volume: 1 })')
    expect(out).toContain("import { openExternalUrl, movePlayerTo } from '~system/RestrictedActions'")
    expect(out).toContain("import { requestTeleport } from '~system/UserActionModule'")
    expect(out).toMatch(/import \{[^}]*pointerEventsSystem, InputAction[^}]*\} from '@dcl\/sdk\/ecs'/)
    // Nothing clickable: no pointer code, no action imports
    const plain = bake(item('image'))
    expect(plain).not.toContain('pointerEventsSystem')
    expect(plain).not.toContain('~system')
  })

  it.skipIf(!haveSdk)('the output compiles against @dcl/sdk', () => {
    const dir = mkdtempSync(join(tmpdir(), 'virvi-baked-'))
    try {
      mkdirSync(join(dir, 'src'))
      symlinkSync(dclModules, join(dir, 'node_modules'), 'dir')
      writeFileSync(join(dir, 'tsconfig.json'), JSON.stringify({
        compilerOptions: {
          allowJs: true, strict: true, skipLibCheck: true, lib: ['ESNext', 'DOM'], moduleResolution: 'node',
          esModuleInterop: true, noEmit: true, module: 'esnext', target: 'esnext',
        },
        include: ['src/**/*.ts'],
        extends: '@dcl/sdk/types/tsconfig.ecs7.json',
      }))
      writeFileSync(join(dir, 'src/index.ts'), "import { bakeVirviContent } from './virvi-baked'\n\nexport function main() {\n  bakeVirviContent()\n}\n")
      writeFileSync(join(dir, 'src/virvi-baked.ts'), bakeModule(fullSnapshot()))
      const localTsc = join(dclModules, 'typescript/bin/tsc')
      const tsc = existsSync(localTsc) ? localTsc : resolve(here, '../node_modules/typescript/bin/tsc')
      try {
        execFileSync(process.execPath, [tsc, '--noEmit', '-p', dir], { stdio: 'pipe', encoding: 'utf8' })
      } catch (err) {
        const e = err as { stdout?: string; stderr?: string }
        throw new Error(`tsc failed:\n${e.stdout ?? ''}${e.stderr ?? ''}`)
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 120_000)
})

/** One of everything, including the edge cases, for the import and compile checks. */
function fullSnapshot(): BackupSnapshot {
  return snap([
    item('model', { name: `it's "odd"`, assets: { model: bundle('models/a.glb', 'model') } }),
    item('model', { withCollisions: true, assets: { model: bundle('models/b.glb', 'model') } }),
    item('image', { withCollisions: true, props: { emission: 1, isTransparent: true }, assets: { texture: bundle('images/p.png') } }),
    item('image'),
    item('image', { click: { type: 1, externalLink: 'https://t.example', hoverText: 'Go', showFeedback: true } }),
    item('model', { click: { type: 5, teleportTo: '0,0', showFeedback: false }, assets: { model: bundle('models/c.glb', 'model') } }),
    item('image', { click: { type: 4, moveTo: { position: { x: 1, y: 0, z: 1 } }, showFeedback: false } }),
    item('image', { click: { type: 2, sound: 'https://s.test/ding.mp3', showFeedback: false } }),
    item('video', { props: { offType: 2, volume: 30 }, assets: { 'playlist.0': bundle('videos/a.mp4', 'video'), 'playlist.1': link('https://v.test/b.mp4') } }),
    item('video', { props: { offType: 2 }, assets: { 'playlist.0': bundle('videos/a.mp4', 'video') } }),
    item('video', { props: { isLive: true, enableLiveStream: true }, assets: { liveSrc: link('https://live.test/s.m3u8') } }),
    item('video', { withCollisions: true, props: { offType: 1 }, assets: { offImage: bundle('images/off.png') } }),
    item('video', { props: { offType: 4 } }),
    item('video', { props: { offType: 5 }, assets: { 'playlist.0': bundle('videos/c.mp4', 'video'), 'playlist.1': bundle('videos/d.mp4', 'video') } }),
    item('sound', { props: { sourceType: 1, volume: 20 }, assets: { audio: bundle('sounds/a.mp3', 'audio') } }),
    item('sound', { props: { sourceType: 0 }, assets: { audio: link('https://a.test/b.mp3', 'audio') } }),
    item('sound'),
    item('ad_space', { props: { shape: '1:1' }, assets: { fallbackImage: bundle('images/house.png') } }),
    item('ad_space', { withCollisions: true, props: { shape: '9:16' } }),
  ])
}
