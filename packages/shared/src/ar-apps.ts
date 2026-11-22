/**
 * Virvi AR, one app on three platforms, in one place: virvi.io/ar, the dashboard's AR tab, the ring's fallback page (/s/<code>) and the
 * docs read these. When an app reaches a store, set its `storeUrl` and `status: 'store'`, and every page links there.
 */
export type ArAppStatus = 'store' | 'preview' | 'prototype' | 'coming'

export interface ArApp {
  id: 'quest' | 'vision-pro' | 'iphone'
  /** Always 'Virvi AR': the same app on every platform. */
  name: string
  /** The platform, as cards title it: "Virvi AR for Meta Quest". */
  platform: string
  device: string
  role: string
  status: ArAppStatus
  storeUrl: string | null
  sourceUrl: string
}

export const AR_APPS_REPO = 'https://github.com/virvi-xr/virvi'

export const AR_APPS: readonly ArApp[] = [
  {
    id: 'quest',
    name: 'Virvi AR',
    platform: 'Meta Quest',
    device: 'Meta Quest 3 and 3S',
    role: 'Visit AR Spaces, and build them in the room',
    status: 'preview',
    storeUrl: null,
    sourceUrl: `${AR_APPS_REPO}/tree/main/apps/quest`,
  },
  {
    id: 'vision-pro',
    name: 'Virvi AR',
    platform: 'Apple Vision Pro',
    device: 'Apple Vision Pro',
    role: 'Build your scene life-size, on the floor',
    status: 'preview',
    storeUrl: null,
    sourceUrl: `${AR_APPS_REPO}/tree/main/apps/vision-pro`,
  },
  {
    // apps/ar-spike is the prototype the iPhone app grows from (LIV-197)
    id: 'iphone',
    name: 'Virvi AR',
    platform: 'iPhone',
    device: 'iPhone, iOS 18 or later',
    role: 'See AR Spaces, and earn BEATs by being there',
    status: 'prototype',
    storeUrl: null,
    sourceUrl: `${AR_APPS_REPO}/tree/main/apps/ar-spike`,
  },
]

const STATUS_LABELS: Record<ArAppStatus, string> = {
  store: 'In the store',
  preview: 'Preview',
  prototype: 'Prototype',
  coming: 'Coming soon',
}

/** The app's status badge, in words. */
export function arAppStatusLabel(status: ArAppStatus): string {
  return STATUS_LABELS[status]
}

/** Where an app's button goes: its store page once it has one, otherwise its source, with a note that it isn't in the store yet. */
export function arAppLink(app: ArApp): { href: string; label: string; note: string | null } {
  if (app.storeUrl) {
    return { href: app.storeUrl, label: app.id === 'quest' ? 'Get it on the Meta Horizon Store' : 'Download on the App Store', note: null }
  }
  return { href: app.sourceUrl, label: 'See the source on GitHub', note: 'Not in the store yet' }
}

/**
 * All the apps, the visitor's own device first when its user agent clearly says so: iPhone or iPad, or the Quest's
 * browser. Anything else (Vision Pro's Safari says it's a Mac) keeps the usual order.
 */
export function arAppsForDevice(userAgent: string): ArApp[] {
  const first: ArApp['id'] | null = /\b(iPhone|iPad|iPod)\b/.test(userAgent)
    ? 'iphone'
    : /OculusBrowser|\bQuest\b/.test(userAgent) ? 'quest' : null
  if (!first) return [...AR_APPS]
  return [...AR_APPS.filter((a) => a.id === first), ...AR_APPS.filter((a) => a.id !== first)]
}
