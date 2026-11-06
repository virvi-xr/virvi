/**
 * Setting an item's click action from the HUD's Layout panel (LIV-126 story 3), as the dashboard does: open a link,
 * play a sound, move the visitor or teleport, with hover text. Pure (no @dcl/sdk), so it is unit-tested; checked with
 * the shared checkClickEvent the server uses.
 */
import { checkClickEvent, describeClick, type ClickCheck, type ClickEvent } from '@virvixr/shared'

export type ClickKind = 'none' | 'link' | 'sound' | 'move' | 'teleport'

/** Element types that take a click (the runtime binds images, models and video screens). */
export const CLICKABLE_TYPES = new Set(['image', 'model', 'video'])

export const CLICK_KIND_LABELS: Array<[ClickKind, string]> = [
  ['none', 'Nothing'], ['link', 'Link'], ['sound', 'Sound'], ['move', 'Move'], ['teleport', 'Teleport'],
]

export interface ClickDraft {
  kind: ClickKind
  hoverText: string
  /** Kept from the saved action; a new one highlights (the dashboard can turn it off). */
  showFeedback: boolean
  link: string
  sound: string
  move: [string, string, string]
  teleport: string
}

const KIND: Record<number, ClickKind> = { 1: 'link', 2: 'sound', 4: 'move', 5: 'teleport' }
const TYPE: Record<Exclude<ClickKind, 'none'>, number> = { link: 1, sound: 2, move: 4, teleport: 5 }

export function clickDraftOf(c: Partial<ClickEvent> | null | undefined): ClickDraft {
  const p = c?.moveTo?.position
  return {
    kind: (c?.type !== undefined && KIND[c.type]) || 'none',
    hoverText: c?.hoverText ?? '',
    showFeedback: c?.type ? c.showFeedback === true : true,
    link: c?.externalLink ?? '',
    sound: c?.sound ?? '',
    move: p ? [String(p.x), String(p.y), String(p.z)] : ['', '', ''],
    teleport: c?.teleportTo ?? '',
  }
}

/** What to save (null for Nothing), or why it can't be. */
export function clickFromDraft(d: ClickDraft): ClickCheck {
  if (d.kind === 'none') return { ok: true, value: null }
  const [x, y, z] = d.move.map((s) => (s.trim() === '' ? NaN : Number(s)))
  return checkClickEvent({
    type: TYPE[d.kind],
    hoverText: d.hoverText,
    showFeedback: d.showFeedback,
    ...(d.kind === 'link' ? { externalLink: d.link } : {}),
    ...(d.kind === 'sound' ? { sound: d.sound } : {}),
    ...(d.kind === 'move' ? { moveTo: { position: { x, y, z } } } : {}),
    ...(d.kind === 'teleport' ? { teleportTo: d.teleport } : {}),
  })
}

export const clickLabel = (c: Partial<ClickEvent> | null | undefined): string => `On click: ${describeClick(c)}`
