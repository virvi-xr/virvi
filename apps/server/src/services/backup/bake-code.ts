/**
 * Turns a backup snapshot into `src/virvi-baked.ts`: plain SDK7 code (only `@dcl/sdk/ecs` and `@dcl/sdk/math`)
 * that recreates what Virvi's Decentraland runtime shows today (packages/adapter-dcl/src/DclAdapter.ts and the
 * managers in packages/core/src/managers), with the rulings R1–R4 of Scene Import Plan 3.
 * Every string is written with JSON.stringify so names and URLs cannot break out of their literals.
 */
import { FRAMEABLE_TYPES, frameOf, frameParts } from '@virvixr/shared'
import type { AssetPlan, BackupSnapshot, BakedItem } from './snapshot.js'

/**
 * Plane height over width for each ad shape. Duplicated from packages/core/src/managers/AdSpaceManager.ts
 * (apps/server does not depend on @virvixr/core); the test pins the values.
 */
export const HEIGHT_PER_WIDTH: Record<string, number> = { '16:9': 9 / 16, '1:1': 1, '9:16': 16 / 9, '2:5': 5 / 2 }

/** Virvi's video modes when the screen isn't live (VideoSourceType in packages/shared). */
const OFF = { NONE: 0, IMAGE: 1, PLAYLIST: 2, ADS: 4, PLAYLIST_ADS: 5 } as const

/** Both sides of the plane show the texture the right way round (DclAdapter.setPlaneRenderer). */
const PLANE_UVS = '[0, 0, 0, 1, 1, 1, 1, 0, 0, 0, 0, 1, 1, 1, 1, 0]'

/** Default emission of video screens and of images shown by a slot (the adapter's `?? 0.6`). */
const SCREEN_EMISSION = 0.6

const str = (s: string): string => JSON.stringify(s)
const num = (v: unknown): string => {
  const n = Number(v)
  return Number.isFinite(n) ? String(n) : '0'
}
/** A setting stored as a number, or the given default when absent or not a number. */
const numOr = (v: unknown, d: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : d)

/** Where the scene loads a file from: its local path when bundled or referenced, else its URL. */
const srcOf = (p: AssetPlan): string => (p.kind === 'link' ? p.url : p.path)

function imageMaterial(src: string, emission: number, transparent: boolean): string {
  const tex = `Material.Texture.Common({ src: ${str(src)} })`
  return `Material.setPbrMaterial(e, { texture: ${tex}, emissiveTexture: ${tex}, emissiveIntensity: ${num(emission)}, emissiveColor: Color3.White(), roughness: 1, metallic: 0, specularIntensity: 0, transparencyMode: ${transparent ? 2 : 0} })`
}

/** A two-sided plane with the given material lines, and a box collider when the item has collisions. */
const plane = (it: BakedItem, material: string[] = []): string[] => [
  `MeshRenderer.setPlane(e, ${PLANE_UVS})`,
  ...material,
  ...(it.withCollisions ? ['MeshCollider.setBox(e)'] : []),
]

/** The playlist's sources in order (`playlist.<n>` keys; empty entries never got a key). */
function playlist(it: BakedItem): string[] {
  return Object.keys(it.assets)
    .filter((k) => /^playlist\.\d+$/.test(k))
    .sort((a, b) => Number(a.slice(9)) - Number(b.slice(9)))
    .map((k) => srcOf(it.assets[k]))
}

interface Baked {
  lines: string[]
  /** The item needs the shared playlist helper. */
  playlistHelper?: boolean
}

function videoPlayer(src: string, volume: number, loop: boolean): string[] {
  return [
    'const player = engine.addEntity()',
    `VideoPlayer.create(player, { src: ${str(src)}, playing: true, volume: ${num(volume)}, loop: ${loop} })`,
    'const video = Material.Texture.Video({ videoPlayerEntity: player })',
    `Material.setPbrMaterial(e, { texture: video, emissiveTexture: video, emissiveIntensity: ${SCREEN_EMISSION}, emissiveColor: Color3.White(), roughness: 1, metallic: 0, specularIntensity: 0 })`,
  ]
}

function bakeVideo(it: BakedItem): Baked {
  const p = it.props
  const volume = numOr(p.volume, 100) / 100
  // R4: a screen live at download time keeps its stream URL (always a link).
  if (p.isLive && p.enableLiveStream && it.assets.liveSrc) {
    return { lines: plane(it, videoPlayer(srcOf(it.assets.liveSrc), volume, true)) }
  }
  const offType = numOr(p.offType, OFF.NONE)
  const list = playlist(it)
  const offImage = () =>
    it.assets.offImage ? [imageMaterial(srcOf(it.assets.offImage), numOr(p.emission, SCREEN_EMISSION), false)] : []
  // Playlists play without ads (R4), so a single item always loops.
  if ((offType === OFF.PLAYLIST || offType === OFF.PLAYLIST_ADS) && list.length > 0) {
    const player = videoPlayer(list[0], volume, list.length === 1)
    if (list.length === 1) return { lines: plane(it, player) }
    return { lines: plane(it, [...player, `playInOrder(player, [${list.map(str).join(', ')}])`]), playlistHelper: true }
  }
  // R4: ads modes show the off image or a blank plane, never an ad.
  if (offType === OFF.IMAGE || offType === OFF.ADS || offType === OFF.PLAYLIST_ADS) return { lines: plane(it, offImage()) }
  return { lines: plane(it) }
}

