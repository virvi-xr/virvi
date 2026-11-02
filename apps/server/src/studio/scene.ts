/**
 * Scene designs: buildings and furniture for Decentraland scenes (studio-worker CONTRACT.md, "Scene designs"). A piece's
 * category is `building` or `furniture_<name>`, at most 32 characters, as the worker writes them.
 */
export const SCENE_CATEGORY = /^(building|furniture_[a-z_]{1,22})$/
export const FOOTPRINTS = ['0.5x0.5', '1x1', '1x2', '2x2', '4x4'] as const
export type Footprint = typeof FOOTPRINTS[number]

/** Inspect, the furniture scale turn and the building's walk-through. */
export const SCENE_ORBIT_KEY = 'orbit-scene'
export const SCALE_KEY = 'scale'
export const TOUR_KEY = 'tour'

/** A building took a skilled agent about 18 minutes in testing: more time, turns and spend than a wearable prompt. */
export const SCENE_PROMPT_LIMITS = { timeoutSec: 2700, maxTurns: 150, costCeilingUsd: 6 }

export const isFurniture = (category: string) => category !== 'building' && SCENE_CATEGORY.test(category)
