/**
 * Area-limited editing (LIV-32, "tenants"): an editor wallet role can be limited to a box of the scene's floor, x and z
 * in metres in the scene's own coordinates (as copy positions are stored). Height is not limited. The server enforces
 * it; the dashboard and the HUDs use the same checks to explain a refusal. No URL or enum: the Decentraland runtime
 * and the Hyperfy bundle can import this.
 */

export interface EditArea {
  minX: number
  maxX: number
  minZ: number
  maxZ: number
}

/** Generous bound on any coordinate, in metres: far past any Decentraland or Hyperfy scene. */
export const EDIT_AREA_LIMIT = 100_000

export type EditAreaCheck = { ok: true; value: EditArea } | { ok: false; error: string }

const coord = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= EDIT_AREA_LIMIT ? Math.round(v * 100) / 100 : null

/** An area as sent, checked and rounded to the centimetre. */
export function checkEditArea(raw: unknown): EditAreaCheck {
  if (!raw || typeof raw !== 'object') return { ok: false, error: 'An area needs minX, maxX, minZ and maxZ in metres.' }
  const r = raw as Record<string, unknown>
  const [minX, maxX, minZ, maxZ] = [coord(r.minX), coord(r.maxX), coord(r.minZ), coord(r.maxZ)]
  if (minX === null || maxX === null || minZ === null || maxZ === null) return { ok: false, error: 'An area needs minX, maxX, minZ and maxZ in metres.' }
  if (minX >= maxX || minZ >= maxZ) return { ok: false, error: 'Each minimum must be smaller than its maximum.' }
  return { ok: true, value: { minX, maxX, minZ, maxZ } }
}

/** Whether a position (x, z; y is ignored) is inside the area, edges included. */
export function insideEditArea(area: EditArea, p: { x?: unknown; z?: unknown } | null | undefined): boolean {
  if (!p || typeof p.x !== 'number' || typeof p.z !== 'number' || !Number.isFinite(p.x) || !Number.isFinite(p.z)) return false
  return p.x >= area.minX && p.x <= area.maxX && p.z >= area.minZ && p.z <= area.maxZ
}

/** Inside any of the areas (one person can hold an area through two wallets). */
export function insideEditAreas(areas: readonly EditArea[], p: { x?: unknown; z?: unknown } | null | undefined): boolean {
  return areas.some((a) => insideEditArea(a, p))
}

const m = (n: number) => String(n)

/** "x 0 to 16, z -8 to 8" */
export function describeEditArea(a: EditArea): string {
  return `x ${m(a.minX)} to ${m(a.maxX)}, z ${m(a.minZ)} to ${m(a.maxZ)}`
}

/** Why a tenant's edit was refused. */
export function outsideAreaMessage(areas: readonly EditArea[]): string {
  return areas.length === 1
    ? `You can only edit inside your area: ${describeEditArea(areas[0])}.`
    : `You can only edit inside your areas: ${areas.map(describeEditArea).join('; ')}.`
}

export const OUTSIDE_AREA = 'outside_area'
