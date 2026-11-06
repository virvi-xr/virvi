import type { EntityHandle, Vec3, VirviPlatformAdapter } from '@virvixr/shared'

/**
 * Click actions on placed items (LIV-126), as old VLM's ClickEvent.service ran them: open a link (Decentraland asks
 * first), play a sound, move the player, or teleport. An instance's own action wins unless its type is NONE.
 * STREAM was never defined, so it does nothing.
 */
const NONE = 0
const EXTERNAL = 1
const SOUND = 2
const MOVE = 4
const TELEPORT = 5

type Click = Record<string, unknown> & { type?: unknown }

const asClick = (v: unknown): Click | null => (v && typeof v === 'object' ? (v as Click) : null)
const typeOf = (c: Click | null): number => (typeof c?.type === 'number' ? c.type : NONE)

/** The action that applies to a copy: its own, unless that's NONE (or missing), then the item's. */
export function effectiveClick(own: unknown, element: unknown): Click | null {
  const o = asClick(own)
  if (o && typeOf(o) !== NONE) return o
  const e = asClick(element)
  return e && typeOf(e) !== NONE ? e : null
}

/** An http(s) address, trimmed; anything else (javascript:, a bare name) is no action. No URL class in the scene runtime. */
const httpUrl = (v: unknown): string | null => {
  if (typeof v !== 'string') return null
  const t = v.trim()
  return /^https?:\/\/[^\s/?#]+[^\s]*$/i.test(t) ? t : null
}

const vec = (v: unknown): Vec3 | null => {
  const o = v && typeof v === 'object' ? (v as Record<string, unknown>) : null
  if (!o) return null
  const [x, y, z] = [o.x, o.y, o.z].map(Number)
  return [x, y, z].every(Number.isFinite) ? { x, y, z } : null
}

/** What clicking does, or null when the action is NONE, undefined, or missing what it needs. */
export function clickRun(click: Click | null, adapter: VirviPlatformAdapter, entity: EntityHandle): (() => void) | null {
  switch (typeOf(click)) {
    case EXTERNAL: {
      const url = httpUrl(click!.externalLink)
      return url ? () => adapter.openUrl(url) : null
    }
    case SOUND: {
      const src = httpUrl(click!.sound)
      return src ? () => adapter.setAudioSource(entity, { src, playing: true, loop: false, volume: 1 }) : null
    }
    case MOVE: {
      const m = click!.moveTo && typeof click!.moveTo === 'object' ? (click!.moveTo as Record<string, unknown>) : null
      const position = vec(m?.position)
      if (!position) return null
      const target = vec(m?.cameraTarget) ?? undefined
      return () => adapter.movePlayer(position, target)
    }
    case TELEPORT: {
      const to = typeof click!.teleportTo === 'string' ? click!.teleportTo.trim() : ''
      return to ? () => adapter.teleportPlayer(to) : null
    }
    default:
      return null
  }
}

/** Puts the copy's click on its entity (with the configured hover text), or takes any old one off. */
export function bindClick(adapter: VirviPlatformAdapter, entity: EntityHandle, own: unknown, element: unknown): void {
  const click = effectiveClick(own, element)
  const run = clickRun(click, adapter, entity)
  adapter.removePointerEvents?.(entity)
  if (!run) return
  const hoverText = typeof click!.hoverText === 'string' ? click!.hoverText : ''
  adapter.onPointerDown(entity, { hoverText, showFeedback: click!.showFeedback === true }, () => run())
}
