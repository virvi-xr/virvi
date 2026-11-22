import { summitRef, type AdminSummitSignup, type SummitInterest, type SummitJoinAs, type SummitSignupInput } from '@virvixr/shared'
import { API_URL } from './config'

export interface SummitOffering { id: SummitInterest; name: string; session: string; blurb: string }
export interface SummitTrack {
  id: 'creator' | 'community'
  name: string
  /** "Wed 3 Feb" */
  shortDay: string
  /** "Wednesday 3 February" */
  day: string
  description: string
  offerings: SummitOffering[]
  /** Times are EST. Breaks are left out. */
  agenda: { time: string; title: string }[]
}

/** The Summit's two days as two tracks: what launches on each, and its agenda. The page, the form and the admin list read them from here. */
export const SUMMIT_TRACKS: SummitTrack[] = [
  {
    id: 'creator',
    name: 'Creator track',
    shortDay: 'Wed 3 Feb',
    day: 'Wednesday 3 February',
    description: 'Make things with AI, run one scene in every world, and step into it in AR.',
    offerings: [
      { id: 'studio', name: 'Virvi Studio', session: 'Wed 3 Feb · 13:15', blurb: 'AI-built wearables, emotes, buildings and furniture. We build them live from your ideas.' },
      { id: 'sync', name: 'Virvi Sync', session: 'Wed 3 Feb · 14:30', blurb: 'One scene, every world. The Decentraland, Creator Hub, Hyperfy, Quest and Vision Pro HUDs.' },
      { id: 'ar', name: 'Virvi AR', session: 'Wed 3 Feb · 15:45', blurb: 'Step into a scene in the real studio.' },
    ],
    agenda: [
      { time: '11:30', title: 'Worlds open' },
      { time: '12:00', title: 'Keynote: Create once. Live everywhere.' },
      { time: '13:15', title: 'Virvi Studio' },
      { time: '14:30', title: 'Virvi Sync' },
      { time: '15:45', title: 'Virvi AR' },
      { time: '16:45', title: 'Day 1 wrap' },
    ],
  },
  {
    id: 'community',
    name: 'Community track',
    shortDay: 'Thu 4 Feb',
    day: 'Thursday 4 February',
    description: 'Bring people together, give them something to keep, and find your city.',
    offerings: [
      { id: 'events', name: 'Virvi Events', session: 'Thu 4 Feb · 10:15', blurb: 'Venues, live streams on screens, and raffles.' },
      { id: 'drops', name: 'Virvi Drops', session: 'Thu 4 Feb · 10:15', blurb: 'Giveaways and rewards for showing up.' },
      { id: 'beat', name: 'Virvi BEAT', session: 'Thu 4 Feb · 11:30', blurb: 'Attendance tokens for any event. Everyone claims one live.' },
      { id: 'cities', name: 'Virvi Cities', session: 'Thu 4 Feb · 13:30', blurb: 'What’s coming.' },
    ],
    agenda: [
      { time: '10:00', title: 'Recap' },
      { time: '10:15', title: 'Virvi Events & Drops' },
      { time: '11:30', title: 'Virvi BEAT' },
      { time: '13:30', title: 'Virvi Cities' },
      { time: '14:30', title: 'Closing: the roadmap, Q&A and the final Drop' },
    ],
  },
]

/** The seven offerings, in interest order. */
export const SUMMIT_OFFERINGS: SummitOffering[] = SUMMIT_TRACKS.flatMap((t) => t.offerings)

export const JOIN_AS_LABELS: Record<SummitJoinAs, string> = { online: 'Online', in_person: 'In person', watch_party: 'Watch party' }

const CODE_MESSAGES: Record<string, string> = {
  invalid_email: 'Please enter a valid email address.',
  name_required: 'Please enter your name.',
  invalid_join_as: 'Please choose how you’ll join.',
  invalid_party_size: 'You can bring a party of 1 to 4.',
  city_required: 'Please tell us the city of your watch party.',
  invalid_guests: 'Expected guests must be a whole number from 1 to 500.',
  invalid_interest: 'Please pick from the listed sessions.',
  too_long: 'One of the fields is too long.',
  consent_required: 'Please tick the box so we can email you.',
}

/** What to tell a visitor when the sign-up fails. `status` is null when the request never reached Virvi. */
export function summitErrorMessage(status: number | null, code?: string): string {
  if (status === null) return 'We couldn’t reach Virvi. Please try again.'
  if (status === 429) return 'Too many tries. Please try again later.'
  if (status === 400 && code && CODE_MESSAGES[code]) return CODE_MESSAGES[code]
  return 'Something went wrong. Please try again.'
}

/** The `?ref=` of a location.search, if it is a valid ref. */
export function summitRefFromSearch(search: string): string | undefined {
  return summitRef(new URLSearchParams(search).get('ref') ?? undefined)
}

export interface SummitFormState {
  email: string
  name: string
  joinAs: SummitJoinAs | ''
  partySize: string
  city: string
  expectedGuests: string
  interests: SummitInterest[]
  nickname: string
}

export const EMPTY_SUMMIT_FORM: SummitFormState = { email: '', name: '', joinAs: '', partySize: '1', city: '', expectedGuests: '', interests: [], nickname: '' }

/** The request body for a filled-in form: only the details of the chosen way to join. Consent is the ticked box. */
export function signupFromForm(form: SummitFormState, ref?: string): SummitSignupInput {
  const out: SummitSignupInput = {
    email: form.email.trim(),
    name: form.name.trim(),
    joinAs: form.joinAs as SummitJoinAs,
    interests: form.interests,
    consent: true,
    nickname: form.nickname,
  }
  if (form.joinAs === 'in_person') out.partySize = Number(form.partySize)
  if (form.joinAs === 'watch_party') {
    out.city = form.city.trim()
    if (form.expectedGuests.trim() !== '') out.expectedGuests = Number(form.expectedGuests)
  }
  if (ref) out.ref = ref
  return out
}

/** The line under "You’re on the list." */
export function summitDoneLine(joinAs: SummitJoinAs): string {
  if (joinAs === 'in_person') return 'We’ll email you to confirm your place.'
  if (joinAs === 'watch_party') return 'We’ll email you the host kit.'
  return 'We’ll email you the links before the day.'
}

/** Send the sign-up form. Public: no credentials. Throws an Error whose message is ready to show. */
export async function submitSummitSignup(input: SummitSignupInput, fetchImpl: typeof fetch = fetch): Promise<void> {
  let res: Response
  try {
    res = await fetchImpl(`${API_URL}/api/summit/signups`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    })
  } catch {
    throw new Error(summitErrorMessage(null))
  }
  if (res.ok) return
  const body = await res.json().catch(() => null)
  throw new Error(summitErrorMessage(res.status, body?.error))
}

/** One CSV cell: a leading = + - @ gets a ' so a spreadsheet never runs it; commas, quotes and line breaks are quoted. */
function cell(value: string | number | null): string {
  let s = value === null ? '' : String(value)
  if (/^[=+\-@]/.test(s)) s = `'${s}`
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

/** The admin list as CSV, built in the browser. */
export function signupsCsv(signups: AdminSummitSignup[]): string {
  const header = ['Name', 'Email', 'How', 'Party size', 'In-person status', 'City', 'Expected guests', 'Interests', 'Source', 'Signed up']
  const lines = signups.map((s) =>
    [s.name, s.email, JOIN_AS_LABELS[s.joinAs], s.partySize, s.inPersonStatus, s.city, s.expectedGuests, s.interests.join(' '), s.source, s.createdAt].map(cell).join(','),
  )
  return [header.join(','), ...lines].join('\r\n')
}
