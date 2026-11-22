// Virvi Assistant (LIV-155): stored conversations. A message row holds Anthropic content blocks: the user's text (redacted,
// after the account and page context block), the model's blocks verbatim (thinking signatures cover them; redacted when
// shown), and the tool_result blocks the model was sent (as their own user-role rows), so the next turn can replay a
// valid tool_use/tool_result sequence. Rows are only ever appended.
import { and, asc, desc, eq, inArray, or } from 'drizzle-orm'
import type { AssistantMessageView } from '@virvixr/shared'
import { db } from '../db/connection.js'
import { assistantActions, assistantConversations, assistantMessages } from '../db/schema.js'
import { actionView } from './actions.js'
import { isDashboardPath, LINK_TOOLS } from './tools/local.js'
import { BUY_PROMPTS, NO_PROMPTS } from './tools/studio.js'
import { TOOLS } from './tools/index.js'
import { redact, type RedactSelf } from './redact.js'
import { CONTEXT_INTRO } from './prompt.js'

export const DEFAULT_TITLE = 'New conversation'
export const TITLE_MAX = 60
export const HISTORY_ROWS = 40
/** The synthetic user text that carries a plan's results back to the model; never shown in the history view. */
export const APPROVAL_TEXT = '(The user approved the plan. Results follow.)'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export const isUuid = (s: unknown): s is string => typeof s === 'string' && UUID.test(s)

export type Block = { type: string; text?: string; id?: string; name?: string; input?: unknown; tool_use_id?: string; content?: unknown; is_error?: boolean }
export type StoredMessage = { role: 'user' | 'assistant'; content: Block[] }
type Row = typeof assistantMessages.$inferSelect

const blocks = (content: unknown): Block[] => (Array.isArray(content) ? (content as Block[]) : [])
/** A row the user typed (or the synthetic approval text): text, and no tool_result. */
export const isUserText = (r: { role: string; content: unknown }) =>
  r.role === 'user' && blocks(r.content).some((b) => b.type === 'text') && !blocks(r.content).some((b) => b.type === 'tool_result')
/** The context block that opens a user message: for the model only, never shown. */
const isContext = (b: Block, i: number, all: Block[]) => i === 0 && all.length > 1 && b.type === 'text' && (b.text ?? '').startsWith(CONTEXT_INTRO)
const textOf = (content: unknown) => blocks(content).filter((b, i, all) => b.type === 'text' && !isContext(b, i, all)).map((b) => b.text ?? '').join('')
const isApproval = (r: Row) => r.role === 'user' && textOf(r.content).startsWith(APPROVAL_TEXT)

export async function ownConversation(userId: string, conversationId: unknown) {
  if (!isUuid(conversationId)) return null
  const [row] = await db.select().from(assistantConversations).where(and(eq(assistantConversations.id, conversationId), eq(assistantConversations.userId, userId)))
  return row ?? null
}

/** The last HISTORY_ROWS rows, oldest first, starting on a user's text so no tool_result is left without its tool_use. */
export async function loadHistory(conversationId: string): Promise<StoredMessage[]> {
  const rows = await db.select().from(assistantMessages).where(eq(assistantMessages.conversationId, conversationId))
    .orderBy(desc(assistantMessages.createdAt), desc(assistantMessages.id)).limit(HISTORY_ROWS)
  rows.reverse()
  const start = rows.findIndex(isUserText)
  if (start === -1) return []
  return rows.slice(start).map((r) => ({ role: r.role, content: blocks(r.content) }))
}

export async function storeMessage(conversationId: string, m: StoredMessage, usage?: { tokensIn: number; tokensOut: number; model: string }): Promise<string> {
  const [row] = await db.insert(assistantMessages).values({ conversationId, role: m.role, content: m.content, ...(usage ?? {}) }).returning({ id: assistantMessages.id })
  await db.update(assistantConversations).set({ updatedAt: new Date() }).where(eq(assistantConversations.id, conversationId))
  return row.id
}

export function titleFrom(text: string): string {
  const t = text.replace(/\s+/g, ' ').trim()
  return t.length <= TITLE_MAX ? t : t.slice(0, TITLE_MAX - 1).trimEnd() + '…'
}

/** A link tool's (open_finalize, open_beat_pay) stored result, when it is a dashboard link. */
function storedLink(summary: string | null): { href: string; label: string; detail?: string } | null {
  try {
    const o = JSON.parse(summary ?? 'null') as { href?: unknown; label?: unknown; detail?: unknown } | null
    if (!o || typeof o.href !== 'string' || typeof o.label !== 'string' || !isDashboardPath(o.href)) return null
    return { href: o.href, label: o.label, ...(typeof o.detail === 'string' ? { detail: o.detail } : {}) }
  } catch {
    return null
  }
}

