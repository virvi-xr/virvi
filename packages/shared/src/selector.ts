/**
 * Selector widgets (LIV-196): `properties.options` is the list to choose from and `value` the chosen option.
 * Selectors saved before kept the options, comma-separated, in `value` and had no choice: those still read as their
 * options, with nothing chosen.
 */
export const SELECTOR_MAX_OPTIONS = 50
export const SELECTOR_OPTION_MAX = 80

/** "Red, Green ,, Blue" → ['Red', 'Green', 'Blue']: trimmed, no blanks or repeats, within the limits. */
export function parseSelectorOptions(text: string): string[] {
  const out: string[] = []
  for (const raw of text.split(',')) {
    const o = raw.trim().slice(0, SELECTOR_OPTION_MAX)
    if (o && !out.includes(o)) out.push(o)
    if (out.length >= SELECTOR_MAX_OPTIONS) break
  }
  return out
}

/** A selector's options, from its properties (or an old selector's comma list). */
export function selectorOptions(props: Record<string, unknown> | null | undefined): string[] {
  const p = props ?? {}
  if (Array.isArray(p.options)) return p.options.filter((o): o is string => typeof o === 'string' && o.trim() !== '').map((o) => o.trim())
  return typeof p.value === 'string' && p.value.includes(',') ? parseSelectorOptions(p.value) : []
}

/** The chosen option, or null when nothing (or something no longer offered) is chosen. */
export function selectorChoice(props: Record<string, unknown> | null | undefined): string | null {
  const p = props ?? {}
  if (!Array.isArray(p.options)) return null // an old selector: its value is its options
  return typeof p.value === 'string' && selectorOptions(p).includes(p.value) ? p.value : null
}
