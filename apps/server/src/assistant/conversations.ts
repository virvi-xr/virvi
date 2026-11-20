// Virvi Assistant (LIV-155): stored conversations. A message row holds Anthropic content blocks, already redacted:
// the user's text, the model's text and tool_use blocks, and the tool_result blocks the model was sent (as their own
// user-role rows), so the next turn can replay a valid tool_use/tool_result sequence.
import { and, asc, desc, eq } from 'drizzle-orm'
import type { AssistantMessageView } from '@virvixr/shared'
import { db } from '../db/connection.js'
import { assistantActions, assistantConversations, assistantMessages } from '../db/schema.js'
import { actionView } from './actions.js'
import { isDashboardPath } from './tools/local.js'
import { redact, type RedactSelf } from './redact.js'

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
const textOf = (content: unknown) => blocks(content).filter((b) => b.type === 'text').map((b) => b.text ?? '').join('')
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

/**
 * What the panel shows: one view per message the user typed, and one per assistant reply (every model call and the
 * approval continuation up to the next typed message, merged). Tool results and the approval text stay hidden. A
 * reply's actions are the writes logged between its user message and the next one; its links are its open_page calls.
 * The model's blocks are stored verbatim (thinking signatures cover them), so what's shown is redacted here.
 */
export async function messageViews(conversationId: string, userId: string, self: RedactSelf): Promise<AssistantMessageView[]> {
  const shown = (t: string) => redact(t, self) as string
  const rows = await db.select().from(assistantMessages).where(eq(assistantMessages.conversationId, conversationId))
    .orderBy(asc(assistantMessages.createdAt), asc(assistantMessages.id))
  const actions = await db.select().from(assistantActions)
    .where(and(eq(assistantActions.conversationId, conversationId), eq(assistantActions.userId, userId), eq(assistantActions.effect, 'write')))
    .orderBy(asc(assistantActions.createdAt), asc(assistantActions.step))

  const views: AssistantMessageView[] = []
  let reply: AssistantMessageView | null = null
  let turnStart: Date | null = null
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
      reply.actions = actions
        .filter((a) => (!turnStart || a.createdAt >= turnStart) && (!next || a.createdAt < next.createdAt))
        .map(actionView)
      views.push(reply)
    }
    const text = shown(textOf(r.content))
    if (text) reply.text = reply.text ? `${reply.text}\n\n${text}` : text
    for (const b of blocks(r.content)) {
      const input = (b.input ?? {}) as { path?: unknown; label?: unknown }
      if (b.type === 'tool_use' && b.name === 'open_page' && typeof input.path === 'string' && typeof input.label === 'string' && isDashboardPath(input.path)) {
        reply.links.push({ label: shown(input.label), href: input.path })
      }
    }
  }
  return views
}

