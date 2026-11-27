/**
 * Sound plays for analytics (LIV-38): which sounds started or stopped since the last scan, from each AudioSource's
 * `playing`. A sound already playing when first seen counts as a play (it started since the scene loaded); a sound that
 * disappears is forgotten without a stop. `prev` is updated in place.
 */
export function soundTransitions<K>(prev: Map<K, boolean>, current: Array<[K, boolean]>): Array<{ key: K; state: 'play' | 'stop' }> {
  const out: Array<{ key: K; state: 'play' | 'stop' }> = []
  const seen = new Set<K>()
  for (const [key, playing] of current) {
    seen.add(key)
    const was = prev.get(key) ?? false
    if (playing !== was) out.push({ key, state: playing ? 'play' : 'stop' })
    prev.set(key, playing)
  }
  for (const key of [...prev.keys()]) if (!seen.has(key)) prev.delete(key)
  return out
}
