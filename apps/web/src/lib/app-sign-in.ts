/** The link that opens the Virvi app with the one-time sign-in code the website just made. */
export function appSignInRedirect(code: string): string {
  return `virvi://signed-in?code=${encodeURIComponent(code)}`
}

/** What to tell someone when the website could not make a sign-in code for the app. */
export function appHandoffErrorMessage(err: unknown): string {
  const status = err instanceof Error ? (err as Error & { status?: number }).status : (err as { status?: number } | null)?.status
  if (status === 401 || status === 403) return 'Sign in with an account to use the Virvi app. A trial or scene pass can’t sign in the app.'
  if (status === 429) return 'Too many tries. Wait a moment, then go back to the Virvi app and try again.'
  return 'Something went wrong. Go back to the Virvi app and try again.'
}
