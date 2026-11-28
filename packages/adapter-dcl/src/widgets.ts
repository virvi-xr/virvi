/**
 * The HUD's Widgets panel (LIV-158): the live preset's widgets, and what each control can change in-world.
 * Pure (no @dcl/sdk), so it is unit-tested. Matches the dashboard's widget editor (apps/web scenes/[sceneId]/client.tsx).
 */
import { WidgetControlType, selectorOptions } from '@virvixr/shared'

export interface HUDWidget { id: string; name: string; type: WidgetControlType; value: unknown; options: string[] }

/** The ones worth showing, by name. "None" widgets have no control. */
export function widgetRows(list: Array<{ id: string; name: string; type: WidgetControlType; value: unknown; options?: string[]; enabled?: boolean }>): HUDWidget[] {
  return list
    .filter((w) => w.type !== WidgetControlType.NONE && w.enabled !== false)
    .map((w) => ({ id: w.id, name: w.name || 'Widget', type: w.type, value: w.value, options: w.options ?? [] }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

/** The dashboard's slider: 0 to 100, 50 until set. */
export const sliderValue = (v: unknown): number => {
  const n = Number(v ?? 50)
  return Number.isFinite(n) ? Math.min(100, Math.max(0, Math.round(n))) : 50
}

export const DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/

/** "2026-11-28T20:00" as the dashboard stores it; null when it isn't one. Accepts a space for the T. */
export function parseDatetime(text: string): string | null {
  const s = text.trim().replace(' ', 'T')
  if (!DATETIME_RE.test(s)) return null
  const [d, t] = s.split('T')
  const [y, mo, da] = d.split('-').map(Number)
  const [h, mi] = t.split(':').map(Number)
  if (mo < 1 || mo > 12 || da < 1 || da > 31 || h > 23 || mi > 59 || y < 1970) return null
  return s
}

/** The value as the panel shows it. */
export function widgetValueLabel(w: Pick<HUDWidget, 'type' | 'value'> & { options?: string[] }): string {
  switch (w.type) {
    case WidgetControlType.TOGGLE: return w.value ? 'On' : 'Off'
    case WidgetControlType.SLIDER: return String(sliderValue(w.value))
    case WidgetControlType.TEXT: return typeof w.value === 'string' && w.value ? w.value : '(empty)'
    case WidgetControlType.DATETIME: return typeof w.value === 'string' && w.value ? w.value.replace('T', ' ') : 'Not set'
    case WidgetControlType.TRIGGER: return typeof w.value === 'number' ? 'Pressed before' : 'Not pressed yet'
    case WidgetControlType.SELECTOR: {
      const options = selectorOptions({ options: w.options, value: w.value })
      if (!options.length) return 'No options yet: add them on the dashboard'
      return typeof w.value === 'string' && options.includes(w.value) ? `Chosen: ${w.value}` : 'Nothing chosen'
    }
    default: return ''
  }
}

export const TYPE_LABEL: Record<WidgetControlType, string> = {
  [WidgetControlType.NONE]: 'None',
  [WidgetControlType.TOGGLE]: 'Toggle',
  [WidgetControlType.TEXT]: 'Text',
  [WidgetControlType.SELECTOR]: 'Selector',
  [WidgetControlType.DATETIME]: 'Date and time',
  [WidgetControlType.TRIGGER]: 'Trigger',
  [WidgetControlType.SLIDER]: 'Slider',
}

/** The element's properties with a new value; PUT /api/elements replaces properties whole. A Selector keeps its options. */
export function withWidgetValue(properties: Record<string, unknown> | null | undefined, value: unknown): Record<string, unknown> {
  const p = properties ?? {}
  if (Number(p.controlType) === WidgetControlType.SELECTOR) return { ...p, options: selectorOptions(p), value }
  return { ...p, value }
}

/** How many option buttons the HUD shows before pointing to the dashboard. */
export const HUD_SELECTOR_BUTTONS = 8

/** A text box's value can be up to this long in-world (the dashboard has no cap; keep chat-sized). */
export const WIDGET_TEXT_MAX = 500
