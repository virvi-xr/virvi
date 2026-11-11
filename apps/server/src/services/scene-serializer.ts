/**
 * Scene Preset Serializer
 *
 * Transforms the generic V2 database format (scene_elements with type + properties JSONB)
 * into the V1-compatible wire format that adapters expect:
 *   { videos: [...], images: [...], sounds: [...], models: [...], widgets: [...], claimPoints: [...] }
 *
 * Each element's `properties` JSONB is flattened into the config object,
 * and `id` is mapped to `sk` for backward compatibility with V1 adapters.
 */

interface DbElement {
  id: string
  presetId: string
  type: string
  name: string
  enabled: boolean
  customId: string | null
  customRendering: boolean
  clickEvent: unknown
  properties: unknown
  instances?: DbInstance[]
}

interface DbInstance {
  id: string
  elementId: string
  enabled: boolean
  customId: string | null
  customRendering: boolean
  position: unknown
  rotation: unknown
  scale: unknown
  clickEvent: unknown
  parentInstanceId: string | null
  withCollisions: boolean
  properties: unknown
}

interface DbPreset {
  id: string
  sceneId: string
  name: string
  locale: string | null
  elements?: DbElement[]
}

export interface SerializedPreset {
  sk: string
  name: string
  locale: string | null
  videos: SerializedElement[]
  images: SerializedElement[]
  sounds: SerializedElement[]
  models: SerializedElement[]
  nfts: SerializedElement[]
  widgets: SerializedElement[]
  claimPoints: SerializedElement[]
  adSpaces: SerializedElement[]
}

export interface SerializedElement {
  sk: string
  name: string
  enabled: boolean
  customId?: string
  customRendering: boolean
  clickEvent?: unknown
  instances: SerializedInstance[]
  [key: string]: unknown // flattened properties
}

export interface SerializedInstance {
  sk: string
  enabled: boolean
  customId?: string
  customRendering: boolean
  position: unknown
  rotation: unknown
  scale: unknown
  clickEvent?: unknown
  parent?: string
  withCollisions: boolean
  [key: string]: unknown
}

/**
 * A row's properties, with legacy nesting undone: an old dashboard relay bug stored
 * `{ properties: { … } }`. The nested object is unwrapped at read time; outer keys win.
 * (scripts/unwrap-nested-properties.mjs fixes stored rows the same way.)
 */
export function flatProperties(raw: unknown): Record<string, unknown> {
  const props = (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>
  const nested = props.properties
  if (!nested || typeof nested !== 'object' || Array.isArray(nested)) return props
  const { properties: _nested, ...rest } = props
  return { ...(nested as Record<string, unknown>), ...rest }
}

function serializeElement(element: DbElement): SerializedElement {
  const props = flatProperties(element.properties)
  return {
    sk: element.id,
    name: element.name,
    enabled: element.enabled,
    customId: element.customId || undefined,
    customRendering: element.customRendering,
    clickEvent: element.clickEvent || undefined,
    // Flatten type-specific properties to top level
    ...props,
    // Instances
    instances: (element.instances || []).map(serializeInstance),
  }
}

function serializeInstance(instance: DbInstance): SerializedInstance {
  const props = flatProperties(instance.properties)
  return {
    sk: instance.id,
    enabled: instance.enabled,
    customId: instance.customId || undefined,
    customRendering: instance.customRendering,
    position: instance.position || { x: 0, y: 0, z: 0 },
    rotation: instance.rotation || { x: 0, y: 0, z: 0 },
    scale: instance.scale || { x: 1, y: 1, z: 1 },
    clickEvent: instance.clickEvent || undefined,
    parent: instance.parentInstanceId || undefined,
    withCollisions: instance.withCollisions,
    ...props,
  }
}

export function serializePreset(preset: DbPreset): SerializedPreset {
  const elements = preset.elements || []

  const byType = (type: string) => elements.filter((e) => e.type === type).map(serializeElement)

  return {
    sk: preset.id,
    name: preset.name,
    locale: preset.locale,
    videos: byType('video'),
    images: byType('image'),
    sounds: byType('sound'),
    models: byType('model'),
    nfts: byType('nft'),
    widgets: byType('widget'),
    claimPoints: byType('claimpoint'),
    adSpaces: byType('ad_space'),
  }
}

/**
 * Serialize a single element for individual update messages.
 * Used when broadcasting create/update/delete for a single element.
 */
export function serializeSingleElement(element: DbElement): SerializedElement {
  return serializeElement(element)
}

export function serializeSingleInstance(instance: DbInstance): SerializedInstance {
  return serializeInstance(instance)
}
