import { describe, it, expect } from 'vitest'
import { loadLayout } from './layout-fetch'

const err = (status: number) => Object.assign(new Error(`API error ${status}`), { status, body: {} })

describe('loading the layout under the heatmap', () => {
  it('returns the items, or null when the location has no linked scene', async () => {
    expect(await loadLayout(async () => ({ layout: { items: [] } }))).toEqual([])
    expect(await loadLayout(async () => ({ layout: null }))).toBeNull()
  })

  it('any failure, even 403 or 404 (an older server without the route), is just no layout, never a refusal', async () => {
    for (const status of [401, 403, 404, 500, 502]) {
      await expect(loadLayout(async () => { throw err(status) })).resolves.toBeNull()
    }
    await expect(loadLayout(async () => { throw new TypeError('Failed to fetch') })).resolves.toBeNull()
  })
})
