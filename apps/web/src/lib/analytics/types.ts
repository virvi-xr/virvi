// Mirrors the responses in apps/server/src/routes/analytics-read.ts.
export interface AnalyticsLocation {
  id: string; locationKey: string; kind: 'parcels' | 'world' | 'preview' | 'hyperfy' | 'ar'; title: string | null
  walletVisibility: boolean; verifiedSessionShare: number; since: string | null; until: string | null
  virviSceneId: string | null; baseParcel: string | null; parcels: string[]; canManage: boolean
}
export interface AnalyticsSummary {
  sessions: number; uniqueVisitors: number; newVisitors: number; returningVisitors: number
  peakConcurrency: number; dwellAvgSec: number; verifiedShare: number
  interactions: Record<string, number>; emotes: Record<string, number>; emoteLabels: Record<string, string>; countries: Record<string, number>; platforms: Record<string, number>
}
export interface TimeseriesPoint { t: string; sessions: number; uniqueVisitors: number; peakConcurrency: number; dwellAvgSec: number }
export interface LiveData { count: number; positions: Array<{ x: number; z: number }> }
// The server names the dwell field `dwellSec` (the brief's `dwell` was wrong).
export interface HeatCell { x: number; z: number; dwellSec: number; visits: number }
export interface AnalyticsSession {
  id: string; userId: string; walletAddress: string | null; displayName: string | null
  platform: string | null; country: string | null; startedAt: string; endedAt: string | null; durationSec: number; isReturning: boolean; verified: boolean
}
export interface AnalyticsRangeQuery { from: string; to: string }
