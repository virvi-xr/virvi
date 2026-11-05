import type { SerializedScene, SerializedSceneElement, Vec3 } from '@virvixr/shared'
import { toHyperfyTransform } from './transform.js'

export type RenderItem = {
  /** `${elementId}:${instanceId}` */
  key: string
  kind: 'video' | 'image' | 'model' | 'audio'
  /** The element's name ('' when it has none). */
  name: string
  /** For video, image and model, the URL to show. */
  src: string
  loop: boolean
  /**
   * Playlist mode only (else empty): the videos to play in turn, starting with `src`, back to the first after the last.
   * With one video, `loop` repeats it instead.
   */
  playlist: string[]
  volume: number
  width: number
  height: number
  transform: ReturnType<typeof toHyperfyTransform>
  /** The same transform in Virvi coordinates (Decentraland frame, degrees), as edit mode drafts and saves it. */
  virvi: { position: Vec3; rotation: Vec3; scale: Vec3 }
  clickUrl: string | null
  /**
   * Schedule mode (LIV-87): the screen plays its showings by the shared clock (app.ts), showing `holdingImage` ('' for
   * none) between them. `src` is then the holding image.
   */
  schedule?: { holdingImage: string }
}

const VIDEO_EXT = ['mp4', 'm3u8']
const IMAGE_EXT = ['png', 'jpg', 'jpeg', 'webp']
const CLICK_NONE = 0
const CLICK_EXTERNAL = 1
const OFF_IMAGE = 1
const OFF_PLAYLIST = 2
const OFF_SCHEDULED = 6

type Props = Record<string, unknown>

/** Extension of the URL's path, lowercased; '' when there is none. No `URL`: Hyperfy scripts don't have it. */
function extOf(src: string): string {
  const path = src.split(/[?#]/)[0]
  const m = /\.([a-z0-9]+)$/i.exec(path)
  return m ? m[1].toLowerCase() : ''
}

function supported(src: unknown, exts: string[]): src is string {
  return typeof src === 'string' && src !== '' && exts.includes(extOf(src))
}

const num = (v: unknown, fallback: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback)

function vec(v: unknown, fallback: number): Vec3 {
  const o = (v && typeof v === 'object' ? v : {}) as Props
  return { x: num(o.x, fallback), y: num(o.y, fallback), z: num(o.z, fallback) }
}

function externalUrl(click: unknown): string | null {
  if (!click || typeof click !== 'object') return null
  const c = click as Props
  return c.type === CLICK_EXTERNAL && typeof c.externalLink === 'string' && c.externalLink ? c.externalLink : null
}

/** An instance's click applies only when it has a type other than NONE; otherwise the element's does. */
function clickOf(inst: Props, el: Props): unknown {
  const own = inst.clickEvent as Props | undefined
  const set = own && typeof own === 'object' && typeof own.type === 'number' && own.type !== CLICK_NONE
  return set ? own : el.clickEvent
}

type Media = { kind: RenderItem['kind']; src: string; loop: boolean; playlist?: string[]; schedule?: { holdingImage: string } } | null

function videoMedia(el: Props): Media {
  if (el.isLive && el.enableLiveStream && typeof el.liveSrc === 'string' && el.liveSrc) {
    return supported(el.liveSrc, VIDEO_EXT) ? { kind: 'video', src: el.liveSrc, loop: true } : null
  }
  if (el.offType === OFF_PLAYLIST) {
    const playlist = (Array.isArray(el.playlist) ? el.playlist : []).filter((src): src is string => supported(src, VIDEO_EXT))
    return playlist.length ? { kind: 'video', src: playlist[0], loop: playlist.length === 1, playlist } : null
  }
  if (el.offType === OFF_SCHEDULED) {
    const holdingImage = supported(el.offImageSrc, IMAGE_EXT) ? el.offImageSrc : ''
    return { kind: 'video', src: holdingImage, loop: false, schedule: { holdingImage } }
  }
  if (el.offType === OFF_IMAGE) {
    return supported(el.offImageSrc, IMAGE_EXT) ? { kind: 'image', src: el.offImageSrc, loop: false } : null
  }
  return null
}

function elementMedia(kind: 'video' | 'image' | 'model' | 'audio', el: Props): Media {
  switch (kind) {
    case 'video':
      return videoMedia(el)
    case 'image':
      return supported(el.textureSrc, IMAGE_EXT) ? { kind, src: el.textureSrc, loop: false } : null
    case 'model':
      return typeof el.modelSrc === 'string' && el.modelSrc ? { kind, src: el.modelSrc, loop: false } : null
    case 'audio':
      return typeof el.audioSrc === 'string' && el.audioSrc ? { kind, src: el.audioSrc, loop: true } : null
  }
}

function planElements(
  out: RenderItem[],
  elements: SerializedSceneElement[] | undefined,
  kind: 'video' | 'image' | 'model' | 'audio',
): void {
  for (const el of elements ?? []) {
    if (el.enabled === false) continue
    const media = elementMedia(kind, el)
    if (!media) continue
    const volume = kind === 'video' || kind === 'audio' ? num(el.volume, 1) : 0
    for (const raw of el.instances ?? []) {
      const inst = raw as Props
      if (inst.enabled === false) continue
      const scale = vec(inst.scale, 1)
      const virvi = { position: vec(inst.position, 0), rotation: vec(inst.rotation, 0), scale }
      out.push({
        key: `${el.sk}:${inst.sk}`,
        kind: media.kind,
        name: typeof el.name === 'string' ? el.name : '',
        src: media.src,
        loop: media.loop,
        playlist: media.playlist ?? [],
        volume: media.kind === 'image' ? 0 : volume,
        width: scale.x,
        height: scale.y,
        transform: toHyperfyTransform(virvi),
        virvi,
        clickUrl: externalUrl(clickOf(inst, el)),
        ...(media.schedule ? { schedule: media.schedule } : {}),
      })
    }
  }
}

/** The nodes a world should show for a scene snapshot. */
export function planScene(scene: SerializedScene | null): RenderItem[] {
  const out: RenderItem[] = []
  if (!scene) return out
  planElements(out, scene.videos, 'video')
  planElements(out, scene.images, 'image')
  planElements(out, scene.models, 'model')
  planElements(out, scene.sounds, 'audio')
  return out
}

export function diffPlans(
  prev: RenderItem[],
  next: RenderItem[],
): { add: RenderItem[]; remove: string[]; update: RenderItem[] } {
  const before = new Map(prev.map((i) => [i.key, JSON.stringify(i)]))
  const nextKeys = new Set(next.map((i) => i.key))
  const add: RenderItem[] = []
  const update: RenderItem[] = []
  for (const item of next) {
    const old = before.get(item.key)
    if (old === undefined) add.push(item)
    else if (old !== JSON.stringify(item)) update.push(item)
  }
  const remove = prev.filter((i) => !nextKeys.has(i.key)).map((i) => i.key)
  return { add, remove, update }
}
