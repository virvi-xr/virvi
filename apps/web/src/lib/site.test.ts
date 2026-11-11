import { describe, it, expect } from 'vitest'
import { siteLinks } from './site'

describe('siteLinks', () => {
  it('privacy is the in-app page, docs and Discord come from config', () => {
    expect(siteLinks({ docs: 'https://docs.example/', discord: 'https://discord.gg/x' })).toEqual({ docs: 'https://docs.example/', privacy: '/privacy/', discord: 'https://discord.gg/x' })
  })

  it('leaves out docs and Discord when not configured, but always has privacy', () => {
    expect(siteLinks({})).toEqual({ docs: '/docs/', privacy: '/privacy/', discord: null })
  })
})
