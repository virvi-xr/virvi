// Virvi Assistant (LIV-155): one user turn. The model streams, calls tools (which run as the user through their own
// routes), and every tool result goes back to it only as escaped untrusted data. The server, not the prompt, holds
// the line on changes: one direct write per turn, anything more through propose_plan.
import { and, eq, isNull } from 'drizzle-orm'
import type { AssistantPageContext, AssistantStreamEvent } from '@virvixr/shared'
import { db } from '../db/connection.js'
import { assistantConversations, organizations, orgMembers, users } from '../db/schema.js'
import { config } from '../config.js'
import { recordJobFailure } from '../errors/record.js'
import { affordable, assistantAccess, refreshSpend, reserveAssistantSpend, settleAssistantSpend } from './access.js'
import { runAndRecord, proposePlan, proposeCard } from './actions.js'
import { callCostUsd, modelPrice } from './pricing.js'
import { redact, untrusted } from './redact.js'
import { TOOLS } from './tools/index.js'
import { toolsForModel } from './tools/run.js'
import type { ToolCtx } from './tools/types.js'
import { assistantModel, INVALID_TOOL_JSON, MAX_TOKENS, type ModelParams, type ModelResult } from './model.js'
import { contextPrompt, RULES } from './prompt.js'
import { DEFAULT_TITLE, loadHistory, storeMessage, titleFrom, type Block, type StoredMessage } from './conversations.js'

export const SECOND_WRITE = 'Use propose_plan for more than one change.'
const STOPPED = 'Not run: the turn was stopped.'
const AFTER_PLAN = 'Not run: wait for the user to approve the plan.'
export const APPROVAL_WRITE = 'Ask the user before making more changes.'
export const CUT_OFF = 'The reply was cut off. Try again, or ask for less at once.'
export const REFUSED = "The assistant can't help with that request. Try asking differently."

export interface TurnOptions {
  /** The continuation after a plan's approval: it reports results, and makes no change the user hasn't seen. */
  approval?: boolean
}

const PROPOSE_PLAN = {
  name: 'propose_plan',
  description:
    'Propose two or more changes for the user to approve at once. Call it once with every step (2 to 10), each a write tool and its args, then stop and wait. The user sees the plan and approves or cancels it.',
  input_schema: {
    type: 'object',
    properties: {
      steps: {
        type: 'array',
        minItems: 2,
        maxItems: 10,
        items: { type: 'object', properties: { tool: { type: 'string' }, args: { type: 'object' } }, required: ['tool', 'args'] },
      },
    },
    required: ['steps'],
  },
}

/** The tools as the model gets them: every enabled tool plus propose_plan, streamed eagerly, the list cached. */
function modelTools(): Array<Record<string, unknown>> {
  const tools: Array<Record<string, unknown>> = [...toolsForModel(), PROPOSE_PLAN].map((t) => ({ ...t, eager_input_streaming: true }))
  tools[tools.length - 1] = { ...tools[tools.length - 1], cache_control: { type: 'ephemeral' } }
  return tools
}

/** A tool name the model sent, safe inside the untrusted_data attribute. */
const tag = (name: string) => name.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64) || 'tool'

/** The messages with a cache breakpoint on the last block, so a turn's later calls reuse the earlier ones. */
function withCachedTail(messages: StoredMessage[]): unknown[] {
  const out: Array<{ role: string; content: Array<Record<string, unknown>> }> = messages.map((m) => ({ role: m.role, content: m.content.map((b) => ({ ...b })) }))
  const last = out[out.length - 1]?.content
  if (last?.length) last[last.length - 1] = { ...last[last.length - 1], cache_control: { type: 'ephemeral' } }
  return out
}

async function promptUser(userId: string) {
  const [me] = await db.select({ displayName: users.displayName, activeOrgId: users.activeOrgId }).from(users).where(eq(users.id, userId))
  const orgs = await db.select({ id: organizations.id, name: organizations.name }).from(orgMembers)
    .innerJoin(organizations, eq(orgMembers.orgId, organizations.id))
    .where(and(eq(orgMembers.userId, userId), isNull(organizations.deletedAt)))
  return { displayName: me?.displayName ?? null, orgs: orgs.map((o) => ({ ...o, isActive: me?.activeOrgId === o.id })) }
}

