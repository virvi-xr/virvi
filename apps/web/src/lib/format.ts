// Number and size formatting shared by the dashboard's list pages.

/** The page header's count badge: at least two digits, with thousands separators. */
export function countLabel(n: number): string {
  return n < 10 && n >= 0 ? `0${n}` : n.toLocaleString('en-US')
}

/** "1 event", "4 events", "5,482 assets". */
export function plural(n: number, noun: string): string {
  return `${n.toLocaleString('en-US')} ${noun}${n === 1 ? '' : 's'}`
}

export function formatBytes(bytes: number): string {
  if (!bytes) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB']
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(k)), sizes.length - 1)
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i]
}

/** A video's length: "0:03", "12:34", "2:15:00". Null when there's no usable length. */
export function formatDuration(seconds: unknown): string | null {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) return null
  const total = Math.round(seconds)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = String(total % 60).padStart(2, '0')
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`
}
