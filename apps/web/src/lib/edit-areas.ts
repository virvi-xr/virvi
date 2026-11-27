import { checkEditArea, describeEditArea, type EditArea } from '@virvixr/shared'

export { describeEditArea, type EditArea }

/** The four fields of the area form, as typed. */
export interface AreaFields { minX: string; maxX: string; minZ: string; maxZ: string }

export const blankArea = (): AreaFields => ({ minX: '', maxX: '', minZ: '', maxZ: '' })
export const areaFields = (a: EditArea): AreaFields => ({ minX: String(a.minX), maxX: String(a.maxX), minZ: String(a.minZ), maxZ: String(a.maxZ) })

/** The area to send, or why it can't be: every field a number, each minimum below its maximum. */
export function areaFromFields(f: AreaFields): { ok: true; value: EditArea } | { ok: false; error: string } {
  const n = (v: string) => (v.trim() === '' ? NaN : Number(v))
  return checkEditArea({ minX: n(f.minX), maxX: n(f.maxX), minZ: n(f.minZ), maxZ: n(f.maxZ) })
}

/** The Roles list's line for an editor limited to an area. */
export const areaLine = (a: EditArea) => `Only inside ${describeEditArea(a)}`

/** The scene page's note for a tenant: where they can edit, and what they can't. */
export function tenantNote(areas: EditArea[]): string {
  if (!areas.length) return 'Your editor role is limited to an area that is no longer valid, so you can view this scene but not edit it. Ask the host to set your area again.'
  const where = areas.map(describeEditArea).join('; ')
  return `You can add, move and remove items inside your area (${where}). Changes elsewhere, presets and the scene's settings are for the host. In Decentraland, the HUD lets you edit there once the scene has Virvi's next update; until then, edit from this page.`
}
