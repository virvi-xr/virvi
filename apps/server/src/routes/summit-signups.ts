import type { FastifyInstance } from 'fastify'
import { desc, eq, sql } from 'drizzle-orm'
import {
  SUMMIT_IN_PERSON_STATUSES,
  SUMMIT_INTERESTS,
  SUMMIT_JOIN_AS,
  SUMMIT_LIMITS,
  SUMMIT_NO_SOURCE,
  summitRef,
  type AdminSummitSignup,
  type AdminSummitSignups,
  type AdminSummitTotals,
  type SummitInPersonStatus,
  type SummitInterest,
  type SummitJoinAs,
  type SummitSignupError,
  type SummitSignupInput,
} from '@virvixr/shared'
import { db } from '../db/connection.js'
import { summitSignups } from '../db/schema.js'
import { authenticate } from '../middleware/auth.js'
import { requireAdmin } from '../auth/admin.js'

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

type Answers = {
  name: string
  joinAs: SummitJoinAs
  partySize: number | null
  city: string | null
  expectedGuests: number | null
  interests: SummitInterest[]
}
type Parsed = { ok: true; email: string; answers: Answers; source: string | undefined } | { ok: false; error: SummitSignupError }

const text = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')
const absent = (v: unknown) => v === undefined || v === null || v === ''
const wholeIn = (v: unknown, min: number, max: number): v is number => typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max

function parseSignup(body: Partial<Record<keyof SummitSignupInput, unknown>> | null | undefined): Parsed {
  const b = body ?? {}
  const fail = (error: SummitSignupError): Parsed => ({ ok: false, error })

  const email = text(b.email).toLowerCase()
  if (email.length > 254 || !EMAIL.test(email)) return fail('invalid_email')
  const name = text(b.name)
  if (!name) return fail('name_required')
  if (name.length > SUMMIT_LIMITS.maxText) return fail('too_long')
  if (!SUMMIT_JOIN_AS.includes(b.joinAs as SummitJoinAs)) return fail('invalid_join_as')
  const joinAs = b.joinAs as SummitJoinAs

  // Only the details of the chosen way to join are kept; the others are ignored
  let partySize: number | null = null
  let city: string | null = null
  let expectedGuests: number | null = null
  if (joinAs === 'in_person') {
    if (absent(b.partySize)) partySize = 1
    else if (wholeIn(b.partySize, SUMMIT_LIMITS.minPartySize, SUMMIT_LIMITS.maxPartySize)) partySize = b.partySize
    else return fail('invalid_party_size')
  }
  if (joinAs === 'watch_party') {
    city = text(b.city)
    if (!city) return fail('city_required')
    if (city.length > SUMMIT_LIMITS.maxText) return fail('too_long')
    if (!absent(b.expectedGuests)) {
      if (!wholeIn(b.expectedGuests, SUMMIT_LIMITS.minGuests, SUMMIT_LIMITS.maxGuests)) return fail('invalid_guests')
      expectedGuests = b.expectedGuests
    }
  }

  let interests: SummitInterest[] = []
  if (!absent(b.interests)) {
    if (!Array.isArray(b.interests) || b.interests.some((i) => !SUMMIT_INTERESTS.includes(i as SummitInterest))) return fail('invalid_interest')
    const picked = new Set(b.interests as SummitInterest[])
    interests = SUMMIT_INTERESTS.filter((i) => picked.has(i))
  }

  if (b.consent !== true) return fail('consent_required')
  return { ok: true, email, answers: { name, joinAs, partySize, city, expectedGuests, interests }, source: summitRef(b.ref) }
}

function toAdmin(r: typeof summitSignups.$inferSelect): AdminSummitSignup {
  return {
    id: r.id,
    email: r.email,
    name: r.name,
    joinAs: r.joinAs as SummitJoinAs,
    partySize: r.partySize,
    city: r.city,
    expectedGuests: r.expectedGuests,
    interests: r.interests as SummitInterest[],
    source: r.source,
    inPersonStatus: r.inPersonStatus as SummitInPersonStatus | null,
    consentAt: r.consentAt.toISOString(),
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  }
}

