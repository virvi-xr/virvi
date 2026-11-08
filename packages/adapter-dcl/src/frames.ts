/**
 * Setting an image's or video screen's frame from the HUD's Layout panel (LIV-129), as the dashboard does: Off, Thin,
 * Classic or Gallery, a colour swatch and a thickness. Pure (no @dcl/sdk), so it is unit-tested; checked with the
 * shared checkFrame the server uses.
 */
import { FRAMEABLE_TYPES, FRAME_STYLE_LABELS, FRAME_THICKNESS, checkFrame, defaultFrame, readFrame, withFrameStyle, type FrameCheck, type FrameSettings, type FrameStyle } from '@virvixr/shared'

/** Element types that take a frame. */
export const FRAMEABLE = FRAMEABLE_TYPES

/** The style row: Off, then each style. */
export const FRAME_CHOICES: Array<['off' | FrameStyle, string]> = [
  ['off', 'Off'], ['thin', FRAME_STYLE_LABELS.thin], ['classic', FRAME_STYLE_LABELS.classic], ['gallery', FRAME_STYLE_LABELS.gallery],
]

/** The saved frame to edit, or a Thin one switched off. */
export function frameDraftOf(frame: FrameSettings | null | undefined): FrameSettings {
  return frame ? { ...frame } : { ...defaultFrame(), enabled: false }
}

/** Off keeps the settings (switching back on brings them back); a style turns the frame on. */
export function withDraftStyle(draft: FrameSettings, choice: 'off' | FrameStyle): FrameSettings {
  if (choice === 'off') return { ...draft, enabled: false }
  return { ...withFrameStyle(draft, choice), enabled: true }
}

export function stepThickness(draft: FrameSettings, delta: number): FrameSettings {
  const t = Math.round(draft.thickness + delta * FRAME_THICKNESS.step)
  return { ...draft, thickness: Math.min(FRAME_THICKNESS.max, Math.max(FRAME_THICKNESS.min, t)) }
}

export function frameFromDraft(draft: FrameSettings): FrameCheck {
  return checkFrame(draft)
}

export function frameLabel(frame: FrameSettings | null | undefined): string {
  if (!frame?.enabled) return 'No frame'
  return `${FRAME_STYLE_LABELS[frame.style]} frame, ${frame.thickness}%`
}

/** The element's properties with this frame (a PUT replaces properties whole). */
export function withFrame(properties: Record<string, unknown> | null | undefined, frame: FrameSettings | null): Record<string, unknown> {
  return { ...(properties ?? {}), frame }
}

/** A stored frame as the HUD shows it: as the runtime draws it (held in range), on or off; null for none. */
export function storedFrame(raw: unknown): FrameSettings | null {
  return readFrame(raw)
}
