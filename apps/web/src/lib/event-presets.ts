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
