import { describe, it, expect } from 'vitest'
import { agentPrompt } from './transparency'

describe('the AI agent prompt (LIV-165)', () => {
  const prompt = agentPrompt({ web: 'https://virvi.io', api: 'https://api.virvi.io' })
  it('covers wallets, contracts, privacy and the live commit, pointing at the real places', () => {
    expect(prompt).toContain('https://github.com/virvi-xr/virvi')
    expect(prompt).toMatch(/wallet/i)
    expect(prompt).toMatch(/contract/i)
    expect(prompt).toContain('https://virvi.io/privacy/')
    expect(prompt).toContain('https://api.virvi.io/api/transparency')
  })
  it('stays short enough for anyone to read before pasting', () => {
    expect(prompt.split(/\s+/).length).toBeLessThan(170)
  })
})
