/** The Virvi Launch Summit sign-up (virvi.io/summit): what the form sends and what the admin list shows. */

export type SummitJoinAs = 'online' | 'in_person' | 'watch_party'
export const SUMMIT_JOIN_AS: readonly SummitJoinAs[] = ['online', 'in_person', 'watch_party']

/** The seven offerings, in agenda order: the Creator track (Wednesday), then the Community track (Thursday). */
export type SummitInterest = 'studio' | 'sync' | 'ar' | 'events' | 'drops' | 'beat' | 'cities'
export const SUMMIT_INTERESTS: readonly SummitInterest[] = ['studio', 'sync', 'ar', 'events', 'drops', 'beat', 'cities']

export type SummitInPersonStatus = 'requested' | 'confirmed' | 'declined'
export const SUMMIT_IN_PERSON_STATUSES: readonly SummitInPersonStatus[] = ['requested', 'confirmed', 'declined']

export const SUMMIT_LIMITS = {
  maxText: 200,
  minPartySize: 1,
  maxPartySize: 4,
  minGuests: 1,
  maxGuests: 500,
} as const

/** The `bySource` key for sign-ups that came with no ref (outside the ref alphabet, so no ref can collide with it). */
export const SUMMIT_NO_SOURCE = '(direct)'

const REF = /^[a-z0-9_-]{1,40}$/

/** A `?ref=` value as stored: lowercased, `[a-z0-9_-]{1,40}`; undefined for anything else. */
export function summitRef(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined
  const ref = raw.trim().toLowerCase()
  return REF.test(ref) ? ref : undefined
}

export interface SummitSignupInput {
  email: string
  name: string
  joinAs: SummitJoinAs
  /** in_person only: 1–4, default 1. */
  partySize?: number
  /** watch_party only: required. */
  city?: string
  /** watch_party only: a whole number 1–500. */
  expectedGuests?: number
  interests?: SummitInterest[]
  /** From `?ref=`. */
  ref?: string
  consent: true
  /** Honeypot: people never fill it in. */
  nickname?: string
}

export type SummitSignupError =
  | 'invalid_email'
  | 'name_required'
  | 'invalid_join_as'
  | 'invalid_party_size'
  | 'city_required'
  | 'invalid_guests'
  | 'invalid_interest'
  | 'too_long'
  | 'consent_required'

export interface AdminSummitSignup {
  id: string
  email: string
  name: string
  joinAs: SummitJoinAs
  partySize: number | null
  city: string | null
  expectedGuests: number | null
  interests: SummitInterest[]
  source: string | null
  inPersonStatus: SummitInPersonStatus | null
  consentAt: string
  createdAt: string
  updatedAt: string
}

export interface AdminSummitTotals {
  byJoinAs: Record<SummitJoinAs, number>
  byInterest: Record<SummitInterest, number>
  /** Keyed by ref; sign-ups with none are under SUMMIT_NO_SOURCE. */
  bySource: Record<string, number>
  /** Party sizes summed over requested and confirmed in-person sign-ups. */
  inPersonPeople: number
}

export interface AdminSummitSignups {
  signups: AdminSummitSignup[]
  totals: AdminSummitTotals
}
