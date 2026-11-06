import { describe, it, expect } from 'vitest'
import { wallToggleState, WALL_NEEDS_FINALIZE } from './wall'
import type { FinalizedRevision, StudioDetail, StudioPiece } from './studio'

const rev = (status: string): FinalizedRevision => ({
  revision: 1, kind: 'first', status, amountCents: 500, paymentId: 'p1', paidAt: null, report: null, reportableUntil: null,
})
const piece = (finalized: FinalizedRevision[]): StudioPiece => ({ id: 'x', category: 'hat', name: 'Hat', revision: null, renders: {}, finalized })
const detail = (pieces: StudioPiece[]) => ({ pieces }) as Pick<StudioDetail, 'pieces'>

describe('wallToggleState', () => {
  it('is off, with the reason, when nothing is finalized', () => {
    expect(wallToggleState(detail([]))).toEqual({ canShow: false, reason: 'Finalize this design to show it on the wall.' })
    expect(wallToggleState(detail([piece([])]))).toEqual({ canShow: false, reason: WALL_NEEDS_FINALIZE })
  })

  it('is off while the only finalized revisions are still packaging or failed', () => {
    expect(wallToggleState(detail([piece([rev('packaging'), rev('failed')])])).canShow).toBe(false)
  })

  it('is on with a ready finalized revision on any piece', () => {
    expect(wallToggleState(detail([piece([]), piece([rev('packaging'), rev('ready')])]))).toEqual({ canShow: true, reason: null })
  })
})
