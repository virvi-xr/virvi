/** What a click or hover target is called when nothing better is known. */
export const UNNAMED_TARGET = 'Unnamed object'

/** How many parents up we look for a Name before giving up. */
const MAX_PARENT_STEPS = 16

export interface TargetLookups {
  nameOf(entity: number): string | undefined
  parentOf(entity: number): number | undefined
  modelSrcOf(entity: number): string | undefined
}

/**
 * The label for an entity in analytics: its Name, else the nearest ancestor's Name, else the file name of its glTF
 * model, else a constant. Never the entity number, which changes between visits.
 */
export function resolveTargetLabel(entity: number, look: TargetLookups): string {
  let current: number | undefined = entity
  const seen = new Set<number>()
  for (let step = 0; current !== undefined && step <= MAX_PARENT_STEPS && !seen.has(current); step++) {
    seen.add(current)
    const name = look.nameOf(current)
    if (name) return name
    current = look.parentOf(current)
  }
  const file = look.modelSrcOf(entity)?.split(/[?#]/)[0].split('/').filter(Boolean).pop()
  return file || UNNAMED_TARGET
}
