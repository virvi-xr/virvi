/**
 * The World name of a destination or import row that deploys to a World. Genesis City parcels rows have none
 * (world_name is null), and the World paths never see them.
 */
export function worldOf(row: { worldName: string | null }): string {
  if (row.worldName === null) throw new Error('This row is a Genesis City parcels location, not a World')
  return row.worldName
}
