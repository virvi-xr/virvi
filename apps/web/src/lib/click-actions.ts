/** The dashboard's click action form (LIV-126): a saved `clickEvent` to fields and back, checked as the server checks it. */
import { checkClickEvent, type ClickCheck, type ClickEvent } from '@virvixr/shared'

export type ClickKind = 'none' | 'link' | 'sound' | 'move' | 'teleport'

export const CLICK_KINDS: Array<{ kind: ClickKind; label: string }> = [
  { kind: 'none', label: 'Nothing' },
  { kind: 'link', label: 'Open a link' },
  { kind: 'sound', label: 'Play a sound' },
  { kind: 'move', label: 'Move the visitor' },
  { kind: 'teleport', label: 'Teleport' },
]

/** Hover text shown as the field's placeholder for each action. */
export const HOVER_PLACEHOLDER: Record<ClickKind, string> = { none: '', link: 'Open link', sound: 'Play sound', move: 'Go there', teleport: 'Teleport' }

type Triple = [string, string, string]

export interface ClickForm {
  kind: ClickKind
  hoverText: string
  showFeedback: boolean
  link: string
  sound: string
  move: Triple
  aimCamera: boolean
  camera: Triple
  teleport: string
}

export const blankClickForm = (): ClickForm => ({
  kind: 'none', hoverText: '', showFeedback: false, link: '', sound: '', move: ['', '', ''], aimCamera: false, camera: ['', '', ''], teleport: '',
})

const KIND: Record<number, ClickKind> = { 1: 'link', 2: 'sound', 4: 'move', 5: 'teleport' }
const TYPE: Record<Exclude<ClickKind, 'none'>, number> = { link: 1, sound: 2, move: 4, teleport: 5 }

const triple = (v: { x: number; y: number; z: number } | undefined): Triple => (v ? [String(v.x), String(v.y), String(v.z)] : ['', '', ''])

export function clickFormOf(c: Partial<ClickEvent> | null | undefined): ClickForm {
  const kind = (c?.type !== undefined && KIND[c.type]) || 'none'
  if (kind === 'none') return blankClickForm()
  return {
    ...blankClickForm(),
    kind,
    hoverText: c?.hoverText ?? '',
    showFeedback: c?.showFeedback === true,
    link: c?.externalLink ?? '',
    sound: c?.sound ?? '',
    move: triple(c?.moveTo?.position),
    aimCamera: !!c?.moveTo?.cameraTarget,
    camera: triple(c?.moveTo?.cameraTarget),
    teleport: c?.teleportTo ?? '',
  }
}

const vec = (t: Triple) => {
  const [x, y, z] = t.map((s) => (s.trim() === '' ? NaN : Number(s)))
  return { x, y, z }
}

/** The action to save (null for Nothing), or why it can't be. */
export function clickFromForm(f: ClickForm): ClickCheck {
  if (f.kind === 'none') return { ok: true, value: null }
  return checkClickEvent({
    type: TYPE[f.kind],
    hoverText: f.hoverText,
    showFeedback: f.showFeedback,
    ...(f.kind === 'link' ? { externalLink: f.link } : {}),
    ...(f.kind === 'sound' ? { sound: f.sound } : {}),
    ...(f.kind === 'move' ? { moveTo: { position: vec(f.move), ...(f.aimCamera ? { cameraTarget: vec(f.camera) } : {}) } } : {}),
    ...(f.kind === 'teleport' ? { teleportTo: f.teleport } : {}),
  })
}
