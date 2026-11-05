/** Settings → Your Organizations (LIV-93): the shapes `/api/orgs` returns, and how a member is named. */

export type OrgRole = 'owner' | 'admin' | 'member'

/** An org you belong to, as GET /api/orgs and POST /api/orgs return it. */
export interface OrgSummary {
  id: string
  name: string
  slug: string
  logoUrl: string | null
  /** Your role in it. */
  role: OrgRole
  memberCount: number
  /** It's your active org. */
  isActive: boolean
}

/** A member as GET /api/orgs/:orgId/members returns it. */
export interface OrgMember {
  userId: string
  role: OrgRole
  joinedAt: string
  displayName: string
  email: string | null
  walletAddress: string | null
}

const shortWallet = (w: string) => (w.length > 12 ? `${w.slice(0, 6)}…${w.slice(-4)}` : w)

/** The member's display name, else email, else a shortened wallet, else "Unnamed member"; never the user id. "(you)" on your own row. */
export function memberLabel(m: OrgMember, myUserId?: string | null): string {
  const label = m.displayName?.trim() || m.email?.trim() || (m.walletAddress ? shortWallet(m.walletAddress) : '') || 'Unnamed member'
  return myUserId && m.userId === myUserId ? `${label} (you)` : label
}
