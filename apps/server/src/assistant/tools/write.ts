// Write tools: each wraps one route, and its `before` reads the current values first (through the user's own GET
// routes), so the write can be undone and its row names its organization.
import { z } from 'zod'
import { eq } from 'drizzle-orm'
import { db } from '../../db/connection.js'
import { organizations } from '../../db/schema.js'
import { inject, routeError } from './http.js'
import { id, pick } from './read.js'
import { ToolError, type Before, type Call, type ToolCtx, type ToolDef } from './types.js'

type Obj = Record<string, any>
const list = (v: unknown): Obj[] => (Array.isArray(v) ? v : [])

function write<A>(def: Omit<ToolDef<A>, 'effect'> & { before: NonNullable<ToolDef<A>['before']> }): ToolDef<A> {
  return { ...def, effect: 'write' }
}

/** GET `url` as the user; their refusal (403, 404) is the tool's. */
async function get(ctx: ToolCtx, url: string): Promise<Obj> {
  const res = await inject(ctx, { method: 'GET', url })
  if (res.status >= 400) throw new ToolError(res.status, routeError(res.status, res.json))
  return (res.json ?? {}) as Obj
}

/** The scene as the user sees it (presets → elements → instances), and its organization's name. */
async function sceneState(ctx: ToolCtx, sceneId: string): Promise<{ scene: Obj; orgName: string | null }> {
  const scene = ((await get(ctx, `/api/scenes/${sceneId}`)).scene ?? {}) as Obj
  let orgName: string | null = null
  if (scene.orgId) {
    const [org] = await db.select({ name: organizations.name }).from(organizations).where(eq(organizations.id, scene.orgId))
    orgName = org?.name ?? null
  }
  return { scene, orgName }
}

const presetIn = (scene: Obj, presetId: string): Obj => {
  const p = list(scene.presets).find((x) => x.id === presetId)
  if (!p) throw new ToolError(404, "That preset isn't in this scene.")
  return p
}
const elementIn = (scene: Obj, elementId: string): Obj => {
  for (const p of list(scene.presets)) for (const e of list(p.elements)) if (e.id === elementId) return e
  throw new ToolError(404, "That element isn't in this scene.")
}
const instanceIn = (scene: Obj, instanceId: string): Obj => {
  for (const p of list(scene.presets)) for (const e of list(p.elements)) for (const i of list(e.instances)) if (i.id === instanceId) return i
  throw new ToolError(404, "That instance isn't in this scene.")
}

/** The keys of `args` a write sets (everything but the ids that address it). */
const setKeys = (args: Obj, ids: string[]) => Object.keys(args).filter((k) => !ids.includes(k) && args[k] !== undefined)
/** `prev`'s values for `keys`, null where it had none: the body that puts them back. */
const previous = (prev: Obj, keys: string[]) => Object.fromEntries(keys.map((k) => [k, prev[k] ?? null]))
const fields = (o: unknown, keys: readonly string[]) => pick((o ?? {}) as Obj, keys)
const created = (res: unknown, key: string): Obj => (((res ?? {}) as Obj)[key] ?? {}) as Obj
const atLeastOne = (ids: string[]) => (a: Obj) => setKeys(a, ids).length > 0

const vec = z.object({ x: z.number(), y: z.number(), z: z.number() })
const props = z.record(z.string(), z.unknown())
const name = (max: number) => z.string().trim().min(1).max(max)
const recurrence = z.enum(['once', 'daily', 'weekly'])
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD')
const time = z.string().regex(/^\d{2}:\d{2}$/, 'HH:MM (24-hour)')
const weekdays = z.array(z.number().int().min(0).max(6))

const SCHEDULE_FIELDS = ['presetId', 'recurrence', 'startDate', 'startTime', 'weekdays', 'durationMinutes', 'timezone', 'returnToPresetId', 'enabled', 'eventId'] as const
const scheduleFields = {
  presetId: id(),
  recurrence,
  startDate: date,
  startTime: time,
  weekdays: weekdays.optional(),
  durationMinutes: z.number().int().min(1).nullable().optional(),
  timezone: z.string().min(1),
  returnToPresetId: id().nullable().optional(),
  enabled: z.boolean().optional(),
  eventId: id().nullable().optional(),
}

