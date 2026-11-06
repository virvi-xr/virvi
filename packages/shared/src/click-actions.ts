/**
 * Click actions on placed items (LIV-126): what may be saved, and how an action reads in a few words. Used by the
 * server (it refuses a bad action) and the dashboard; the scene runtimes check again when they run one
 * (packages/core src/managers/click.ts). No URL class: the Decentraland runtime has none.
 */
import { ClickEventType } from './enums/index.js'
import type { ClickEvent, Vec3 } from './types/math.js'

export const HOVER_TEXT_MAX = 60
const URL_MAX = 2000
const HTTP = /^https?:\/\/([^\s/?#:]+)[^\s]*$/i
/** Decentraland parcel coordinates ("52,-20"), or its own "magic" and "crowd" destinations. */
const TELEPORT = /^(-?\d{1,3},-?\d{1,3}|magic|crowd)$/i

export type ClickCheck = { ok: true; value: ClickEvent | null } | { ok: false; error: string }

const fail = (error: string): ClickCheck => ({ ok: false, error })

const link = (v: unknown): string | null => {
  if (typeof v !== 'string') return null
  const t = v.trim()
  return t.length <= URL_MAX && HTTP.test(t) ? t : null
}

const vec = (v: unknown): Vec3 | null => {
  if (!v || typeof v !== 'object') return null
  const o = v as Record<string, unknown>
  const out = [o.x, o.y, o.z]
  return out.every((n) => typeof n === 'number' && Number.isFinite(n)) ? { x: out[0] as number, y: out[1] as number, z: out[2] as number } : null
}

/** A click action as sent, checked and tidied: null for none (null, or NONE). STREAM was never defined, so it is refused. */
export function checkClickEvent(raw: unknown): ClickCheck {
  if (raw === null) return { ok: true, value: null }
  if (!raw || typeof raw !== 'object') return fail('That click action is not available.')
  const r = raw as Record<string, unknown>
  if (r.type === ClickEventType.NONE) return { ok: true, value: null }
  const hoverText = r.hoverText === undefined || r.hoverText === null ? '' : r.hoverText
  if (typeof hoverText !== 'string') return fail('Hover text must be text.')
  if (hoverText.trim().length > HOVER_TEXT_MAX) return fail(`Hover text can be up to ${HOVER_TEXT_MAX} characters.`)
  const base = { ...(hoverText.trim() ? { hoverText: hoverText.trim() } : {}), showFeedback: r.showFeedback === true }
  switch (r.type) {
    case ClickEventType.EXTERNAL: {
      const externalLink = link(r.externalLink)
      if (!externalLink) return fail('A link must start with https:// or http://.')
      return { ok: true, value: { type: ClickEventType.EXTERNAL, externalLink, ...base } }
    }
    case ClickEventType.SOUND: {
      const sound = link(r.sound)
      if (!sound) return fail('Choose the sound to play.')
      return { ok: true, value: { type: ClickEventType.SOUND, sound, ...base } }
    }
    case ClickEventType.MOVE: {
      const m = r.moveTo && typeof r.moveTo === 'object' ? (r.moveTo as Record<string, unknown>) : {}
      const position = vec(m.position)
      if (!position) return fail('Moving needs a position: x, y and z in metres.')
      if (m.cameraTarget !== undefined && m.cameraTarget !== null && !vec(m.cameraTarget)) return fail('The camera target needs x, y and z in metres.')
      const cameraTarget = vec(m.cameraTarget)
      return { ok: true, value: { type: ClickEventType.MOVE, moveTo: { position, ...(cameraTarget ? { cameraTarget } : {}) }, ...base } }
    }
    case ClickEventType.TELEPORT: {
      const to = typeof r.teleportTo === 'string' ? r.teleportTo.replace(/\s+/g, '') : ''
      if (!TELEPORT.test(to)) return fail('Teleport to parcel coordinates like 52,-20.')
      return { ok: true, value: { type: ClickEventType.TELEPORT, teleportTo: to.toLowerCase(), ...base } }
    }
    default:
      return fail('That click action is not available.')
  }
}

const n = (v: number) => String(Math.round(v * 100) / 100)

/** "Opens tickets.example", "Plays a sound", "Moves the visitor to 8, 0, 8", "Teleports to 52,-20", or "Nothing". */
export function describeClick(c: Partial<ClickEvent> | null | undefined): string {
  switch (c?.type) {
    case ClickEventType.EXTERNAL: {
      const host = typeof c.externalLink === 'string' ? HTTP.exec(c.externalLink.trim())?.[1] : undefined
      return host ? `Opens ${host.replace(/^www\./i, '')}` : 'Opens a link'
    }
    case ClickEventType.SOUND:
      return 'Plays a sound'
    case ClickEventType.MOVE: {
      const p = c.moveTo?.position
      return p ? `Moves the visitor to ${n(p.x)}, ${n(p.y)}, ${n(p.z)}` : 'Moves the visitor'
    }
    case ClickEventType.TELEPORT:
      return c.teleportTo ? `Teleports to ${c.teleportTo}` : 'Teleports'
    default:
      return 'Nothing'
  }
}