/**
 * What the panel shows: one view per message the user typed, and one per assistant reply (every model call and the
 * approval continuation up to the next typed message, merged). Tool results and the approval text stay hidden. A
 * reply's actions are the writes and cards logged between its user message and the next one. Its links are rebuilt
 * as they were streamed: its open_page calls, its open_finalize and open_beat_pay results (from their action rows),
 * and the "Buy Studio prompts" link for a paid call refused for having no prompts left. The model's blocks are stored
 * verbatim (thinking signatures cover them), so what's shown is redacted here.
 */
export async function messageViews(conversationId: string, userId: string, self: RedactSelf): Promise<AssistantMessageView[]> {
  const shown = (t: string) => redact(t, self) as string
  const rows = await db.select().from(assistantMessages).where(eq(assistantMessages.conversationId, conversationId))
    .orderBy(asc(assistantMessages.createdAt), asc(assistantMessages.id))
  const logged = await db.select().from(assistantActions)
    .where(and(
      eq(assistantActions.conversationId, conversationId),
      eq(assistantActions.userId, userId),
      or(inArray(assistantActions.effect, ['write', 'paid', 'public']), and(inArray(assistantActions.tool, Object.keys(LINK_TOOLS)), eq(assistantActions.status, 'done'))),
    ))
    .orderBy(asc(assistantActions.createdAt), asc(assistantActions.step))
  const actions = logged.filter((a) => a.effect !== 'read')
  const linkRows = logged.filter((a) => a.effect === 'read')
  // The answers the model got, by call: a refused paid call's answer says why
  const answers = new Map<string, Block>()
  for (const r of rows) for (const b of blocks(r.content)) if (b.type === 'tool_result' && b.tool_use_id) answers.set(b.tool_use_id, b)
  const noPrompts = `\n${JSON.stringify({ error: NO_PROMPTS })}\n`

  const views: AssistantMessageView[] = []
  let reply: AssistantMessageView | null = null
  let turnStart: Date | null = null
  let turnLinks: typeof linkRows = []
  const typed = rows.filter((r) => isUserText(r) && !isApproval(r))
  for (const r of rows) {
    if (isUserText(r) && !isApproval(r)) {
      reply = null
      turnStart = r.createdAt
      views.push({ id: r.id, role: 'user', text: textOf(r.content), actions: [], links: [], createdAt: r.createdAt.toISOString() })
      continue
    }
    if (r.role !== 'assistant') continue
    if (!reply) {
      reply = { id: r.id, role: 'assistant', text: '', actions: [], links: [], createdAt: r.createdAt.toISOString() }
      const next = typed.find((t) => turnStart && t.createdAt > turnStart)
      const inTurn = (a: { createdAt: Date }) => (!turnStart || a.createdAt >= turnStart) && (!next || a.createdAt < next.createdAt)
      reply.actions = actions.filter(inTurn).map(actionView)
      turnLinks = linkRows.filter(inTurn)
      views.push(reply)
    }
    const text = shown(textOf(r.content))
    if (text) reply.text = reply.text ? `${reply.text}\n\n${text}` : text
    for (const b of blocks(r.content)) {
      const input = (b.input ?? {}) as { path?: unknown; label?: unknown }
      if (b.type !== 'tool_use') continue
      if (b.name === 'open_page' && typeof input.path === 'string' && typeof input.label === 'string' && isDashboardPath(input.path)) {
        reply.links.push({ label: shown(input.label), href: input.path })
      } else if (b.name && Object.hasOwn(LINK_TOOLS, b.name)) {
        // Its done row for the same tool and target, in call order (a refused call has none): the link it returned
        const key = LINK_TOOLS[b.name]
        const target = ((b.input ?? null) as Record<string, unknown> | null)?.[key]
        const i = turnLinks.findIndex((a) => a.tool === b.name && ((a.argsRedacted ?? null) as Record<string, unknown> | null)?.[key] === target)
        const link = i === -1 ? null : storedLink(turnLinks.splice(i, 1)[0].resultSummary)
        if (link) reply.links.push({ label: shown(link.label), href: link.href, ...(link.detail ? { detail: shown(link.detail) } : {}) })
      } else if (b.name && Object.hasOwn(TOOLS, b.name) && TOOLS[b.name].effect === 'paid') {
        // Paid only, on purpose: a public card (a raffle, a prize) spends no Studio prompts, so it never needs this link
        const answer = b.id ? answers.get(b.id) : undefined
        if (answer?.is_error && typeof answer.content === 'string' && answer.content.includes(noPrompts)) {
          reply.links.push({ ...BUY_PROMPTS, detail: NO_PROMPTS })
        }
      }
    }
  }
  return views
}