const SHOWING_FIELDS = ['id', 'title', 'description', 'posterUrl', 'items', 'enabled', 'eventId', 'recurrence', 'startDate', 'startTime', 'weekdays', 'timezone'] as const
const ELEMENT_TYPES = ['image', 'video', 'nft', 'sound', 'widget', 'model', 'custom', 'ad_space'] as const
const INSTANCE_FIELDS = ['position', 'rotation', 'scale', 'enabled'] as const

export const WRITE_TOOLS: ToolDef<any>[] = [
  write({
    name: 'update_scene',
    description: "Rename a scene or change its description.",
    input: z.object({ sceneId: id(), name: name(100).optional(), description: z.string().max(2000).nullable().optional() }).refine(atLeastOne(['sceneId']), 'Give a name or a description.'),
    call: (a) => ({ method: 'PUT', url: `/api/scenes/${a.sceneId}`, body: pick(a, setKeys(a, ['sceneId'])) }),
    before: async (a, ctx): Promise<Before> => {
      const { scene, orgName } = await sceneState(ctx, a.sceneId)
      const keys = setKeys(a, ['sceneId'])
      return { undo: { method: 'PUT', url: `/api/scenes/${a.sceneId}`, body: previous(scene, keys) }, after: (res) => fields(created(res, 'scene'), keys), orgName }
    },
    label: (a) => (a.name !== undefined ? `Rename scene to "${a.name}"${a.description !== undefined ? ' and change its description' : ''}` : "Change the scene's description"),
    summarize: (res) => fields(created(res, 'scene'), ['id', 'name', 'description']),
  }),
  write({
    name: 'create_preset',
    description: 'Add a preset to a scene: blank, or a copy of one of its presets (fromPresetId). It does not go live.',
    input: z.object({ sceneId: id(), name: name(100), fromPresetId: id().optional() }),
    call: (a) => ({ method: 'POST', url: `/api/scenes/${a.sceneId}/presets`, body: pick(a, ['name', 'fromPresetId']) }),
    before: async (a, ctx) => {
      const { orgName } = await sceneState(ctx, a.sceneId)
      return { undo: (res) => ({ method: 'DELETE', url: `/api/presets/${created(res, 'preset').id}` }), after: (res) => fields(created(res, 'preset'), ['id', 'name']), orgName }
    },
    label: (a) => `Add preset "${a.name}"`,
    summarize: (res) => fields(created(res, 'preset'), ['id', 'name', 'sceneId']),
  }),
  write({
    name: 'rename_preset',
    description: "Rename one of a scene's presets.",
    input: z.object({ sceneId: id(), presetId: id(), name: name(100) }),
    call: (a) => ({ method: 'PATCH', url: `/api/presets/${a.presetId}`, body: { name: a.name } }),
    before: async (a, ctx) => {
      const { scene, orgName } = await sceneState(ctx, a.sceneId)
      const preset = presetIn(scene, a.presetId)
      return { undo: { method: 'PATCH', url: `/api/presets/${a.presetId}`, body: { name: preset.name } }, after: (res) => fields(created(res, 'preset'), ['name']), orgName }
    },
    label: (a) => `Rename preset to "${a.name}"`,
    summarize: (res) => fields(created(res, 'preset'), ['id', 'name']),
  }),
  write({
    name: 'activate_preset',
    description: "Make one of a scene's presets the live one: everyone in the scene sees it straight away.",
    input: z.object({ sceneId: id(), presetId: id() }),
    call: (a) => ({ method: 'POST', url: `/api/presets/${a.presetId}/activate` }),
    before: async (a, ctx) => {
      const { scene, orgName } = await sceneState(ctx, a.sceneId)
      presetIn(scene, a.presetId)
      const prev = (scene.activePresetId ?? null) as string | null
      const undo: Call | null =
        prev === a.presetId ? null
        : prev ? { method: 'POST', url: `/api/presets/${prev}/activate` }
        : { method: 'PUT', url: `/api/scenes/${a.sceneId}`, body: { activePresetId: null } }
      return { undo, after: (res) => fields(res, ['activePresetId']), orgName }
    },
    label: () => 'Switch the live preset',
    summarize: (res) => res,
  }),
  write({
    name: 'create_element',
    description: "Add an element (a video screen, image, sound, 3D model, widget…) to one of a scene's presets. It has no placement until add_instance.",
    input: z.object({ sceneId: id(), presetId: id(), type: z.enum(ELEMENT_TYPES), name: name(200), enabled: z.boolean().optional(), properties: props.optional() }),
    call: (a) => ({ method: 'POST', url: `/api/presets/${a.presetId}/elements`, body: pick(a, ['type', 'name', 'enabled', 'properties']) }),
    before: async (a, ctx) => {
      const { scene, orgName } = await sceneState(ctx, a.sceneId)
      presetIn(scene, a.presetId)
      return {
        undo: (res) => ({ method: 'DELETE', url: `/api/elements/${created(res, 'element').id}` }),
        after: (res) => fields(created(res, 'element'), ['id', 'type', 'name', 'enabled', 'properties']),
        orgName,
      }
    },
    label: (a) => `Add ${a.type.replace('_', ' ')} "${a.name}"`,
    summarize: (res) => fields(created(res, 'element'), ['id', 'type', 'name', 'enabled', 'properties']),
  }),
  write({
    name: 'update_element',
    description:
      "Change an element: its name, whether it shows (enabled), or some of its properties. `properties` is merged into the element's current properties, so send only the ones that change (a screen's liveSrc, playlist, offImageSrc; an image's textureSrc…).",
    input: z.object({ sceneId: id(), elementId: id(), name: name(200).optional(), enabled: z.boolean().optional(), properties: props.optional() }).refine(atLeastOne(['sceneId', 'elementId']), 'Give something to change.'),
    // The PUT replaces properties whole: the partial ones go over the element's current ones
    call: async (a, ctx) => {
      const body: Obj = pick(a, setKeys(a, ['sceneId', 'elementId', 'properties']))
      if (a.properties) body.properties = { ...(elementIn((await sceneState(ctx, a.sceneId)).scene, a.elementId).properties ?? {}), ...a.properties }
      return { method: 'PUT', url: `/api/elements/${a.elementId}`, body }
    },
    before: async (a, ctx) => {
      const { scene, orgName } = await sceneState(ctx, a.sceneId)
      const el = elementIn(scene, a.elementId)
      return {
        undo: { method: 'PUT', url: `/api/elements/${a.elementId}`, body: { name: el.name, enabled: el.enabled, properties: el.properties ?? {} } },
        after: (res) => fields(created(res, 'element'), setKeys(a, ['sceneId', 'elementId'])),
        orgName,
      }
    },
    label: (a) => {
      if (a.name !== undefined) return `Rename element to "${a.name}"`
      if (a.properties === undefined) return a.enabled ? 'Show the element' : 'Hide the element'
      return 'Update the element'
    },
    summarize: (res) => fields(created(res, 'element'), ['id', 'type', 'name', 'enabled', 'properties']),
  }),
  write({
    name: 'set_element_live',
    description: "Turn a video screen's live stream on or off (it plays its liveSrc when on).",
    input: z.object({ sceneId: id(), elementId: id(), enabled: z.boolean() }),
    call: (a) => ({ method: 'POST', url: `/api/elements/${a.elementId}/live`, body: { enabled: a.enabled } }),
    before: async (a, ctx) => {
      const { scene, orgName } = await sceneState(ctx, a.sceneId)
      const el = elementIn(scene, a.elementId)
      return {
        undo: { method: 'POST', url: `/api/elements/${a.elementId}/live`, body: { enabled: !!el.properties?.enableLiveStream } },
        after: (res) => ({ enableLiveStream: created(res, 'element').properties?.enableLiveStream ?? null }),
        orgName,
      }
    },
    label: (a) => (a.enabled ? 'Turn the live stream on' : 'Turn the live stream off'),
    summarize: (res) => fields(created(res, 'element'), ['id', 'name', 'properties']),
  }),
  write({
    name: 'add_instance',
    description: 'Place an element in the scene (an instance), at a position, rotation and scale in metres and degrees.',
    input: z.object({ sceneId: id(), elementId: id(), position: vec.optional(), rotation: vec.optional(), scale: vec.optional(), enabled: z.boolean().optional() }),
    call: (a) => ({ method: 'POST', url: `/api/elements/${a.elementId}/instances`, body: pick(a, INSTANCE_FIELDS) }),
    before: async (a, ctx) => {
      const { scene, orgName } = await sceneState(ctx, a.sceneId)
      elementIn(scene, a.elementId)
      return {
        undo: (res) => ({ method: 'DELETE', url: `/api/instances/${created(res, 'instance').id}` }),
        after: (res) => fields(created(res, 'instance'), ['id', ...INSTANCE_FIELDS]),
        orgName,
      }
    },
    label: () => 'Place the element',
    summarize: (res) => fields(created(res, 'instance'), ['id', 'elementId', ...INSTANCE_FIELDS]),
  }),
  write({
    name: 'update_instance',
    description: "Move, turn, resize, show or hide one placement (instance) of an element.",
    input: z.object({ sceneId: id(), instanceId: id(), position: vec.optional(), rotation: vec.optional(), scale: vec.optional(), enabled: z.boolean().optional() }).refine(atLeastOne(['sceneId', 'instanceId']), 'Give something to change.'),
    call: (a) => ({ method: 'PUT', url: `/api/instances/${a.instanceId}`, body: pick(a, INSTANCE_FIELDS) }),
    before: async (a, ctx) => {
      const { scene, orgName } = await sceneState(ctx, a.sceneId)
      const inst = instanceIn(scene, a.instanceId)
      const keys = setKeys(a, ['sceneId', 'instanceId'])
      return { undo: { method: 'PUT', url: `/api/instances/${a.instanceId}`, body: previous(inst, keys) }, after: (res) => fields(created(res, 'instance'), keys), orgName }
    },
    label: () => 'Update a placement',
    summarize: (res) => fields(created(res, 'instance'), ['id', 'elementId', ...INSTANCE_FIELDS]),
  }),
  write({
    name: 'create_preset_schedule',
    description:
      'Schedule one of a scene\'s presets to go live: once, daily or weekly (weekdays 0 = Sunday), from startDate at startTime in timezone (IANA). durationMinutes then returnToPresetId, or null to stay live until the next switch.',
    input: z.object({ sceneId: id(), ...scheduleFields }),
    call: (a) => ({ method: 'POST', url: `/api/scenes/${a.sceneId}/preset-schedules`, body: pick(a, SCHEDULE_FIELDS) }),
    before: async (a, ctx) => {
      const { scene, orgName } = await sceneState(ctx, a.sceneId)
      presetIn(scene, a.presetId)
      return {
        undo: (res) => ({ method: 'DELETE', url: `/api/preset-schedules/${created(res, 'schedule').id}` }),
        after: (res) => fields(created(res, 'schedule'), ['id', ...SCHEDULE_FIELDS]),
        orgName,
      }
    },
    label: (a) => `Schedule a preset (${a.recurrence}, from ${a.startDate} at ${a.startTime} ${a.timezone})`,
    summarize: (res) => fields(created(res, 'schedule'), ['id', ...SCHEDULE_FIELDS, 'nextRuns']),
  }),
  write({
    name: 'update_preset_schedule',
    description: "Change a scene's preset schedule: only the fields given change. enabled false pauses it.",
    input: z
      .object({ sceneId: id(), scheduleId: id(), ...Object.fromEntries(Object.entries(scheduleFields).map(([k, v]) => [k, v.optional()])) })
      .refine(atLeastOne(['sceneId', 'scheduleId']), 'Give something to change.'),
    call: (a) => ({ method: 'PATCH', url: `/api/preset-schedules/${a.scheduleId}`, body: pick(a, setKeys(a, ['sceneId', 'scheduleId'])) }),
    before: async (a, ctx) => {
      const { orgName } = await sceneState(ctx, a.sceneId)
      const schedule = list((await get(ctx, `/api/scenes/${a.sceneId}/preset-schedules`)).schedules).find((s) => s.id === a.scheduleId)
      if (!schedule) throw new ToolError(404, "That schedule isn't in this scene.")
      const keys = setKeys(a, ['sceneId', 'scheduleId'])
      return { undo: { method: 'PATCH', url: `/api/preset-schedules/${a.scheduleId}`, body: previous(schedule, keys) }, after: (res) => fields(created(res, 'schedule'), keys), orgName }
    },
    label: (a: Obj) => (a.enabled === false && setKeys(a, ['sceneId', 'scheduleId']).length === 1 ? 'Pause a preset schedule' : 'Change a preset schedule'),
    summarize: (res) => fields(created(res, 'schedule'), ['id', ...SCHEDULE_FIELDS, 'nextRuns']),
  }),
  write({
    name: 'add_to_library',
    description: "Add one of the user's own files to a scene's library: an image or video (mediaAssetId, from list_media) or a 3D model (assetItemId).",
    input: z.object({ sceneId: id(), mediaAssetId: id().optional(), assetItemId: id().optional() }).refine((a) => !!a.mediaAssetId !== !!a.assetItemId, 'Give exactly one of mediaAssetId or assetItemId.'),
    call: (a) => ({ method: 'POST', url: `/api/scenes/${a.sceneId}/library`, body: pick(a, ['mediaAssetId', 'assetItemId']) }),
    before: async (a, ctx) => {
      const { orgName } = await sceneState(ctx, a.sceneId)
      const had = new Set(list((await get(ctx, `/api/scenes/${a.sceneId}/library`)).items).map((i) => i.id))
      const linkId = (res: unknown) => ((res ?? {}) as Obj).id as string
      // A file already in the library comes back with its existing link: nothing to undo then
      return {
        undo: (res) => (had.has(linkId(res)) ? null : { method: 'DELETE', url: `/api/scenes/${a.sceneId}/library/${linkId(res)}` }),
        after: (res) => ({ id: linkId(res) }),
        orgName,
      }
    },
    label: () => "Add a file to the scene's library",
    summarize: (res) => res,
  }),
  write({
    name: 'rename_library_item',
    description: "Rename a file in a scene's library (its extension is kept).",
    input: z.object({ sceneId: id(), itemId: id(), name: name(120) }),
    call: (a) => ({ method: 'PATCH', url: `/api/scenes/${a.sceneId}/library/${a.itemId}`, body: { name: a.name } }),
    before: async (a, ctx) => {
      const { orgName } = await sceneState(ctx, a.sceneId)
      const item = list((await get(ctx, `/api/scenes/${a.sceneId}/library`)).items).find((i) => i.id === a.itemId)
      if (!item) throw new ToolError(404, "That file isn't in this scene's library.")
      return { undo: { method: 'PATCH', url: `/api/scenes/${a.sceneId}/library/${a.itemId}`, body: { name: item.name } }, after: (res) => fields(created(res, 'item'), ['name']), orgName }
    },
    label: (a) => `Rename file to "${a.name}"`,
    summarize: (res) => fields(created(res, 'item'), ['id', 'kind', 'name', 'url']),
  }),
  write({
    name: 'create_showing',
    description:
      'Schedule a showing on a video screen: a programme of videos (items; a duration in seconds is needed for videos not uploaded to Images & Video) that plays once, daily or weekly from startDate at startTime in timezone.',
    input: z.object({
      sceneId: id(),
      elementId: id(),
      title: z.string().max(200).optional(),
      description: z.string().max(2000).optional(),
      items: z.array(z.object({ url: z.url({ protocol: /^https?$/ }), kind: z.enum(['video', 'ad']).optional(), duration: z.number().positive().optional() })).min(1),
      recurrence,
      startDate: date,
      startTime: time,
      weekdays: weekdays.optional(),
      timezone: z.string().min(1),
      enabled: z.boolean().optional(),
      eventId: id().optional(),
    }),
    call: (a) => ({ method: 'POST', url: `/api/elements/${a.elementId}/showings`, body: pick(a, SHOWING_FIELDS) }),
    before: async (a, ctx) => {
      const { scene, orgName } = await sceneState(ctx, a.sceneId)
      elementIn(scene, a.elementId)
      return {
        undo: (res) => ({ method: 'DELETE', url: `/api/showings/${created(res, 'showing').id}` }),
        after: (res) => fields(created(res, 'showing'), SHOWING_FIELDS),
        orgName,
      }
    },
    label: (a) => `Schedule showing "${a.title ?? 'Untitled'}"`,
    summarize: (res) => fields(created(res, 'showing'), [...SHOWING_FIELDS, 'lengthSeconds', 'nextStarts']),
  }),
]
