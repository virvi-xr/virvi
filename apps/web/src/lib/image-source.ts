import { mediaLabel, type MediaNames } from './media-names'

/** How a chosen image shows in an editor: its library name (full URL on hover), or null when none is set. */
export function imageSourceRow(url: string | undefined, lookup: MediaNames | null): { label: string; title: string; missing: boolean } | null {
  if (!url) return null
  const { label, missing } = mediaLabel(url, lookup, 'Missing image')
  return { label, title: url, missing }
}

/** A URL typed or pasted into an image field, trimmed; null when there is nothing to set. */
export function pastedSource(input: string): string | null {
  const url = input.trim()
  return url ? url : null
}
