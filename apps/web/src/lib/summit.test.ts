import { describe, it, expect } from 'vitest'
import type { AdminSummitSignup } from '@virvixr/shared'
import { API_URL } from './config'
import { signupFromForm, signupsCsv, submitSummitSignup, summitDoneLine, summitErrorMessage, summitRefFromSearch } from './summit'

describe('summitErrorMessage', () => {
  it('words each failure for a person', () => {
    expect(summitErrorMessage(429)).toBe('Too many tries. Please try again later.')
    expect(summitErrorMessage(400, 'invalid_email')).toBe('Please enter a valid email address.')
    expect(summitErrorMessage(400, 'name_required')).toBe('Please enter your name.')
    expect(summitErrorMessage(400, 'invalid_join_as')).toBe('Please choose how you’ll join.')
    expect(summitErrorMessage(400, 'invalid_party_size')).toBe('You can bring a party of 1 to 4.')
    expect(summitErrorMessage(400, 'city_required')).toBe('Please tell us the city of your watch party.')
    expect(summitErrorMessage(400, 'invalid_guests')).toBe('Expected guests must be a whole number from 1 to 500.')
    expect(summitErrorMessage(400, 'invalid_interest')).toBe('Please pick from the listed sessions.')
    expect(summitErrorMessage(400, 'too_long')).toBe('One of the fields is too long.')
    expect(summitErrorMessage(400, 'consent_required')).toBe('Please tick the box so we can email you.')
    expect(summitErrorMessage(null)).toBe('We couldn’t reach Virvi. Please try again.')
    expect(summitErrorMessage(500)).toBe('Something went wrong. Please try again.')
  })
})

describe('summitRefFromSearch', () => {
  it('reads a valid ?ref=, lowercased, and ignores anything else', () => {
    expect(summitRefFromSearch('?ref=Discord_1')).toBe('discord_1')
    expect(summitRefFromSearch('?a=1&ref=x-y')).toBe('x-y')
    expect(summitRefFromSearch('?ref=bad%20ref')).toBeUndefined()
    expect(summitRefFromSearch(`?ref=${'a'.repeat(41)}`)).toBeUndefined()
    expect(summitRefFromSearch('')).toBeUndefined()
  })
})

describe('signupFromForm', () => {
  const form = { email: ' ana@example.com ', name: ' Ana ', joinAs: 'online' as const, partySize: '2', city: 'Lisbon', expectedGuests: '30', interests: ['drops' as const], nickname: '' }

  it('sends only the details of the chosen way to join', () => {
    expect(signupFromForm(form, 'x')).toEqual({ email: 'ana@example.com', name: 'Ana', joinAs: 'online', interests: ['drops'], ref: 'x', consent: true, nickname: '' })
    expect(signupFromForm({ ...form, joinAs: 'in_person' })).toMatchObject({ joinAs: 'in_person', partySize: 2 })
    expect(signupFromForm({ ...form, joinAs: 'in_person' })).not.toHaveProperty('city')
    expect(signupFromForm({ ...form, joinAs: 'watch_party' })).toMatchObject({ joinAs: 'watch_party', city: 'Lisbon', expectedGuests: 30 })
    expect(signupFromForm({ ...form, joinAs: 'watch_party' })).not.toHaveProperty('partySize')
  })

  it('leaves out blank guests and a missing ref; a typed non-number reaches the server to be refused', () => {
    const out = signupFromForm({ ...form, joinAs: 'watch_party', expectedGuests: '' })
    expect(out).not.toHaveProperty('expectedGuests')
    expect(out).not.toHaveProperty('ref')
    expect(signupFromForm({ ...form, joinAs: 'watch_party', expectedGuests: '2.5' }).expectedGuests).toBe(2.5)
  })
})

describe('summitDoneLine', () => {
  it('says what happens next for each choice', () => {
    expect(summitDoneLine('online')).toBe('We’ll email you the links before the day.')
    expect(summitDoneLine('in_person')).toBe('We’ll email you to confirm your place.')
    expect(summitDoneLine('watch_party')).toBe('We’ll email you the host kit.')
  })
})

describe('submitSummitSignup', () => {
  const input = { email: 'ana@example.com', name: 'Ana', joinAs: 'online' as const, consent: true as const }
  const respond = (status: number, body: unknown = {}) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch

  it('posts JSON to the public endpoint without credentials', async () => {
    let seen: { url: string; init: RequestInit } | null = null
    const fake = (async (url: string, init: RequestInit) => {
      seen = { url, init }
      return new Response('{"ok":true}', { status: 201 })
    }) as unknown as typeof fetch
    await submitSummitSignup(input, fake)
    expect(seen!.url).toBe(`${API_URL}/api/summit/signups`)
    expect(seen!.init.method).toBe('POST')
    expect(JSON.parse(String(seen!.init.body))).toEqual(input)
    expect(new Headers(seen!.init.headers).get('authorization')).toBeNull()
    expect(seen!.init.credentials).toBeUndefined()
  })

  it('rejects with a message ready to show', async () => {
    await expect(submitSummitSignup(input, respond(429))).rejects.toThrow('Too many tries. Please try again later.')
    await expect(submitSummitSignup(input, respond(400, { error: 'city_required' }))).rejects.toThrow('Please tell us the city of your watch party.')
    const down = (async () => { throw new TypeError('Failed to fetch') }) as unknown as typeof fetch
    await expect(submitSummitSignup(input, down)).rejects.toThrow('We couldn’t reach Virvi. Please try again.')
  })
})

describe('signupsCsv', () => {
  const row = (over: Partial<AdminSummitSignup>): AdminSummitSignup => ({
    id: '1', email: 'ana@example.com', name: 'Ana', joinAs: 'online', partySize: null, city: null, expectedGuests: null, interests: [],
    source: null, inPersonStatus: null, consentAt: '2026-11-20T10:00:00.000Z', createdAt: '2026-11-20T10:00:00.000Z', updatedAt: '2026-11-20T10:00:00.000Z', ...over,
  })

  it('has a header and one line per sign-up', () => {
    const csv = signupsCsv([
      row({ joinAs: 'in_person', partySize: 2, inPersonStatus: 'confirmed', interests: ['studio', 'drops'], source: 'discord' }),
      row({ email: 'bo@example.com', name: 'Bo', joinAs: 'watch_party', city: 'Lisbon', expectedGuests: 30 }),
    ])
    expect(csv.split('\r\n')).toEqual([
      'Name,Email,How,Party size,In-person status,City,Expected guests,Interests,Source,Signed up',
      'Ana,ana@example.com,In person,2,confirmed,,,studio drops,discord,2026-11-20T10:00:00.000Z',
      'Bo,bo@example.com,Watch party,,,Lisbon,30,,,2026-11-20T10:00:00.000Z',
    ])
  })

  it('quotes commas, quotes and line breaks, and defuses spreadsheet formulas', () => {
    const csv = signupsCsv([row({ name: 'Smith, "Al"', city: 'x\ny', joinAs: 'watch_party' }), row({ name: '=HYPERLINK("x")' }), row({ name: '+1' }), row({ name: '-2' }), row({ name: '@SUM(A1)' })])
    const lines = csv.split('\r\n')
    expect(lines[1].startsWith('"Smith, ""Al""",')).toBe(true)
    expect(lines[1]).toContain('"x\ny"')
    expect(lines[2].startsWith(`"'=HYPERLINK(""x"")",`)).toBe(true)
    expect(lines[3].startsWith("'+1,")).toBe(true)
    expect(lines[4].startsWith("'-2,")).toBe(true)
    expect(lines[5].startsWith("'@SUM(A1),")).toBe(true)
  })
})
