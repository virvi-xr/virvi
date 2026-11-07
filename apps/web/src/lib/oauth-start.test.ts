import { describe, expect, it } from 'vitest'
import { startOAuth } from './oauth-start'

describe('startOAuth (/signin Google and Discord buttons)', () => {
  it('asks for the provider URL, remembers where to come back to, then leaves for the provider', async () => {
    const log: string[] = []
    await startOAuth('google', {
      oauthUrl: async (p) => { log.push(`url:${p}`); return 'https://accounts.example/auth' },
      remember: () => { log.push('remember') },
      navigate: (u) => { log.push(`go:${u}`) },
    })
    expect(log).toEqual(['url:google', 'remember', 'go:https://accounts.example/auth'])
  })
  it('passes Discord through', async () => {
    const asked: string[] = []
    await startOAuth('discord', { oauthUrl: async (p) => { asked.push(p); return 'u' }, remember: () => {}, navigate: () => {} })
    expect(asked).toEqual(['discord'])
  })
  it("doesn't remember or leave when the URL can't be had", async () => {
    const log: string[] = []
    await expect(startOAuth('google', {
      oauthUrl: async () => { throw new Error('down') },
      remember: () => { log.push('remember') },
      navigate: () => { log.push('go') },
    })).rejects.toThrow('down')
    expect(log).toEqual([])
  })
})
