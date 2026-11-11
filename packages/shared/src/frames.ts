/**
 * Frames around images and video screens (LIV-129): what may be saved, and what a runtime draws.
 *
 * Stored in the element's properties as `frame` (so it reaches runtimes flattened, like `textureSrc`), it applies to
 * every copy of the item. Off by default: an item without `frame`, or with `enabled: false`, looks exactly as before.
 * A frame switched off keeps its style, colour and thickness, so switching it back on brings them back.
 * Thickness is a share of the picture's shorter side, in percent, so a frame keeps its look when the item is resized.
 * Used by the server (it refuses a bad frame), the dashboard and the in-world HUD; runtimes read it with `frameOf`,
 * which never throws and never refuses. `frameParts` is the geometry: packages/core src/managers/frame.ts draws it in
 * the runtimes and the server's backup bakes it into plain Decentraland code (one copy, so both look the same).
 */
import type { Vec3 } from './types/math.js'

export type FrameStyle = 'thin' | 'classic' | 'gallery'

export interface FrameSettings {
  enabled: boolean
  style: FrameStyle
  /** '#rrggbb', lower case. */
  color: string
  /** Bar width as a percent of the picture's shorter side. */
  thickness: number
}

export const FRAME_STYLES: readonly FrameStyle[] = ['thin', 'classic', 'gallery']

export const FRAME_STYLE_LABELS: Record<FrameStyle, string> = { thin: 'Thin', classic: 'Classic', gallery: 'Gallery' }

/** One line on what each style looks like, for pickers. */
export const FRAME_STYLE_HINTS: Record<FrameStyle, string> = {
  thin: 'One slim modern border',
  classic: 'A deeper, raised border',
  gallery: 'A white mat with a slim frame around it',
}

export const FRAME_THICKNESS = { min: 1, max: 20, step: 1 } as const

export const FRAME_DEFAULTS: Record<FrameStyle, { color: string; thickness: number }> = {
  thin: { color: '#1c1c1c', thickness: 2 },
  classic: { color: '#6b4a2b', thickness: 6 },
  gallery: { color: '#1c1c1c', thickness: 2 },
}

/** Colours offered as one-tap swatches (the dashboard also takes any colour). */
export const FRAME_SWATCHES: readonly { label: string; color: string }[] = [
  { label: 'Black', color: '#1c1c1c' },
  { label: 'White', color: '#f2f2f2' },
  { label: 'Wood', color: '#6b4a2b' },
  { label: 'Oak', color: '#b08850' },
  { label: 'Gold', color: '#c9a227' },
  { label: 'Silver', color: '#a8a9ad' },
]

/** The mat in the Gallery style: always this colour, this wide (percent of the shorter side). */
export const FRAME_MAT = { color: '#f4f1ea', width: 12 } as const

export type FrameCheck = { ok: true; value: FrameSettings | null } | { ok: false; error: string }

const HEX = /^#[0-9a-f]{6}$/i

const isStyle = (v: unknown): v is FrameStyle => typeof v === 'string' && (FRAME_STYLES as readonly string[]).includes(v)

const fail = (error: string): FrameCheck => ({ ok: false, error })

/** A frame as sent, checked and tidied; null removes it. */
export function checkFrame(raw: unknown): FrameCheck {
  if (raw === null) return { ok: true, value: null }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fail('That frame is not available.')
  const r = raw as Record<string, unknown>
  if (typeof r.enabled !== 'boolean') return fail('A frame is on or off.')
  if (!isStyle(r.style)) return fail('Choose a frame style: Thin, Classic or Gallery.')
  const d = FRAME_DEFAULTS[r.style]
  if (r.color !== undefined && (typeof r.color !== 'string' || !HEX.test(r.color))) return fail('The frame colour must be a hex colour like #1c1c1c.')
  const thickness = r.thickness === undefined ? d.thickness : r.thickness
  if (typeof thickness !== 'number' || !Number.isFinite(thickness) || thickness < FRAME_THICKNESS.min || thickness > FRAME_THICKNESS.max) {
    return fail(`Frame thickness goes from ${FRAME_THICKNESS.min} to ${FRAME_THICKNESS.max}.`)
  }
  const color = typeof r.color === 'string' ? r.color.toLowerCase() : d.color
  return { ok: true, value: { enabled: r.enabled, style: r.style, color, thickness } }
}

/**
 * A stored frame as runtimes read it, switched on or off; null when it isn't a frame at all (no object, unknown style).
 * Lenient: a bad colour falls back to the style's, a thickness is held in range. Editors show this, so they show what
 * is drawn even for a frame stored outside the rules.
 */
export function readFrame(raw: unknown): FrameSettings | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  if (!isStyle(r.style)) return null
  const d = FRAME_DEFAULTS[r.style]
  const color = typeof r.color === 'string' && HEX.test(r.color) ? r.color.toLowerCase() : d.color
  const t = typeof r.thickness === 'number' && Number.isFinite(r.thickness) ? r.thickness : d.thickness
  return { enabled: r.enabled === true, style: r.style, color, thickness: Math.min(FRAME_THICKNESS.max, Math.max(FRAME_THICKNESS.min, t)) }
}

/** The frame to draw, or null for none (also for one switched off). */
export function frameOf(raw: unknown): FrameSettings | null {
  const f = readFrame(raw)
  return f?.enabled ? f : null
}

