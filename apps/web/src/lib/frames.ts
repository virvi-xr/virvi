/**
 * The frame field on images and video screens (LIV-129): None, Thin, Classic or Gallery, a colour and a thickness.
 * Checked with the shared checkFrame the server uses; saved in the element's properties as `frame`.
 */
import {
  FRAME_STYLES, FRAME_STYLE_LABELS, FRAME_SWATCHES, FRAME_THICKNESS, checkFrame, defaultFrame, readFrame, withFrameStyle,
  type FrameSettings, type FrameStyle,
} from '@virvixr/shared'

export type FrameChoice = 'none' | FrameStyle

export const FRAME_CHOICES: { choice: FrameChoice; label: string }[] = [
  { choice: 'none', label: 'None' },
  ...FRAME_STYLES.map((s) => ({ choice: s, label: FRAME_STYLE_LABELS[s] })),
]

/**
 * The saved frame to edit, as the runtime draws it (one stored outside the rules is held in range, so saving it makes
 * it valid), or a Thin one switched off when there is none or it can't be read.
 */
export function frameFormOf(raw: unknown): FrameSettings {
  return readFrame(raw) ?? { ...defaultFrame(), enabled: false }
}

export function frameChoiceOf(form: FrameSettings): FrameChoice {
  return form.enabled ? form.style : 'none'
}

/** None keeps the settings (choosing a style again brings them back); a style turns the frame on. */
export function pickFrameChoice(form: FrameSettings, choice: FrameChoice): FrameSettings {
  if (choice === 'none') return { ...form, enabled: false }
  return { ...withFrameStyle(form, choice), enabled: true }
}

export function thicknessFrom(text: string): number | null {
  const n = Number(text)
  if (text.trim() === '' || !Number.isFinite(n)) return null
  return Math.min(FRAME_THICKNESS.max, Math.max(FRAME_THICKNESS.min, Math.round(n)))
}

/** The element's properties with this frame, or why it can't be saved. */
export function frameSaved(properties: Record<string, unknown> | null | undefined, form: FrameSettings):
  { ok: true; properties: Record<string, unknown> } | { ok: false; error: string } {
  const c = checkFrame(form)
  if (!c.ok) return c
  return { ok: true, properties: { ...(properties ?? {}), frame: c.value } }
}

const colourName = (hex: string) => FRAME_SWATCHES.find((s) => s.color === hex)?.label ?? hex

export function frameSummary(raw: unknown): string {
  const f = frameFormOf(raw)
  if (!f.enabled) return 'None'
  return `${FRAME_STYLE_LABELS[f.style]} · ${colourName(f.color)} · ${f.thickness}%`
}
