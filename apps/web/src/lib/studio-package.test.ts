import { describe, it, expect } from 'vitest'
import { packageSummary } from './studio'

describe('packageSummary: what Finalize gives you', () => {
  it('a wearable piece: both body shapes for one price, and the files are yours', () => {
    const t = packageSummary('wearable')
    expect(t).toMatch(/male and female/)
    expect(t).toMatch(/one price/)
    expect(t).toMatch(/yours to edit, reuse and sell/)
  })
  it('an emote plays on both body shapes; a scene piece has no body shapes', () => {
    expect(packageSummary('emote')).toMatch(/plays on both body shapes/)
    expect(packageSummary('scene')).not.toMatch(/body shape/)
    expect(packageSummary('scene')).toMatch(/walk-through/)
    for (const k of ['emote', 'scene'] as const) expect(packageSummary(k)).toMatch(/yours to edit, reuse and sell/)
  })
})
