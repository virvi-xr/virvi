/**
 * Venue events fan out to scene rooms through Colyseus presence pub/sub,
 * so REST handlers and the lifecycle sweep reach rooms on any server.
 */
export type VenueEvent =
  | { type: 'grants_changed'; sceneId: string }
  | { type: 'preset_changed'; sceneId: string; presetId: string }
  | { type: 'booking_ended'; sceneId: string; bookingId: string; reason: 'expired' | 'canceled' }
  | {
      type: 'element_changed'
      sceneId: string
      presetId: string
      elementId: string
      elementType: string
      deleted: boolean
    }
  | { type: 'library_changed'; sceneId: string; linkId: string; removed: boolean }
  /** A screen's scheduled showings were added, edited or removed (LIV-87). */
  | { type: 'showings_changed'; sceneId: string; elementId: string }
  | ({ type: 'presets_changed'; sceneId: string } & PresetsChange)

/** A preset was created, renamed or deleted (the list editors see; switching the live one is preset_changed). */
export type PresetsChange =
  | { action: 'upsert'; preset: { id: string; name: string; locale: string | null; createdAt: Date; updatedAt: Date } }
  | { action: 'delete'; presetId: string }

export interface BusPresence {
  publish(topic: string, data: unknown): unknown
  subscribe(topic: string, callback: (data: any) => void): unknown
  unsubscribe(topic: string, callback?: (data: any) => void): unknown
}

let presence: BusPresence | null = null

export function initBus(p: BusPresence) {
  presence = p
}

export function venueTopic(sceneId: string) {
  return `venue:${sceneId}`
}

export async function publishVenueEvent(e: VenueEvent) {
  if (!presence) return
  await presence.publish(venueTopic(e.sceneId), e)
  if (e.type === 'preset_changed') await publishSceneTouched(e.sceneId)
}

/** Per-scene "live content changed" topic. Scene rooms don't listen, so they never see their own touches. */
export function sceneFeedTopic(sceneId: string) {
  return `feed:${sceneId}`
}

/** Say a scene's live content changed (after the DB write). Never throws, like publishElementChanged. */
export async function publishSceneTouched(sceneId: string): Promise<void> {
  if (!presence) return
  try {
    await presence.publish(sceneFeedTopic(sceneId), { sceneId })
  } catch (err) {
    console.error('[bus] scene touch publish failed:', err)
  }
}

/**
 * Call `cb` whenever the scene is touched, on any server. Resolves once the subscription is in place (a
 * rejection means it isn't), with the unsubscribe, which never throws.
 */
export async function onSceneTouched(sceneId: string, cb: () => void): Promise<() => Promise<void>> {
  const p = presence
  if (!p) return async () => {}
  const topic = sceneFeedTopic(sceneId)
  const handler = () => cb()
  await p.subscribe(topic, handler)
  return async () => {
    try {
      await p.unsubscribe(topic, handler)
    } catch (err) {
      console.error('[bus] scene touch unsubscribe failed:', err)
    }
  }
}

/**
 * Tell scene rooms an element (or one of its instances) changed through REST.
 * Never throws: the DB write already succeeded, so a failed broadcast must not fail the request.
 */
export async function publishElementChanged(e: Omit<Extract<VenueEvent, { type: 'element_changed' }>, 'type'>) {
  try {
    await publishVenueEvent({ type: 'element_changed', ...e })
  } catch (err) {
    console.error('[bus] element_changed publish failed:', err)
  }
}

/**
 * Tell scene rooms a scene-library entry was added, changed status, or removed. Never throws, like publishElementChanged.
 */
export async function publishLibraryChanged(sceneId: string, linkId: string, removed = false): Promise<void> {
  try {
    await publishVenueEvent({ type: 'library_changed', sceneId, linkId, removed })
  } catch (err) {
    console.error('[bus] library_changed publish failed:', err)
  }
}

/** Tell scene rooms (and so dashboards and HUDs) the preset list changed. Never throws, like publishElementChanged. */
export async function publishScenePresetsChanged(e: { sceneId: string } & PresetsChange): Promise<void> {
  try {
    await publishVenueEvent({ type: 'presets_changed', ...e })
  } catch (err) {
    console.error('[bus] presets_changed publish failed:', err)
  }
}

/** Global topic: a stream went live/offline. Any scene may show it, so every scene room listens. */
export const STREAMS_TOPIC = 'streams'
export interface StreamStatusEvent {
  type: 'stream_status'
  playlistUrl: string
  live: boolean
}

export async function publishStreamStatus(e: Omit<StreamStatusEvent, 'type'>): Promise<void> {
  if (!presence) return
  try {
    await presence.publish(STREAMS_TOPIC, { type: 'stream_status', ...e })
  } catch (err) {
    console.error('[bus] stream_status publish failed:', err)
  }
}

/** Publish on any topic (after the DB write). Never throws, like publishSceneTouched. */
export async function publishOnBus(topic: string, data: unknown): Promise<void> {
  if (!presence) return
  try {
    await presence.publish(topic, data)
  } catch (err) {
    console.error(`[bus] ${topic.split(':')[0]} publish failed:`, err)
  }
}