export function summitTotals(signups: AdminSummitSignup[]): AdminSummitTotals {
  const byJoinAs = Object.fromEntries(SUMMIT_JOIN_AS.map((j) => [j, 0])) as Record<SummitJoinAs, number>
  const byInterest = Object.fromEntries(SUMMIT_INTERESTS.map((i) => [i, 0])) as Record<SummitInterest, number>
  const bySource: Record<string, number> = {}
  let inPersonPeople = 0
  for (const s of signups) {
    byJoinAs[s.joinAs]++
    for (const i of s.interests) byInterest[i]++
    const key = s.source ?? SUMMIT_NO_SOURCE
    bySource[key] = (bySource[key] ?? 0) + 1
    if (s.joinAs === 'in_person' && (s.inPersonStatus === 'requested' || s.inPersonStatus === 'confirmed')) inPersonPeople += s.partySize ?? 1
  }
  return { byJoinAs, byInterest, bySource, inPersonPeople }
}

export default async function summitSignupRoutes(app: FastifyInstance) {
  app.post<{ Body: Partial<SummitSignupInput> }>(
    '/api/summit/signups',
    { config: { rateLimit: { max: 5, timeWindow: '1 hour' } } },
    async (request, reply) => {
      // Honeypot: answer like a success so bots learn nothing, store nothing
      if (typeof request.body?.nickname === 'string' && request.body.nickname !== '') return reply.status(201).send({ ok: true })

      const signup = parseSignup(request.body)
      if (!signup.ok) return reply.status(400).send({ error: signup.error })

      const { answers, email, source } = signup
      const inPerson = answers.joinAs === 'in_person'
      const now = new Date()
      await db
        .insert(summitSignups)
        .values({ email, ...answers, source: source ?? null, inPersonStatus: inPerson ? 'requested' : null, consentAt: now, createdAt: now, updatedAt: now })
        .onConflictDoUpdate({
          target: summitSignups.email,
          set: {
            ...answers,
            // A resubmit without a ref keeps where they first came from
            ...(source ? { source } : {}),
            // Asking to come in person (again) is a request, unless the place is already confirmed; any other choice clears it
            inPersonStatus: inPerson
              ? sql`CASE WHEN ${summitSignups.inPersonStatus} = 'confirmed' THEN 'confirmed' ELSE 'requested' END`
              : null,
            consentAt: now,
            updatedAt: now,
          },
        })
      return reply.status(201).send({ ok: true })
    },
  )

  app.get('/api/admin/summit/signups', { preHandler: [authenticate, requireAdmin] }, async (_request, reply) => {
    const rows = await db.select().from(summitSignups).orderBy(desc(summitSignups.createdAt))
    const signups = rows.map(toAdmin)
    const body: AdminSummitSignups = { signups, totals: summitTotals(signups) }
    return reply.send(body)
  })

  app.put<{ Params: { id: string }; Body: { status?: unknown } }>(
    '/api/admin/summit/signups/:id/in-person',
    { preHandler: [authenticate, requireAdmin] },
    async (request, reply) => {
      const { id } = request.params
      const status = request.body?.status
      if (!SUMMIT_IN_PERSON_STATUSES.includes(status as SummitInPersonStatus)) return reply.status(400).send({ error: 'invalid_status' })
      if (!UUID.test(id)) return reply.status(404).send({ error: 'not_found' })
      const [row] = await db.select().from(summitSignups).where(eq(summitSignups.id, id))
      if (!row) return reply.status(404).send({ error: 'not_found' })
      if (row.joinAs !== 'in_person') return reply.status(400).send({ error: 'not_in_person' })
      const [updated] = await db
        .update(summitSignups)
        .set({ inPersonStatus: status as SummitInPersonStatus, updatedAt: new Date() })
        .where(eq(summitSignups.id, id))
        .returning()
      return reply.send({ signup: toAdmin(updated) })
    },
  )
}
