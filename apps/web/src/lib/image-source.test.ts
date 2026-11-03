import { describe, expect, it } from 'vitest'
import { imageSourceRow, pastedSource } from './image-source'

const upload = 'https://cdn.virvi.io/ef5b1c4e-0f6a-4a51-9a8e-2f1c3b4d5e6f/4728b7e8-bc44-4ebf-87db-459e003c7c3f.png'
const pasted = 'https://example.com/art/Off%20Air.png'

describe('imageSourceRow', () => {
  it('no image set shows no row', () => {
    expect(imageSourceRow('', null)).toBeNull()
    expect(imageSourceRow(undefined, null)).toBeNull()
  })
  it('a library image shows its name, with the full URL on hover', () => {
    expect(imageSourceRow(upload, { names: { [upload]: 'Off air card.png' }, missing: [] }))
      .toEqual({ label: 'Off air card.png', title: upload, missing: false })
  })
  it('a deleted upload shows "Missing image"', () => {
    expect(imageSourceRow(upload, { names: {}, missing: [upload] })).toEqual({ label: 'Missing image', title: upload, missing: true })
  })
  it("a pasted URL shows the URL's filename", () => {
    expect(imageSourceRow(pasted, { names: {}, missing: [] })?.label).toBe('Off Air.png')
  })
})

describe('pastedSource', () => {
  it('trims a pasted URL and ignores a blank one', () => {
    expect(pastedSource(`  ${pasted}\n`)).toBe(pasted)
    expect(pastedSource('   ')).toBeNull()
  })
})