function bakeItem(it: BakedItem): Baked | null {
  switch (it.type) {
    case 'model': {
      const model = it.assets.model
      if (!model) return null
      const mask = it.withCollisions ? ', visibleMeshesCollisionMask: ColliderLayer.CL_PHYSICS | ColliderLayer.CL_POINTER' : ''
      return { lines: [`GltfContainer.create(e, { src: ${str(srcOf(model))}${mask} })`] }
    }
    case 'image': {
      const tex = it.assets.texture
      const material = tex ? [imageMaterial(srcOf(tex), numOr(it.props.emission, 0), !!it.props.isTransparent)] : []
      return { lines: plane(it, material) }
    }
    case 'video':
      return bakeVideo(it)
    case 'sound': {
      const audio = it.assets.audio
      if (!audio) return null
      const loop = it.props.sourceType === 1 // clips wait for a trigger, as today (R4)
      const volume = numOr(it.props.volume, 100) / 100
      return { lines: [`AudioSource.create(e, { audioClipUrl: ${str(srcOf(audio))}, playing: ${loop}, loop: ${loop}, volume: ${num(volume)} })`] }
    }
    case 'ad_space': {
      // An empty slot: the space's own fallback image, or a plain dark plane.
      const fallback = it.assets.fallbackImage
      const material = fallback
        ? imageMaterial(srcOf(fallback), SCREEN_EMISSION, false)
        : 'Material.setPbrMaterial(e, { albedoColor: Color4.create(0.1, 0.1, 0.1, 1), roughness: 1, metallic: 0, specularIntensity: 0 })'
      return { lines: plane(it, [material]) }
    }
    default:
      return null
  }
}

const vec3 = (v: { x: number; y: number; z: number }) => `Vector3.create(${num(v.x)}, ${num(v.y)}, ${num(v.z)})`

/** The item's click action (LIV-126), as Virvi's runtime runs it (packages/core src/managers/click.ts). */
function clickLines(it: BakedItem): string[] {
  const c = it.click
  if (!c) return []
  let run: string
  switch (c.type) {
    case 1:
      run = `openExternalUrl({ url: ${str(c.externalLink ?? '')} })`
      break
    case 2: {
      const sound = it.assets.clickSound ? srcOf(it.assets.clickSound) : c.sound ?? ''
      run = `AudioSource.createOrReplace(e, { audioClipUrl: ${str(sound)}, playing: true, loop: false, volume: 1 })`
      break
    }
    case 4: {
      const m = c.moveTo!
      run = `movePlayerTo({ newRelativePosition: ${vec3(m.position)}${m.cameraTarget ? `, cameraTarget: ${vec3(m.cameraTarget)}` : ''} })`
      break
    }
    case 5:
      run = `requestTeleport({ destination: ${str(c.teleportTo ?? '')} })`
      break
    default:
      return []
  }
  const opts = `{ button: InputAction.IA_POINTER, hoverText: ${str(c.hoverText ?? '')}, showFeedback: ${c.showFeedback === true} }`
  return [`pointerEventsSystem.onPointerDown({ entity: e, opts: ${opts} }, () => { void ${run} })`]
}

function scaleOf(it: BakedItem) {
  if (it.type !== 'ad_space') return it.scale
  const shape = typeof it.props.shape === 'string' && Object.hasOwn(HEIGHT_PER_WIDTH, it.props.shape) ? it.props.shape : '16:9'
  return { ...it.scale, y: Number(it.scale.x) * HEIGHT_PER_WIDTH[shape] }
}

/**
 * The item's frame (LIV-129) as the runtime draws it (packages/core src/managers/frame.ts, with the geometry it shares
 * from @virvixr/shared): one call per bar or mat strip. Only images and video screens have one; a frame switched off,
 * or not a frame, draws nothing, and one stored outside the rules is read as the runtime reads it.
 */
function frameLines(it: BakedItem): string[] {
  if (!FRAMEABLE_TYPES.has(it.type)) return []
  const frame = frameOf(it.props.frame)
  if (!frame) return []
  return frameParts(frame, scaleOf(it)).map((p) =>
    `addFramePart(e, { shape: ${str(p.shape)}, x: ${num(p.position.x)}, y: ${num(p.position.y)}, width: ${num(p.scale.x)}, height: ${num(p.scale.y)}, depth: ${num(p.scale.z)}, color: ${str(p.color)} })`)
}

