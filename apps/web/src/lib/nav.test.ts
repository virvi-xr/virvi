import { describe, expect, it } from 'vitest'
import { navActive } from './nav'

describe('navActive', () => {
  it('highlights Studio on scenes, designs and the import', () => {
    for (const p of ['/scenes', '/scenes/', '/scenes/new', '/studio', '/studio/', '/studio/abc/', '/import']) expect(navActive(p, '/scenes')).toBe(true)
  })
  it('highlights an item on its own pages only', () => {
    expect(navActive('/sync', '/sync')).toBe(true)
    expect(navActive('/sync/', '/sync')).toBe(true)
    expect(navActive('/drops', '/sync')).toBe(false)
    expect(navActive('/studio', '/sync')).toBe(false)
    expect(navActive('/ar-apps', '/ar')).toBe(false)
    expect(navActive('/demo/drops', '/demo/drops')).toBe(true)
    expect(navActive('/command-center', '/scenes')).toBe(false)
  })
})
