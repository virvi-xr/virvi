/**
 * The OAuth approval page (LIV-170): what an MCP client asks for in /oauth/authorize's query, checked before anything
 * is shown. The server checks it all again; this only decides what the page can say.
 */
export interface AuthorizeRequest {
  clientId: string
  redirectUri: string
  codeChallenge: string
  state: string | null
  /** 'read' when the app asked only to read; the person can still choose either. */
  scope: 'read' | 'full' | null
}

export function parseAuthorize(search: string): { ok: true; value: AuthorizeRequest } | { ok: false; error: string } {
  const q = new URLSearchParams(search)
  const clientId = q.get('client_id')
  const redirectUri = q.get('redirect_uri')
  const challenge = q.get('code_challenge')
  if (q.get('response_type') !== 'code') return { ok: false, error: 'This sign-in link is missing response_type=code.' }
  if (!clientId || !redirectUri) return { ok: false, error: 'This sign-in link is missing the app or where to send you back.' }
  if (q.get('code_challenge_method') !== 'S256' || !challenge) return { ok: false, error: "The app didn't send a PKCE challenge (S256), so Virvi can't connect it safely." }
  const scope = q.get('scope')
  return { ok: true, value: { clientId, redirectUri, codeChallenge: challenge, state: q.get('state'), scope: scope === 'read' ? 'read' : scope === 'full' ? 'full' : null } }
}

/** Where Deny sends the person: the app's own redirect with access_denied (only one the app registered). */
export function deniedRedirect(r: Pick<AuthorizeRequest, 'redirectUri' | 'state'>): string {
  const u = new URL(r.redirectUri)
  u.searchParams.set('error', 'access_denied')
  if (r.state) u.searchParams.set('state', r.state)
  return u.toString()
}

/** The host the app sends people back to, shown so a look-alike name gives itself away. */
export const redirectHost = (uri: string): string => {
  try { return new URL(uri).host } catch { return uri }
}
