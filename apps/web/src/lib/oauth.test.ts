import { describe, expect, it } from 'vitest'
import { deniedRedirect, parseAuthorize, redirectHost } from './oauth'

describe('OAuth approval page (LIV-170)', () => {
  const ok = '?response_type=code&client_id=vc_1&redirect_uri=https%3A%2F%2Fclaude.ai%2Fcb&code_challenge=abc&code_challenge_method=S256&state=s1&scope=read'
  it('reads a well-formed request', () => {
    expect(parseAuthorize(ok)).toEqual({ ok: true, value: { clientId: 'vc_1', redirectUri: 'https://claude.ai/cb', codeChallenge: 'abc', state: 's1', scope: 'read' } })
  })
  it('refuses a request without PKCE S256, a code response or a redirect', () => {
    expect(parseAuthorize(ok.replace('S256', 'plain')).ok).toBe(false)
    expect(parseAuthorize(ok.replace('response_type=code', 'response_type=token')).ok).toBe(false)
    expect(parseAuthorize('?response_type=code&client_id=vc_1').ok).toBe(false)
  })
  it("Deny goes back to the app's own redirect with access_denied and its state", () => {
    expect(deniedRedirect({ redirectUri: 'https://claude.ai/cb?x=1', state: 's1' })).toBe('https://claude.ai/cb?x=1&error=access_denied&state=s1')
    expect(redirectHost('https://claude.ai/cb')).toBe('claude.ai')
  })
})
