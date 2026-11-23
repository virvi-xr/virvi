/**
 * Sample data for the guest demos (LIV-91 phase 2): a 2×2-parcel sample World with a week of visits, a sample scene with
 * three events, and one giveaway with items and claims. Pure and deterministic: the same `now` gives the same data.
 */
import type { GiveawayChain, GiveawayClaimStatus, GiveawayMintState } from '@virvixr/shared'
import type { AnalyticsLocation, HeatCell } from '../analytics/types'

const HOUR = 3_600_000
const DAY = 24 * HOUR

export const SAMPLE_WORLD = {
  name: 'virvi-sample.dcl.eth',
  parcels: ['0,0', '1,0', '0,1', '1,1'],
  baseParcel: '0,0',
} as const

export interface DemoVisit {
  id: string; userId: string; startedAt: string; endedAt: string; durationSec: number
  platform: string; country: string; isReturning: boolean; verified: boolean
}
export interface DemoEvent {
  id: string; name: string; description: string | null; startTime: string | null; endTime: string | null; timezone: string
  createdAt: string; updatedAt: string
}
/** A sample automatic giveaway (LIV-194), as the demo keeps it; the store builds the host view from it. */
export interface DemoGiveaway {
  id: string; name: string; chain: GiveawayChain; enabled: boolean; walletAddress: string
  startsAt: string | null; endsAt: string | null; claimCap: number | null; minPresentSeconds: number
  sceneIds: string[]
  /** The giveaway wallet's POL, all of it the host's (the demo is a free account). */
  balanceWei: string
  createdAt: string; updatedAt: string
}
export interface DemoItem {
  id: string; giveawayId: string; contractAddress: string; itemId: string; name: string; imageUrl: string | null; rarity: string | null
  mintState: GiveawayMintState; remaining: number
}
export interface DemoClaim {
  id: string; giveawayId: string; wallet: string; status: GiveawayClaimStatus; failReason: string | null
  claimedAt: string | null; sentAt: string | null
}
/** The demo host's own wearables, which the item picker lists. */
export const DEMO_CREATOR_ITEMS: ReadonlyArray<{ contractAddress: string; itemId: string; name: string; rarity: string; available: number }> = [
  { contractAddress: '0x00000000000000000000000000000000000000d1', itemId: '0', name: 'Neon visor', rarity: 'rare', available: 4980 },
  { contractAddress: '0x00000000000000000000000000000000000000d1', itemId: '1', name: 'Star jacket', rarity: 'epic', available: 980 },
  { contractAddress: '0x00000000000000000000000000000000000000d1', itemId: '2', name: 'Glow sneakers', rarity: 'uncommon', available: 9900 },
  { contractAddress: '0x00000000000000000000000000000000000000d2', itemId: '0', name: 'Comet cap', rarity: 'legendary', available: 99 },
]
/** The demo host's verified wallet, where sent-back POL goes. */
export const DEMO_HOST_WALLET = '0x00000000000000000000000000000000000de111'
const DEMO_GIVEAWAY_WALLET = '0x0000000000000000000000000000000000de6a11'

/** What a guest can change in the demo; this part is kept in the browser. */
export interface DemoEditable {
  events: DemoEvent[]
  eventScenes: Array<{ eventId: string; sceneId: string }>
  eventGiveaways: Array<{ eventId: string; giveawayId: string }>
  giveaways: DemoGiveaway[]
  items: DemoItem[]
  claims: DemoClaim[]
}
export interface DemoData extends DemoEditable {
  location: AnalyticsLocation
  scene: { id: string; name: string; description: string | null; createdAt: string; updatedAt: string }
  visits: DemoVisit[]
  cells: HeatCell[]
  /** Visitors walk these spots; the live view and the heatmap use them. */
  hotspots: Array<{ x: number; z: number; weight: number }>
}

/** mulberry32: a small seeded PRNG, so the sample week is the same every time. */
function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const SEED = 0x5eed91
const SIZE = 32 // a 2×2 World: 32 m each way
const PLATFORMS = ['desktop', 'desktop', 'desktop', 'web', 'mobile']
const COUNTRIES = ['US', 'US', 'GB', 'DE', 'BR', 'JP', 'FR', 'CA', 'AR', 'KR']
export const DEMO_SCENE_ID = 'demo-scene'
export const DEMO_LOCATION_ID = 'demo-location'