export async function runTurn(
  ctx: ToolCtx,
  conversationId: string,
  userText: string,
  page: AssistantPageContext,
  emit: (e: AssistantStreamEvent) => void,
  signal: AbortSignal,
  opts: TurnOptions = {},
): Promise<void> {
  const userId = ctx.user.id
  let orgId: string | null = null
  let lastAssistantId: string | null = null
  try {
    const [conv] = await db.select().from(assistantConversations).where(eq(assistantConversations.id, conversationId))
    orgId = conv?.orgId ?? null
    let access = await assistantAccess(ctx.user)
    if (access.state !== 'ok') {
      emit({ type: 'error', code: 'assistant_unavailable', message: "The assistant isn't available on this account." })
      return
    }

    const history = await loadHistory(conversationId)
    const text = redact(userText, ctx.self) as string
    // The context opens the message (not the system prompt), so earlier turns' history and thinking stay byte-stable
    const context = contextPrompt(await promptUser(userId), page, new Date())
    const userMessage: StoredMessage = { role: 'user', content: [{ type: 'text', text: context }, { type: 'text', text }] }
    await storeMessage(conversationId, userMessage)
    if (conv?.title === DEFAULT_TITLE) {
      await db.update(assistantConversations).set({ title: titleFrom(text) }).where(eq(assistantConversations.id, conversationId))
    }
    const messages: StoredMessage[] = [...history, userMessage]

    const model = config.assistantModel
    const price = modelPrice(model)
    const system: ModelParams['system'] = [{ type: 'text', text: RULES, cache_control: { type: 'ephemeral' } }]
    const tools = modelTools()
    const fixedChars = JSON.stringify(system).length + JSON.stringify(tools).length
    const turn = assistantModel()

    let wrote = false
    let planned = false
    for (let calls = 0; calls < config.assistantToolCallsPerMessage; calls++) {
      if (signal.aborted) break
      // Worst case: every input token a cache write, every output token used
      const estimate = ((fixedChars + JSON.stringify(messages).length) / 3) * price.cacheWritePerMTok / 1e6 + MAX_TOKENS * price.outPerMTok / 1e6
      // Spent is read again before every call: this turn's earlier calls, and what other turns have reserved
      access = await refreshSpend(userId, access)
      if (!affordable(access, estimate)) {
        const resets = access.state === 'ok' && access.budget.resetsAt ? access.budget.resetsAt.slice(0, 10) : 'the next billing date'
        emit({ type: 'error', code: 'assistant_budget', message: `You've used this month's assistant budget. It comes back on ${resets}.` })
        break
      }
      // Booked before the call: one that is aborted or throws after it was sent keeps its reservation
      const reservedAt = new Date()
      await reserveAssistantSpend(userId, reservedAt, estimate, calls === 0)

      let streamed = false
      let result: ModelResult
      try {
        result = await turn({ model, system, tools, messages: withCachedTail(messages), max_tokens: MAX_TOKENS, signal }, (delta) => {
          streamed = true
          if (!signal.aborted) emit({ type: 'text', delta })
        })
      } catch (err) {
        if (signal.aborted) break
        throw err
      }
      // A stream cut short on broken tool JSON may under-report its usage: it costs at least what was reserved
      const real = callCostUsd(model, result.usage)
      await settleAssistantSpend(userId, reservedAt, result.usage, result.stopReason === INVALID_TOOL_JSON ? Math.max(real, estimate) : real, estimate)

      const uses = result.content.filter((b): b is Extract<ModelResult['content'][number], { type: 'tool_use' }> => b.type === 'tool_use')
      const hasText = result.content.some((b) => b.type === 'text' && b.text)
      // A reply with no text and no call (empty, or thinking only) is never stored: replayed, the API refuses it
      if (uses.length || hasText) {
        // Verbatim, so thinking signatures stay valid when the history is replayed; only what's shown is redacted. A call
        // whose input wasn't valid JSON goes back with {} (it never runs).
        const content = result.content.map((b) => (b.type === 'tool_use' ? { type: 'tool_use', id: b.id, name: b.name, input: b.invalidJson === undefined ? b.input : {} } : { ...b })) as Block[]
        const assistant: StoredMessage = { role: 'assistant', content }
        lastAssistantId = await storeMessage(conversationId, assistant, { tokensIn: result.usage.input_tokens, tokensOut: result.usage.output_tokens, model })
        messages.push(assistant)
      }

      if (result.stopReason === 'max_tokens' && !streamed) emit({ type: 'error', code: 'assistant_cut_off', message: CUT_OFF })
      if (result.stopReason === 'refusal' && !hasText) emit({ type: 'error', code: 'assistant_refused', message: REFUSED })
      if (!uses.length) break
      // A cut-off, refused or broken-JSON reply may carry a half-written call: none of its tools run. Broken JSON alone
      // gets an answer the model can retry from, so the turn goes on.
      const runnable = result.stopReason !== 'max_tokens' && result.stopReason !== 'refusal' && result.stopReason !== INVALID_TOOL_JSON
      const endAfter = planned || (!runnable && result.stopReason !== INVALID_TOOL_JSON)

      const results: Block[] = []
      for (const use of uses) {
        const name = tag(use.name)
        const reply = (data: unknown, isError = false) => results.push({ type: 'tool_result', tool_use_id: use.id, content: untrusted(name, data), ...(isError ? { is_error: true } : {}) })
        if (signal.aborted) { reply({ error: STOPPED }, true); continue }
        if (use.invalidJson !== undefined) { reply({ INVALID_JSON: use.invalidJson }, true); continue }
        if (!runnable) { reply({ error: STOPPED }, true); continue }
        if (planned) { reply({ error: AFTER_PLAN }, true); continue }

        if (use.name === 'propose_plan') {
          const steps = (use.input as { steps?: unknown } | null)?.steps
          const plan = await proposePlan(ctx, conversationId, steps as Array<{ tool: string; args: unknown }>)
          if (!('planId' in plan)) { reply({ error: plan.error }, true); continue }
          planned = true
          emit({ type: 'plan', plan })
          reply({ shown_to_user: true, steps: plan.steps.length })
          continue
        }

        const def = Object.hasOwn(TOOLS, use.name) ? TOOLS[use.name] : undefined
        const isWrite = def?.effect === 'write'
        if (def?.effect === 'paid') {
          // A paid call is its own confirmation card: never run here, never the turn's one direct write
          if (opts.approval) { reply({ error: APPROVAL_WRITE }, true); continue }
          const card = await proposeCard(ctx, conversationId, use.name, use.input)
          if ('error' in card) { reply({ error: card.error }, true); continue }
          if ('blocked' in card) {
            emit({ type: 'link', label: card.link.label, href: card.link.href, detail: card.blocked })
            reply({ error: card.blocked }, true)
            continue
          }
          planned = true
          emit({ type: 'plan', plan: card })
          reply({ shown_to_user: true, waiting_for: 'the user to confirm' })
          continue
        }
        if (isWrite && opts.approval) { reply({ error: APPROVAL_WRITE }, true); continue }
        if (isWrite && wrote) { reply({ error: SECOND_WRITE }, true); continue }
        const { action, result: r } = await runAndRecord(ctx, conversationId, use.name, use.input)
        if (isWrite) {
          // Only a change that happened counts: a refused write changed nothing
          if (r.ok) wrote = true
          emit({ type: 'action', action })
        }
        if (r.ok && use.name === 'open_page') {
          const link = r.summary as { href: string; label: string }
          emit({ type: 'link', label: link.label, href: link.href })
        }
        if (r.ok) reply(r.summary)
        else reply({ error: r.error }, true)
      }
      const toolResults: StoredMessage = { role: 'user', content: results }
      await storeMessage(conversationId, toolResults)
      messages.push(toolResults)
      if (endAfter || signal.aborted) break
    }

    const now = await assistantAccess(ctx.user)
    if (now.state === 'ok') emit({ type: 'budget', budget: now.budget })
  } catch (err) {
    // Ids only: never the conversation's text
    recordJobFailure('assistant', err, { orgId })
    emit({ type: 'error', code: 'assistant_failed', message: 'The assistant hit an error. Try again.' })
  } finally {
    emit({ type: 'done', messageId: lastAssistantId })
  }
}
