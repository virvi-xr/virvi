/** Scheduled presets on the event page (LIV-86): which presets go live during the event, per linked scene. */

export interface EventPresetSchedule { id: string; sceneId: string; presetId: string; presetName: string; enabled: boolean }
export interface ScenePresetOption { id: string; sceneId: string; name: string }

/** For one linked scene: the presets scheduled for the event, and the ones still to choose from. */
export function eventPresetsFor(sceneId: string, schedules: EventPresetSchedule[] = [], presets: ScenePresetOption[] = []) {
  const scheduled = schedules.filter((s) => s.sceneId === sceneId)
  const used = new Set(scheduled.map((s) => s.presetId))
  return { scheduled, choices: presets.filter((p) => p.sceneId === sceneId && !used.has(p.id)) }
}

/** "Concert" or "Concert (paused: the event needs a start and an end time)". */
export function eventPresetLabel(s: Pick<EventPresetSchedule, 'presetName' | 'enabled'>, name: (n: string) => string = (n) => n): string {
  return s.enabled ? name(s.presetName) : `${name(s.presetName)} (paused: the event needs a start and an end time)`
}

/** A scheduled showing that plays when the event starts (LIV-87), as GET /api/events/:id lists it. */
export interface EventShowing { id: string; sceneId: string; elementId: string; screenName: string | null; title: string | null; enabled: boolean }

export function eventShowingsFor(sceneId: string, showings: EventShowing[] = []): EventShowing[] {
  return showings.filter((s) => s.sceneId === sceneId)
}

/** "Film on Big screen", or "… (paused: the event needs a start time)". */
export function eventShowingLabel(s: EventShowing): string {
  const label = `${s.title || 'Untitled showing'} on ${s.screenName || 'Video screen'}`
  return s.enabled ? label : `${label} (paused: the event needs a start time)`
}
