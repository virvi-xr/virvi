import { sql, type SQL } from 'drizzle-orm'
import { db } from '../db/connection.js'

/**
 * Every Design Studio design, for Virvi admins who help people with theirs (Virvi support): trial designs included,
 * newest activity first (the last job, or creation), searchable by the owner's email, wallet or name, the design's
 * name, or the design's or owner's id. Paginated by an opaque cursor.
 */

export const ADMIN_DESIGNS_PAGE = 50
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export const DESIGN_KINDS = ['wearable', 'emote', 'scene'] as const

export type AdminDesign = {
  id: string; name: string; kind: string; agent: string; status: string
  archivedAt: string | null; createdAt: string; lastActivityAt: string; lastPromptAt: string | null; pieceCount: number
  finalizedAt: string | null
  owner: { id: string; name: string | null; email: string | null; wallet: string | null; trial: boolean }
}

/** The cursor is the last row's activity (Postgres's text, so no microseconds are lost) and id. */
type Cursor = { at: string; id: string }
const encodeCursor = (c: Cursor) => Buffer.from(JSON.stringify(c)).toString('base64url')
export function decodeCursor(raw: string): Cursor | null {
  try {
    const c = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as Partial<Cursor>
    if (typeof c.at !== 'string' || !c.at || c.at.length > 64 || typeof c.id !== 'string' || !UUID.test(c.id)) return null
    if (Number.isNaN(Date.parse(c.at))) return null
    return { at: c.at, id: c.id }
  } catch {
    return null
  }
}

/** `%` and `_` in a search are themselves. */
const likeOf = (q: string) => `%${q.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`

const iso = (v: unknown): string | null => (v == null ? null : new Date(v as string).toISOString())

export async function listAdminDesigns(opts: { q?: string | null; kind?: string | null; cursor?: Cursor | null; limit?: number } = {}) {
  const limit = opts.limit ?? ADMIN_DESIGNS_PAGE
  const activity = sql`coalesce(d.last_job_at, d.created_at)`
  const where: SQL[] = [sql`true`]
  const q = opts.q?.trim().toLowerCase()
  if (q) {
    if (UUID.test(q)) where.push(sql`(d.id = ${q}::uuid OR d.owner_id = ${q}::uuid)`)
    else {
      const like = likeOf(q)
      where.push(sql`(lower(d.name) LIKE ${like} OR lower(coalesce(u.email, '')) LIKE ${like} OR lower(u.display_name) LIKE ${like}
        OR EXISTS (SELECT 1 FROM user_auth_methods m WHERE m.user_id = d.owner_id AND m.type = 'wallet' AND lower(m.identifier) LIKE ${like}))`)
    }
  }
  if (opts.kind) where.push(sql`d.kind = ${opts.kind}`)
  if (opts.cursor) {
    where.push(sql`(${activity} < ${opts.cursor.at}::timestamptz OR (${activity} = ${opts.cursor.at}::timestamptz AND d.id < ${opts.cursor.id}::uuid))`)
  }
  const rows = await db.execute(sql`
    SELECT d.id, d.name, d.kind, d.agent, d.status, d.archived_at, d.created_at, d.finalized_at,
      ${activity} AS activity, (${activity})::text AS activity_key,
      (SELECT max(j.created_at) FROM studio_jobs j WHERE j.design_id = d.id AND j.type = 'prompt') AS last_prompt_at,
      (SELECT count(*)::int FROM studio_pieces p WHERE p.design_id = d.id AND p.latest_revision_id IS NOT NULL) AS piece_count,
      u.id AS owner_id, u.display_name, u.email, u.is_trial,
      (SELECT m.identifier FROM user_auth_methods m WHERE m.user_id = u.id AND m.type = 'wallet' ORDER BY m.created_at LIMIT 1) AS wallet
    FROM studio_designs d JOIN users u ON u.id = d.owner_id
    WHERE ${sql.join(where, sql` AND `)}
    ORDER BY ${activity} DESC, d.id DESC
    LIMIT ${limit + 1}`) as unknown as Record<string, unknown>[]
  const page = rows.slice(0, limit)
  const last = page[page.length - 1]
  return {
    designs: page.map((r): AdminDesign => ({
      id: r.id as string, name: r.name as string, kind: r.kind as string, agent: r.agent as string, status: r.status as string,
      archivedAt: iso(r.archived_at), createdAt: iso(r.created_at)!, lastActivityAt: iso(r.activity)!, lastPromptAt: iso(r.last_prompt_at),
      pieceCount: Number(r.piece_count ?? 0), finalizedAt: iso(r.finalized_at),
      owner: {
        id: r.owner_id as string, name: (r.display_name as string | null) ?? null, email: (r.email as string | null) ?? null,
        wallet: (r.wallet as string | null) ?? null, trial: !!r.is_trial,
      },
    })),
    nextCursor: rows.length > limit && last ? encodeCursor({ at: last.activity_key as string, id: last.id as string }) : null,
  }
}
