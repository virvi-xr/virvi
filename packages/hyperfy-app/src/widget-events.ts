import { WidgetControlType, selectorOptions } from '@virvixr/shared'

/**
 * Widgets in Hyperfy (LIV-158): Hyperfy worlds have no scene code, so the Virvi app tells the world's other apps
 * about the scene's widgets with world events, on both halves:
 *
 *   world.on('virvi:widget', ({ id, customId, name, type, value, options }) => …)   // each widget, then each change
 *   world.on('virvi:widget-click', ({ id, customId, name }) => …)                   // a Trigger pressed
 *
 * A widget that's removed or hidden is sent once more with `removed: true`.
 */
export const WIDGET_EVENT = 'virvi:widget'
export const WIDGET_CLICK_EVENT = 'virvi:widget-click'

export interface WidgetEvent {
  id: string
  customId: string | null
  name: string
  type: WidgetControlType
  value: unknown
  options: string[]
  removed?: true
}

type Props = Record<string, unknown>

function eventOf(raw: Props): WidgetEvent | null {
  if (typeof raw.sk !== 'string' || raw.enabled === false) return null
  const type = Number(raw.controlType ?? 0)
  if (!Number.isInteger(type) || type <= 0 || type > 6) return null
  return {
    id: raw.sk,
    customId: typeof raw.customId === 'string' && raw.customId ? raw.customId : null,
    name: typeof raw.name === 'string' ? raw.name : '',
    type: type as WidgetControlType,
    value: raw.value ?? null,
    options: type === WidgetControlType.SELECTOR ? selectorOptions(raw) : [],
  }
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

/**
 * What to emit for a new scene snapshot, given what was emitted before (by widget id). The first snapshot emits every
 * widget; later ones only what changed. A Trigger whose value moved also gets a click.
 */
export function widgetEvents(prev: Map<string, WidgetEvent> | null, scene: { widgets?: unknown[] } | null | undefined): {
  changes: WidgetEvent[]
  clicks: WidgetEvent[]
  next: Map<string, WidgetEvent>
} {
  const next = new Map<string, WidgetEvent>()
  for (const raw of scene?.widgets ?? []) {
    const e = raw && typeof raw === 'object' ? eventOf(raw as Props) : null
    if (e) next.set(e.id, e)
  }
  const changes: WidgetEvent[] = []
  const clicks: WidgetEvent[] = []
  for (const [id, e] of next) {
    const before = prev?.get(id)
    if (!before || !same(before, e)) changes.push(e)
    if (before && e.type === WidgetControlType.TRIGGER && !same(before.value, e.value)) clicks.push(e)
  }
  if (prev) for (const [id, e] of prev) if (!next.has(id)) changes.push({ ...e, value: null, removed: true })
  return { changes, clicks, next }
}
