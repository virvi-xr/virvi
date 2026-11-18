/** Email verification in the web app (LIV-161). Mirrors GET /api/auth/email. */
export interface EmailStatus {
  email: string | null
  verified: boolean
  /** When another link may be sent; null when one may be sent now. */
  nextResendAt: string | null
}

/** The banner asks only an account with an unconfirmed email, and only until they close it. */
export function showVerifyBanner(status: EmailStatus | null, dismissed: boolean): boolean {
  return !!status?.email && !status.verified && !dismissed
}

/** Seconds until another link may be sent (0 when it may be sent now). */
export function resendWaitSec(status: EmailStatus | null, now = Date.now()): number {
  if (!status?.nextResendAt) return 0
  return Math.max(0, Math.ceil((new Date(status.nextResendAt).getTime() - now) / 1000))
}

/** "in 42 s", "in 3 min", "in 5 h": when the resend button works again. */
export function waitLabel(sec: number): string {
  if (sec < 60) return `in ${sec} s`
  if (sec < 3600) return `in ${Math.ceil(sec / 60)} min`
  return `in ${Math.ceil(sec / 3600)} h`
}

/** What a failed link says, by the server's code. */
export function verifyErrorText(code: string | undefined): string {
  switch (code) {
    case 'used_link': return 'This link has already been used. If your email shows as not confirmed, send a new link from Settings.'
    case 'expired_link': return 'This link has expired. Send a new one from Settings.'
    case 'email_changed': return 'This link is for an email address your account no longer uses.'
    default: return "This link isn't valid. Send a new one from Settings."
  }
}

export const bannerKey = (userId: string) => `virvi:verify-email-dismissed:${userId}`