/** Draws one frame part as DclAdapter.setSolidShape does, placed like framePartTransforms in packages/core. */
const FRAME_HELPER = [
  "// One part of a picture's frame: a solid box (a bar) or plane (a Gallery mat strip), centred on the picture's plane",
  "// at (x, y) metres from its middle in the picture's own space and turned with it. Sizes are metres, not scaled with",
  '// the picture: the frame is placed from where the picture is when this runs, so move or resize the picture first.',
  "function addFramePart(picture: Entity, part: { shape: 'box' | 'plane'; x: number; y: number; width: number; height: number; depth: number; color: string }): void {",
  '  const at = Transform.get(picture)',
  '  const f = engine.addEntity()',
  '  Transform.create(f, { position: Vector3.add(at.position, Vector3.rotate(Vector3.create(part.x, part.y, 0), at.rotation)), rotation: at.rotation, scale: Vector3.create(part.width, part.height, part.depth) })',
  "  if (part.shape === 'box') MeshRenderer.setBox(f)",
  '  else MeshRenderer.setPlane(f)',
  '  Material.setPbrMaterial(f, { albedoColor: Color4.fromColor3(Color3.fromHexString(part.color), 1), roughness: 0.7, metallic: 0, specularIntensity: 0.2 })',
  '}',
]

/** Advances a playlist when a video stops at its end, as DclAdapter.onVideoEnded does. */
const PLAYLIST_HELPER = [
  '/** Plays `list` in order on `player`, moving on whenever a video stops at its end. */',
  'function playInOrder(player: Entity, list: string[]): void {',
  '  let index = 0',
  '  let ended = false',
  '  engine.addSystem(() => {',
  '    if (!VideoEvent.has(player)) return',
  '    const ev = videoEventsSystem.getVideoState(player)',
  '    if (!ev) return',
  '    const atEnd = ev.state === VideoState.VS_PAUSED && ev.videoLength > 0 && ev.currentOffset >= ev.videoLength - 0.5',
  '    if (!atEnd) {',
  '      ended = false',
  '      return',
  '    }',
  '    if (ended) return',
  '    ended = true',
  '    index = (index + 1) % list.length',
  '    const vp = VideoPlayer.getMutable(player)',
  '    vp.src = list[index]',
  '    vp.playing = true',
  '  })',
  '}',
]

export function bakeModule(snap: BackupSnapshot): string {
  const blocks: string[][] = []
  let needsHelper = false
  let needsFrames = false
  for (const it of snap.items) {
    const baked = bakeItem(it)
    if (!baked) continue
    needsHelper ||= !!baked.playlistHelper
    const { position: p, rotation: r } = it
    const s = scaleOf(it)
    const frame = frameLines(it)
    needsFrames ||= frame.length > 0
    blocks.push([
      '{',
      ...[
        'const e = engine.addEntity()',
        `Name.create(e, { value: ${str(it.name)} })`,
        `Transform.create(e, { position: Vector3.create(${num(p.x)}, ${num(p.y)}, ${num(p.z)}), rotation: Quaternion.fromEulerDegrees(${num(r.x)}, ${num(r.y)}, ${num(r.z)}), scale: Vector3.create(${num(s.x)}, ${num(s.y)}, ${num(s.z)}) })`,
        ...baked.lines,
        ...clickLines(it),
        ...frame,
      ].map((l) => `  ${l}`),
      '}',
    ])
  }

  const body = [
    ...(needsHelper ? [...PLAYLIST_HELPER, ''] : []),
    ...(needsFrames ? [...FRAME_HELPER, ''] : []),
    '/** Places every item; call it once from main(). */',
    'export function bakeVirviContent(): void {',
    ...blocks.flat().map((l) => `  ${l}`),
    '}',
  ].join('\n')
  // Import only what the body uses (names and URLs sit inside string literals, so strip those first).
  const code = body.replace(/"(?:[^"\\]|\\.)*"/g, '""')
  const used = (names: string[]) => names.filter((n) => new RegExp(`\\b${n}\\b`).test(code))
  const ecs = used(['engine', 'Entity', 'Transform', 'Name', 'GltfContainer', 'ColliderLayer', 'MeshRenderer', 'MeshCollider', 'Material', 'VideoPlayer', 'VideoEvent', 'videoEventsSystem', 'VideoState', 'AudioSource', 'pointerEventsSystem', 'InputAction'])
  const math = used(['Vector3', 'Quaternion', 'Color3', 'Color4'])
  const restricted = used(['openExternalUrl', 'movePlayerTo'])
  const userActions = used(['requestTeleport'])
  return [
    "// Generated from the scene's live content: plain Decentraland SDK7 code, safe to edit.",
    ...(ecs.length ? [`import { ${ecs.join(', ')} } from '@dcl/sdk/ecs'`] : []),
    ...(math.length ? [`import { ${math.join(', ')} } from '@dcl/sdk/math'`] : []),
    ...(restricted.length ? [`import { ${restricted.join(', ')} } from '~system/RestrictedActions'`] : []),
    ...(userActions.length ? [`import { ${userActions.join(', ')} } from '~system/UserActionModule'`] : []),
    '',
    body,
    '',
  ].join('\n')
}
