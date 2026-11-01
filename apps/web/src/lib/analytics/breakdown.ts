export function topWithOther(counts: Record<string, number>, n = 8): Array<{ key: string; value: number }> {
  const sorted = Object.entries(counts ?? {})
    .map(([key, value]) => ({ key, value: Number(value) }))
    .filter((x) => x.value > 0)
    .sort((a, b) => b.value - a.value || a.key.localeCompare(b.key))
  if (sorted.length <= n) return sorted
  const rest = sorted.slice(n).reduce((a, x) => a + x.value, 0)
  return [...sorted.slice(0, n), { key: 'Other', value: rest }]
}

/** What a bar shows for a key: the server's label when it sent one (e.g. an emote's name for its URN), else the key. */
export function barLabel(key: string, labels?: Record<string, string>): string {
  return labels?.[key] || key
}
