import { VideoSourceType } from '@virvixr/shared'
import type { AdContent, AdShape, AdminAd, LevelCounts, OwnerAdCandidate } from '@virvixr/shared'

const SHAPE_LABELS: Record<AdShape, string> = {
  '16:9': '16:9 landscape',
  '1:1': '1:1 square',
  '9:16': '9:16 portrait',
  '2:5': '2:5 tall',
}

export function shapeLabel(shape: AdShape): string {
  return SHAPE_LABELS[shape]
}

export function isHttpsUrl(s: string): boolean {
  try {
    return new URL(s).protocol === 'https:'
  } catch {
    return false
  }
}

/** Verified clicks over verified on-screen views, e.g. '1.3%'. */
export function clickRate(c: LevelCounts): string {
  if (c.screen === 0) return '—'
  return `${((c.click / c.screen) * 100).toFixed(1)}%`
}

const AD_MODES_HOUSE = 'House ads fill it unless a partner ad is placed on it.'

/** Label for a video screen's off image field, or null when its mode does not use one (ads modes use it as their fallback). */
export function offImageLabel(offType: number): string | null {
  if (offType === VideoSourceType.IMAGE) return 'Off Image URL'
  if (offType === VideoSourceType.ADS || offType === VideoSourceType.PLAYLIST_ADS) return 'Fallback Image URL (shown when no ad can play)'
  if (offType === VideoSourceType.SCHEDULED) return 'Holding Image URL (shown between showings)'
  return null
}

/** What a video screen's ads mode does, or null for the other modes. */
export function adModeHint(offType: number): string | null {
  if (offType === VideoSourceType.ADS) return `Shows ads while no stream is live. ${AD_MODES_HOUSE}`
  if (offType === VideoSourceType.PLAYLIST_ADS) return `Plays the playlist with an ad after every video. ${AD_MODES_HOUSE}`
  return null
}

/** True when a video screen's off type is one of the ads modes. */
export function isAdsMode(offType: number): boolean {
  return offType === VideoSourceType.ADS || offType === VideoSourceType.PLAYLIST_ADS
}

const CONTENT_LABELS: Record<AdContent, string> = {
  family: 'Family-friendly only',
  all: 'Allow all (includes mature ads such as alcohol)',
  approve: 'Approve each ad',
}

export function contentLabel(c: AdContent): string {
  return CONTENT_LABELS[c]
}

export function reviewBadge(r: AdminAd['review']): { text: string; tone: 'pending' | 'ok' | 'bad' } {
  if (r.status === 'rejected') return { text: 'Rejected', tone: 'bad' }
  if (r.status === 'approved') return { text: r.audience === 'mature' ? 'Approved · Mature' : 'Approved · Family-friendly', tone: 'ok' }
  return { text: 'Awaiting review', tone: 'pending' }
}

/** Small badges on an owner's candidate ad: who made it, and who it suits (omitted when unset). */
export function candidateBadges(c: Pick<OwnerAdCandidate, 'house' | 'audience'>): string[] {
  const out = [c.house ? 'House' : 'Partner']
  if (c.audience === 'family') out.push('Family-friendly')
  else if (c.audience === 'mature') out.push('Mature')
  return out
}

const AD_SPACE_ERRORS: Record<string, string> = {
  not_an_ad_space: "This element isn't an ad space.",
  ad_not_a_candidate: "That ad can't show in this space any more. Refresh and try again.",
  content_must_be_family_all_or_approve: 'Choose one of the three settings.',
}

/** Sentence for an ad space settings error from the server; unknown codes get a generic line. */
export function adSpaceErrorText(e: { message?: string } | null | undefined): string {
  return AD_SPACE_ERRORS[e?.message ?? ''] ?? 'Something went wrong. Try again.'
}

/** Changes whenever an element property that decides which ads fit it changes, so the candidate list reloads. */
export function adSpaceRefreshKey(props: { shape?: string; formats?: string; adShape?: string; offType?: number }): string {
  return [props.shape, props.formats, props.adShape, props.offType].join('|')
}