export function demoFixtures(now: number): DemoData {
  const r = rng(SEED)
  const iso = (t: number) => new Date(t).toISOString()
  // Anchored to the hour so a page left open keeps the same week
  const end = Math.floor(now / HOUR) * HOUR
  // 168 hours, the last one the hour in progress (its visits up to `now`)
  const start = end - (7 * 24 - 1) * HOUR

  const hotspots = [
    { x: 16, z: 16, weight: 5 }, // the stage in the middle
    { x: 6, z: 26, weight: 2 },
    { x: 26, z: 7, weight: 3 },
    { x: 4, z: 4, weight: 1 }, // the spawn point
  ]

  // A pool of visitors, some of whom come back
  const visitors = Array.from({ length: 60 }, (_, i) => ({
    userId: `demo-visitor-${i + 1}`,
    platform: PLATFORMS[Math.floor(r() * PLATFORMS.length)],
    country: COUNTRIES[Math.floor(r() * COUNTRIES.length)],
    verified: r() < 0.7,
  }))
  const seen = new Set<string>()
  const visits: DemoVisit[] = []
  for (let h = 0; h < 7 * 24; h++) {
    const hourStart = start + h * HOUR
    const hourOfDay = new Date(hourStart).getUTCHours()
    // Busier in the evening (UTC), quiet overnight
    const busy = hourOfDay >= 17 && hourOfDay <= 23 ? 3 : hourOfDay >= 12 ? 1.5 : 0.4
    const n = Math.floor(r() * busy * 2)
    for (let k = 0; k < n; k++) {
      const v = visitors[Math.floor(r() * visitors.length)]
      const t = hourStart + Math.floor(r() * HOUR)
      if (t > now) continue
      const durationSec = 30 + Math.floor(r() * r() * 1800)
      visits.push({
        id: `demo-session-${visits.length + 1}`,
        userId: v.userId,
        startedAt: iso(t),
        endedAt: iso(Math.min(now, t + durationSec * 1000)),
        durationSec,
        platform: v.platform,
        country: v.country,
        isReturning: seen.has(v.userId),
        verified: v.verified,
      })
      seen.add(v.userId)
    }
  }

  // Heat cells (1 m) around the hotspots, kept inside the World
  const cells = new Map<string, HeatCell>()
  for (const spot of hotspots) {
    for (let i = 0; i < spot.weight * 30; i++) {
      const x = Math.max(0, Math.min(SIZE - 1, Math.floor(spot.x + (r() - 0.5) * 8)))
      const z = Math.max(0, Math.min(SIZE - 1, Math.floor(spot.z + (r() - 0.5) * 8)))
      const key = `${x},${z}`
      const c = cells.get(key) ?? { x, z, dwellSec: 0, visits: 0 }
      c.visits += 1 + Math.floor(r() * 3)
      c.dwellSec += 5 + Math.floor(r() * 40 * spot.weight)
      cells.set(key, c)
    }
  }

  const created = iso(start - 30 * DAY)
  const scene = { id: DEMO_SCENE_ID, name: 'Sample scene', description: 'A sample scene on virvi-sample.dcl.eth', createdAt: created, updatedAt: created }
  const location: AnalyticsLocation = {
    id: DEMO_LOCATION_ID,
    locationKey: SAMPLE_WORLD.name,
    kind: 'world',
    title: 'Sample scene',
    walletVisibility: false,
    verifiedSessionShare: 0.7,
    since: created,
    until: null,
    virviSceneId: DEMO_SCENE_ID,
    baseParcel: SAMPLE_WORLD.baseParcel,
    parcels: [...SAMPLE_WORLD.parcels],
    canManage: true,
  }

  const day = Math.floor(now / DAY) * DAY
  const events: DemoEvent[] = [
    { id: 'demo-event-1', name: 'Opening night', description: 'The sample World opens with a live DJ set.', startTime: iso(day - 5 * DAY + 19 * HOUR), endTime: iso(day - 5 * DAY + 22 * HOUR), timezone: 'UTC', createdAt: created, updatedAt: created },
    { id: 'demo-event-2', name: 'Gallery walk', description: 'A guided tour of the sample gallery.', startTime: iso(now - HOUR), endTime: iso(now + 2 * HOUR), timezone: 'UTC', createdAt: created, updatedAt: created },
    { id: 'demo-event-3', name: 'Community meetup', description: 'Meet other builders and share your scenes.', startTime: iso(day + 3 * DAY + 18 * HOUR), endTime: iso(day + 3 * DAY + 20 * HOUR), timezone: 'UTC', createdAt: created, updatedAt: created },
  ]
  const giveaway: DemoGiveaway = {
    id: 'demo-giveaway-1', name: 'Opening night wearables', chain: 'polygon', enabled: true, walletAddress: DEMO_GIVEAWAY_WALLET,
    startsAt: null, endsAt: null, claimCap: 100, minPresentSeconds: 300, sceneIds: [DEMO_SCENE_ID],
    balanceWei: '1500000000000000000', createdAt: created, updatedAt: created,
  }
  const items: DemoItem[] = DEMO_CREATOR_ITEMS.slice(0, 3).map((c, i) => ({
    id: `demo-item-${i + 1}`, giveawayId: giveaway.id, contractAddress: c.contractAddress, itemId: c.itemId, name: c.name, imageUrl: null,
    rarity: c.rarity, mintState: 'ready', remaining: c.available,
  }))
  const statuses: GiveawayClaimStatus[] = ['sent', 'sent', 'sent', 'waiting', 'failed']
  const claims: DemoClaim[] = statuses.map((status, i) => {
    const claimedAt = iso(day - 5 * DAY + 19 * HOUR + (i + 1) * 9 * 60_000)
    return {
      id: `demo-claim-${i + 1}`, giveawayId: giveaway.id, wallet: `0x${String(i + 1).repeat(4)}…${String(i + 1).repeat(4)}`, status,
      failReason: status === 'failed' ? 'sold_out' : null, claimedAt,
      sentAt: status === 'sent' ? iso(Date.parse(claimedAt) + 60_000) : null,
    }
  })

  return {
    location, scene, visits, cells: [...cells.values()], hotspots,
    events,
    eventScenes: events.map((e) => ({ eventId: e.id, sceneId: DEMO_SCENE_ID })),
    eventGiveaways: [{ eventId: 'demo-event-1', giveawayId: giveaway.id }],
    giveaways: [giveaway], items, claims,
  }
}
