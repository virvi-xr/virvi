import { useEffect, useState } from 'react'

/**
 * What POST /api/scenes/:id/media-names answers: the current Images & Video name of each URL whose file the viewer
 * may see, and our upload URLs whose file was deleted. URLs in neither (pasted links) show their own filename.
 */
export interface MediaNames {
  names: Record<string, string>
  missing: string[]
}

/** The last path segment of a URL, decoded (a malformed escape is kept as is), without query or hash. */
export function urlFilename(url: string): string {
  const last = url.split(/[?#]/)[0].split('/').pop() || url
  try { return decodeURIComponent(last) } catch { return last }
}

/** How a media URL is labelled in an editor: its library name, "Missing video" for a deleted upload, else its filename. */
export function mediaLabel(url: string, lookup: MediaNames | null, missingLabel = 'Missing video'): { label: string; missing: boolean } {
  const name = lookup?.names[url]
  if (name) return { label: name, missing: false }
  if (lookup?.missing.includes(url)) return { label: missingLabel, missing: true }
  return { label: urlFilename(url), missing: false }
}

/** A stable key for a set of URLs: the lookup reruns only when the set changes, not on reorder. */
export const mediaNamesKey = (urls: string[]): string => [...new Set(urls.filter(Boolean))].sort().join('\n')

/** Looks up the names behind `urls` in a scene; null until it answers, and stays null if it fails. */
export function useMediaNames(
  api: { getMediaNames: (sceneId: string, urls: string[]) => Promise<MediaNames> },
  sceneId: string,
  urls: string[],
): MediaNames | null {
  const key = mediaNamesKey(urls)
  const [lookup, setLookup] = useState<MediaNames | null>(null)
  useEffect(() => {
    if (!key) { setLookup({ names: {}, missing: [] }); return }
    let live = true
    api.getMediaNames(sceneId, key.split('\n'))
      .then((r) => { if (live) setLookup(r) })
      .catch(() => { /* keep what we had: filenames show instead */ })
    return () => { live = false }
  }, [api, sceneId, key])
  return lookup
}
