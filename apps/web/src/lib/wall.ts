import type { StudioDetail } from './studio'

export const WALL_NEEDS_FINALIZE = 'Finalize this design to show it on the wall.'
export const WALL_BAD_LINK = 'Use a link to decentraland.org.'

/** The wall checkbox is on offer once a piece has a finalized revision whose package is ready. */
export function wallToggleState(detail: Pick<StudioDetail, 'pieces'>): { canShow: boolean; reason: string | null } {
  const finalized = detail.pieces.some((p) => p.finalized.some((f) => f.status === 'ready'))
  return finalized ? { canShow: true, reason: null } : { canShow: false, reason: WALL_NEEDS_FINALIZE }
}
