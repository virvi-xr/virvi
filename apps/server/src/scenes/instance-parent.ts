import { eq } from 'drizzle-orm'
import { db } from '../db/connection.js'
import { sceneElementInstances } from '../db/schema.js'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
/** How far up a parent chain the loop check walks before calling it a loop. */
const MAX_DEPTH = 256

export type ParentCheck = { ok: true; parentInstanceId: string | null } | { ok: false; message: string }

/**
 * A copy's parent (LIV-138): another copy in the same preset (instances belong to a preset through their element),
 * never the copy itself or one of its own descendants. null, '' or undefined clear it. `selfId` is the copy being
 * updated (absent on create, where nothing can descend from it yet).
 */
export async function checkParentInstance(presetId: string, parent: unknown, selfId?: string): Promise<ParentCheck> {
  if (parent === null || parent === undefined || parent === '') return { ok: true, parentInstanceId: null }
  if (typeof parent !== 'string' || !UUID.test(parent)) return { ok: false, message: 'parentInstanceId must be an instance id' }
  if (parent === selfId) return { ok: false, message: 'An instance cannot be its own parent' }

  const seen = new Set<string>()
  let cursor: string | null = parent
  for (let depth = 0; cursor && depth < MAX_DEPTH; depth++) {
    if (seen.has(cursor)) break // a loop already stored above us; it doesn't pass through this copy
    seen.add(cursor)
    const row: { parentInstanceId: string | null; element: { presetId: string } } | undefined =
      await db.query.sceneElementInstances.findFirst({
        where: eq(sceneElementInstances.id, cursor),
        columns: { parentInstanceId: true },
        with: { element: { columns: { presetId: true } } },
      })
    if (depth === 0 && (!row || row.element.presetId !== presetId)) {
      return { ok: false, message: 'The parent instance must be in the same preset' }
    }
    if (!row) break // an older dangling parent further up; it can't lead back here
    if (row.parentInstanceId === selfId && selfId) return { ok: false, message: 'That parent would make a loop' }
    cursor = row.parentInstanceId
  }
  if (cursor && !seen.has(cursor)) return { ok: false, message: 'The parent chain is too deep' }
  return { ok: true, parentInstanceId: parent }
}
