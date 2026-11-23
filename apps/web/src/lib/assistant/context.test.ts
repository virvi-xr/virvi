import { describe, it, expect } from 'vitest'
import { pageContext } from './context'

describe('pageContext', () => {
  it('reads the scene id on the scenes page', () => {
    expect(pageContext('/scenes/_', '?id=s1')).toEqual({ path: '/scenes/_', sceneId: 's1' })
    expect(pageContext('/scenes', '')).toEqual({ path: '/scenes' })
  })
  it('strips /demo and reads the event id', () => {
    expect(pageContext('/demo/events', '?id=e1')).toEqual({ path: '/events', eventId: 'e1' })
  })
  it('reads location and scene on analytics', () => {
    expect(pageContext('/analytics', '?location=l1&scene=s2')).toEqual({ path: '/analytics', locationId: 'l1', sceneId: 's2' })
  })
  it('reads scene on sync (and the old deploy path)', () => {
    expect(pageContext('/sync', '?scene=s3')).toEqual({ path: '/sync', sceneId: 's3' })
    expect(pageContext('/deploy', '?scene=s3')).toEqual({ path: '/deploy', sceneId: 's3' })
  })
  it('ignores ids on other pages', () => {
    expect(pageContext('/media', '?id=x&scene=y')).toEqual({ path: '/media' })
  })
})
