/** The Terms of Service agreement in the web app. Mirrors GET /api/auth/terms. */
import { termsDateLabel } from '@virvixr/shared'

export interface TermsStatus {
  /** The version in force (TERMS_VERSION) */
  version: string
  accepted: boolean
  /** The last version this account agreed to, or null if it never agreed */
  acceptedVersion: string | null
}

/** What the agree screen says, or null when there's nothing to agree to (or the status hasn't loaded). */
export function termsGate(status: TermsStatus | null): { title: string; body: string } | null {
  if (!status || status.accepted) return null
  if (status.acceptedVersion) {
    return {
      title: 'Our Terms of Service have changed',
      body: `We updated our Terms of Service on ${termsDateLabel(status.version)}. To keep using Virvi, please read and agree to them.`,
    }
  }
  return { title: 'Agree to the Terms of Service', body: 'To keep using Virvi, please read and agree to our Terms of Service.' }
}
