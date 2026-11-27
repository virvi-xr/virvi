import { describeEditArea, type EditArea } from '@virvixr/shared'

/**
 * LIV-32: the Layout panel's line for a tenant (an editor limited to an area). Pure, so it is unit-tested; the
 * renderer shows it above the items.
 */
export function tenantAreaLine(areas: readonly EditArea[]): string {
  return `You can edit inside ${areas.map(describeEditArea).join('; ')}. Items with a copy elsewhere stay with the host.`
}