/** A new frame: Thin, with its defaults, switched on. */
export function defaultFrame(style: FrameStyle = 'thin'): FrameSettings {
  return { enabled: true, style, ...FRAME_DEFAULTS[style] }
}

/** Another style: its default colour and thickness come along, unless the frame's were changed from the old style's. */
export function withFrameStyle(frame: FrameSettings, style: FrameStyle): FrameSettings {
  const old = FRAME_DEFAULTS[frame.style]
  const next = FRAME_DEFAULTS[style]
  return {
    ...frame,
    style,
    color: frame.color === old.color ? next.color : frame.color,
    thickness: frame.thickness === old.thickness ? next.thickness : frame.thickness,
  }
}

/** '#rrggbb' as 0-1 channels (black for anything else). */
export function frameColorRgb(hex: string): { r: number; g: number; b: number } {
  if (!HEX.test(hex)) return { r: 0, g: 0, b: 0 }
  const n = parseInt(hex.slice(1), 16)
  return { r: ((n >> 16) & 255) / 255, g: ((n >> 8) & 255) / 255, b: (n & 255) / 255 }
}

/** The element types that may have a frame (ad spaces stay unframed). */
export const FRAMEABLE_TYPES: ReadonlySet<string> = new Set(['image', 'video'])

/** Entities one framed copy adds in Decentraland: 4 bars, and 4 mat strips for Gallery; 0 with no frame drawn. */
export function frameEntityCount(raw: unknown): number {
  const f = frameOf(raw)
  return !f ? 0 : f.style === 'gallery' ? 8 : 4
}

/** Entities every framed copy of these items adds (enabled images and video screens, their enabled copies). */
export function frameEntitiesIn(elements: Array<{ type: string; enabled?: boolean; properties: unknown; copies: number }>): number {
  let n = 0
  for (const el of elements) {
    if (el.enabled === false || !FRAMEABLE_TYPES.has(el.type)) continue
    const props = el.properties && typeof el.properties === 'object' ? (el.properties as Record<string, unknown>) : {}
    n += frameEntityCount(props.frame) * el.copies
  }
  return n
}

export type FramePartRole = 'top' | 'bottom' | 'left' | 'right' | 'mat'

export interface FramePart {
  role: FramePartRole
  shape: 'box' | 'plane'
  color: string
  /** In the picture's own space (metres, unrotated, centred on the picture). */
  position: Vec3
  scale: Vec3
}

/**
 * Bar depth as a multiple of the bar width, and the most it may be (metres). Bars are centred on the picture plane:
 * pictures show on both sides, so a frame must read the same from either. The cap keeps a thick frame from reaching
 * far behind the picture (through a wall it hangs on): never more than 2 cm either side.
 */
const DEPTH: Record<FrameStyle, { k: number; max: number }> = {
  thin: { k: 1, max: 0.02 },
  classic: { k: 2, max: 0.04 }, // deeper, raised
  gallery: { k: 1.2, max: 0.03 },
}

/**
 * The parts of a frame around a picture of this scale, in the picture's own space; none for a zero-size picture.
 * A frame is four boxes around the picture's edges (Gallery adds a mat of four plane strips between them and the
 * picture). The picture is the item's 1×1 plane scaled by its instance scale, so the frame is sized from
 * |scale.x| × |scale.y|. Nothing overlaps the picture: the bars are outside its edges and Gallery's mat is four strips
 * in the band between the picture and the bars, in the picture's plane (so it covers neither side and nothing z-fights).
 */
export function frameParts(frame: FrameSettings, scale: Vec3): FramePart[] {
  const w = Math.abs(scale.x)
  const h = Math.abs(scale.y)
  if (!(w > 0) || !(h > 0)) return []
  const short = Math.min(w, h)
  const t = (frame.thickness / 100) * short
  const mat = frame.style === 'gallery' ? (FRAME_MAT.width / 100) * short : 0
  const { k, max } = DEPTH[frame.style]
  const depth = Math.min(k * t, max)
  // The opening the bars go around: the picture, or the picture and its mat
  const ix = w / 2 + mat
  const iy = h / 2 + mat
  const box = (role: FramePartRole, x: number, y: number, sx: number, sy: number): FramePart => ({
    role, shape: 'box', color: frame.color, position: { x, y, z: 0 }, scale: { x: sx, y: sy, z: depth },
  })
  const parts = [
    box('top', 0, iy + t / 2, 2 * (ix + t), t),
    box('bottom', 0, -(iy + t / 2), 2 * (ix + t), t),
    box('left', -(ix + t / 2), 0, t, 2 * iy),
    box('right', ix + t / 2, 0, t, 2 * iy),
  ]
  if (mat > 0) {
    const strip = (x: number, y: number, sx: number, sy: number): FramePart => ({
      role: 'mat', shape: 'plane', color: FRAME_MAT.color, position: { x, y, z: 0 }, scale: { x: sx, y: sy, z: 1 },
    })
    parts.push(
      strip(0, h / 2 + mat / 2, 2 * ix, mat), // top and bottom span the band's full width
      strip(0, -(h / 2 + mat / 2), 2 * ix, mat),
      strip(-(w / 2 + mat / 2), 0, mat, h), // the sides fill between them
      strip(w / 2 + mat / 2, 0, mat, h),
    )
  }
  return parts
}
