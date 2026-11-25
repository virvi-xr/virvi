/**
 * The link that opens the Virvi app with the one-time sign-in code the website just made: an https link on this site
 * (`origin`), which the app claims as a universal link. If the app doesn't open, the /app-signed-in page says to go back to it.
 */
export function appSignInRedirect(code: string, origin: string): string {
  return `${origin}/app-signed-in?code=${encodeURIComponent(code)}`
}

/** What /app-signed-in says when the universal link didn't open the app. It never shows the code. */
export const APP_SIGNED_IN_MESSAGE = 'Return to the Virvi app.'

/** What to tell someone when the website could not make a sign-in code for the app. */
export function appHandoffErrorMessage(err: unknown): string {
  const status = err instanceof Error ? (err as Error & { status?: number }).status : (err as { status?: number } | null)?.status
  if (status === 401 || status === 403) return 'Sign in with an account to use the Virvi app. A trial or scene pass can’t sign in the app.'
  if (status === 429) return 'Too many tries. Wait a moment, then go back to the Virvi app and try again.'
  return 'Something went wrong. Go back to the Virvi app and try again.'
}

/** For a wallet-only account, who can't use the browser hand-off: the app's own code sign-in, approved on a computer. */
export const APP_CODE_SIGN_IN_HINT = 'Use a wallet to sign in? Choose Sign in with a code in the Virvi app, then approve it at virvi.io/pair on a computer.'

/** Whether a sign-in's `next` is the app sign-in page (with or without the trailing slash or a query). */
export function isAppSignInNext(next: string | null | undefined): boolean {
  return !!next && /^\/app-sign-in\/?(?:[?#]|$)/.test(next)
}
