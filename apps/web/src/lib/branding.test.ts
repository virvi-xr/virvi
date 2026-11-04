import { describe, expect, it } from 'vitest'
import { brandTitle, brandingFileProblem, canManageBranding, hasCustomBrand } from './branding'
import { instanceLabel } from './instance'

describe('brandTitle', () => {
  it('swaps the Virvi suffix or bare title for the install name', () => {
    expect(brandTitle('Scenes · Virvi', 'Acme Events')).toBe('Scenes · Acme Events')
    expect(brandTitle('Virvi', 'Acme Events')).toBe('Acme Events')
  })
  it('leaves the title alone with no name, or once already branded', () => {
    expect(brandTitle('Scenes · Virvi', null)).toBe('Scenes · Virvi')
    expect(brandTitle('Scenes · Acme Events', 'Acme Events')).toBe('Scenes · Acme Events')
    expect(brandTitle('Virvi Drops', 'Acme')).toBe('Virvi Drops')
  })
})

describe('brandingFileProblem', () => {
  it('accepts PNG, WebP and SVG logos up to 512 KB', () => {
    for (const type of ['image/png', 'image/webp', 'image/svg+xml']) expect(brandingFileProblem({ size: 1000, type }, 'logo')).toBeNull()
    expect(brandingFileProblem({ size: 600 * 1024, type: 'image/png' }, 'logo')).toBe('The file is over 512 KB.')
    expect(brandingFileProblem({ size: 1000, type: 'image/jpeg' }, 'logo')).toBe('Use a PNG, WebP or SVG image.')
  })
  it('accepts only PNG favicons', () => {
    expect(brandingFileProblem({ size: 1000, type: 'image/png' }, 'favicon')).toBeNull()
    expect(brandingFileProblem({ size: 1000, type: 'image/webp' }, 'favicon')).toBe('Use a square PNG, at least 64 px.')
  })
})

describe('canManageBranding', () => {
  it('is for instance admins on self-hosted installs only', () => {
    expect(canManageBranding('single', 'admin')).toBe(true)
    expect(canManageBranding('scalable', 'admin')).toBe(true)
    expect(canManageBranding('cloud', 'admin')).toBe(false)
    expect(canManageBranding('single', 'creator')).toBe(false)
    expect(canManageBranding(undefined, 'admin')).toBe(false)
  })
})

describe('hasCustomBrand and the Powered by Virvi label', () => {
  it('a custom logo or name keeps Virvi attribution in the label', () => {
    expect(hasCustomBrand({ name: null, logoUrl: 'https://x/logo.png' })).toBe(true)
    expect(hasCustomBrand({ name: 'Acme', logoUrl: null })).toBe(true)
    expect(hasCustomBrand({ name: null, logoUrl: null })).toBe(false)
    expect(hasCustomBrand(null)).toBe(false)
    expect(instanceLabel('single', true)).toBe('Self-hosted · Powered by Virvi')
    expect(instanceLabel('scalable', true)).toBe('Self-hosted · Scalable · Powered by Virvi')
    expect(instanceLabel('cloud', true)).toBeNull()
  })
})
