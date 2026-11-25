import { signinPath } from './landing-route'
import { safeNextPath } from './next-path'

const CANCELLED = 'Sign-in was cancelled. You can try again.'
const FAILED = "We couldn't sign you in. Please try signing in again."

/** What the sign-in callback page says for the `?error=` the server (or the provider, through it) sent back. Never echoes the code. */
export function callbackErrorMessage(code: string | null): string {
  if (!code) return 'Missing authentication parameters. Please try signing in again.'
  switch (code) {
    case 'access_denied':
    case 'cancelled':
    case 'user_cancelled_authorize':
    case 'user_cancelled_login':
      return CANCELLED
    case 'oauth_failed':
      return FAILED
    case 'missing_code':
    case 'invalid_token':
    case 'token_exchange_failed':
    case 'user_fetch_failed':
      return "The sign-in didn't finish. Please try signing in again."
    default:
      return FAILED
  }
}

/** The "Back to login" link, keeping the safe `next` the person was heading to (the sign-in page stored it before leaving). */
export function callbackBackToLogin(storedNext: string | null): string {
  return signinPath(safeNextPath(storedNext))
}
