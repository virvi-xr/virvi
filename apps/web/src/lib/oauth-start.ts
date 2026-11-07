export type OAuthProvider = 'google' | 'discord'

/** A Google or Discord sign-in button: get the provider URL first, and only then remember where to come back to and
 *  leave, so a failed request leaves the page (and the stored destination) as it was. */
export async function startOAuth(provider: OAuthProvider, deps: {
  oauthUrl: (provider: OAuthProvider) => Promise<string>
  remember: () => void
  navigate: (url: string) => void
}): Promise<void> {
  const url = await deps.oauthUrl(provider)
  deps.remember()
  deps.navigate(url)
}
