import type { FastifyInstance } from 'fastify'
import { desc } from 'drizzle-orm'
import type { AdminAdvertiserLead, AdvertiserLeadInput } from '@virvixr/shared'
import { db } from '../db/connection.js'
import { advertiserLeads } from '../db/schema.js'
import { authenticate } from '../middleware/auth.js'
import { requireAdmin } from '../auth/admin.js'


const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const MAX_FIELD = 200
const MAX_MESSAGE = 2000

type LeadFields = { name?: string; company?: string; website?: string; message?: string }
type Parsed = { ok: true; email: string; fields: LeadFields } | { ok: false; error: 'invalid_email' | 'consent_required' | 'invalid_website' | 'too_long' }

/** Trimmed text; undefined when the field was not sent, is not a string, or is blank (the form sends '' for empty fields). */
const text = (v: unknown): string | undefined => {
  if (typeof v !== 'string') return undefined
  return v.trim() || undefined
}

/** A website as an absolute http(s) URL; a bare domain gets https://. Undefined when it isn't one. */
function normalizeWebsite(raw: string): string | undefined {
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`
  try {
    const u = new URL(withScheme)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return undefined
    return withScheme
  } catch {
    return undefined
  }
}

function parseLead(body: Partial<AdvertiserLeadInput> | null | undefined): Parsed {
  const b = body ?? {}
  const email = typeof b.email === 'string' ? b.email.trim().toLowerCase() : ''
  if (email.length > 254 || !EMAIL.test(email)) return { ok: false, error: 'invalid_email' }
  if (b.consent !== true) return { ok: false, error: 'consent_required' }

  const fields: LeadFields = { name: text(b.name), company: text(b.company), website: text(b.website), message: text(b.message) }
  for (const key of ['name', 'company', 'website'] as const) {
    if ((fields[key]?.length ?? 0) > MAX_FIELD) return { ok: false, error: 'too_long' }
  }
  if ((fields.message?.length ?? 0) > MAX_MESSAGE) return { ok: false, error: 'too_long' }
  if (fields.website) {
    const website = normalizeWebsite(fields.website)
    if (!website) return { ok: false, error: 'invalid_website' }
    fields.website = website
  }
  // Only answered fields overwrite a returning advertiser's earlier answers; a blank never erases one
  for (const key of Object.keys(fields) as (keyof LeadFields)[]) if (fields[key] === undefined) delete fields[key]
  return { ok: true, email, fields }
}

export default async function advertiserLeadRoutes(app: FastifyInstance) {
  app.post<{ Body: Partial<AdvertiserLeadInput> }>(
    '/api/advertiser-leads',
    { config: { rateLimit: { max: 5, timeWindow: '1 hour' } } },
    async (request, reply) => {
      // Honeypot: answer like a success so bots learn nothing, store nothing
      if (typeof request.body?.nickname === 'string' && request.body.nickname !== '') return reply.status(201).send({ ok: true })

      const lead = parseLead(request.body)
      if (!lead.ok) return reply.status(400).send({ error: lead.error })

      const now = new Date()
      await db
        .insert(advertiserLeads)
        .values({ email: lead.email, ...lead.fields, consentAt: now, createdAt: now, updatedAt: now })
        .onConflictDoUpdate({ target: advertiserLeads.email, set: { ...lead.fields, consentAt: now, updatedAt: now } })
      return reply.status(201).send({ ok: true })
    },
  )

  app.get('/api/admin/advertiser-leads', { preHandler: [authenticate, requireAdmin] }, async (_request, reply) => {
    const rows = await db.select().from(advertiserLeads).orderBy(desc(advertiserLeads.createdAt))
    const leads: AdminAdvertiserLead[] = rows.map((r) => ({
      id: r.id,
      email: r.email,
      name: r.name,
      company: r.company,
      website: r.website,
      message: r.message,
      consentAt: r.consentAt.toISOString(),
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
    }))
    return reply.send({ leads })
  })
}
