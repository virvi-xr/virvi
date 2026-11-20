// Virvi Assistant (LIV-155): the model seam. One streamed Claude call per loop step; tests swap in a scripted turn.
import Anthropic from '@anthropic-ai/sdk'
import { config } from '../config.js'

/** Room for adaptive thinking as well as the reply; the budget estimate assumes all of it is used. */
export const MAX_TOKENS = 4096
export const EFFORT = 'medium' as const
/**
 * Preserved thinking: a replayed thinking block that no longer matches its conversation's prefix is dropped instead of
 * failing the request with a 400 (claude-api skill, preserved-thinking-migration). The system prompt never changes and
 * history is append-only, so a drop should only follow the 40-row window or a broken tool input sent back as {}.
 */
export const THINKING_BETA = 'thinking-binding-controls-2026-08-01'
export const THINKING: Anthropic.Beta.Messages.BetaThinkingConfigAdaptive = { type: 'adaptive', block_binding: { prefix_mismatch_behavior: 'drop_block' } }
/** The stop reason of a stream the SDK ended on a tool input it couldn't parse: only the INVALID_JSON answer runs. */
export const INVALID_TOOL_JSON = 'invalid_tool_json'

export type ModelBlock =
  | { type: 'text'; text: string }
  /** `invalidJson`: the raw input when it wasn't valid JSON (eager input streaming); the call never runs. */
  | { type: 'tool_use'; id: string; name: string; input: unknown; invalidJson?: string }
  /** Thinking blocks go back to the API exactly as they came: their signatures cover them. */
  | { type: 'thinking'; thinking: string; signature: string }
  | { type: 'redacted_thinking'; data: string }

export interface ModelParams {
  model: string
  system: Array<{ type: 'text'; text: string; cache_control?: { type: 'ephemeral' } }>
  tools: unknown[]
  messages: unknown[]
  max_tokens: number
  signal: AbortSignal
}

export interface ModelResult {
  content: ModelBlock[]
  stopReason: string
  usage: { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number | null; cache_creation_input_tokens?: number | null }
}

export type ModelTurn = (p: ModelParams, onText: (delta: string) => void) => Promise<ModelResult>

let override: ModelTurn | null = null
let fetchOverride: typeof fetch | null = null

/** Tests swap the model (never a real call); null puts the real one back. */
export function setAssistantModel(fn: ModelTurn | null): void {
  override = fn
}
/** Tests answer the real turn's HTTP call themselves (never the real API); null puts the network back. */
export function setAssistantFetch(f: typeof fetch | null): void {
  fetchOverride = f
}

export function modelAvailable(): boolean {
  return !!config.anthropicApiKey || override !== null
}

const validJson = (raw: string) => {
  try {
    JSON.parse(raw)
    return true
  } catch {
    return false
  }
}

/** The blocks as the stream delivered them, kept by index, with each tool call's raw input JSON. */
function tracker() {
  const blocks: Array<ModelBlock & { raw?: string }> = []
  let usage: ModelResult['usage'] = { input_tokens: 0, output_tokens: 0 }
  const onEvent = (e: Anthropic.Beta.Messages.BetaRawMessageStreamEvent) => {
    if (e.type === 'message_start') usage = { ...e.message.usage }
    else if (e.type === 'message_delta') usage = { ...usage, output_tokens: e.usage.output_tokens }
    else if (e.type === 'content_block_start') {
      const b = e.content_block
      if (b.type === 'text') blocks[e.index] = { type: 'text', text: b.text }
      else if (b.type === 'tool_use') blocks[e.index] = { type: 'tool_use', id: b.id, name: b.name, input: {}, raw: '' }
      else if (b.type === 'thinking') blocks[e.index] = { type: 'thinking', thinking: b.thinking, signature: b.signature }
      else if (b.type === 'redacted_thinking') blocks[e.index] = { type: 'redacted_thinking', data: b.data }
    } else if (e.type === 'content_block_delta') {
      const b = blocks[e.index]
      if (!b) return
      if (e.delta.type === 'text_delta' && b.type === 'text') b.text += e.delta.text
      else if (e.delta.type === 'input_json_delta' && b.type === 'tool_use') b.raw = (b.raw ?? '') + e.delta.partial_json
      else if (e.delta.type === 'thinking_delta' && b.type === 'thinking') b.thinking += e.delta.thinking
      else if (e.delta.type === 'signature_delta' && b.type === 'thinking') b.signature = e.delta.signature
    }
  }
  /** The tool calls whose input arrived as text JSON.parse refuses. */
  const broken = () => blocks.filter((b) => b?.type === 'tool_use' && b.raw && !validJson(b.raw))
  /** What arrived, the broken calls marked so they never run (their input is sent back as {}); nothing else runs either. */
  const partial = (): ModelResult => ({
    content: blocks.filter(Boolean).map((b) => {
      if (b.type !== 'tool_use') return b
      const { raw, ...rest } = b
      return raw && !validJson(raw) ? { ...rest, input: {}, invalidJson: raw } : { ...rest, input: raw ? JSON.parse(raw) : {} }
    }),
    stopReason: INVALID_TOOL_JSON,
    usage,
  })
  return { onEvent, broken, partial }
}

/**
 * The SDK's error for a tool input it couldn't parse at all (eager input streaming). The beta stream raises an
 * AnthropicError with this message and no cause; the plain stream wraps the parser's SyntaxError as the cause. The SDK
 * has no class of its own for it, so the message is the only mark. Network failures, aborts and API errors don't match.
 */
export function isToolJsonError(err: unknown): boolean {
  if (!(err instanceof Anthropic.AnthropicError) || err instanceof Anthropic.APIError) return false
  return (err as { cause?: unknown }).cause instanceof SyntaxError || err.message.startsWith('Unable to parse tool parameter JSON')
}

/**
 * The real turn: beta messages.stream (for the thinking-binding control) with text deltas passed on as they come, then
 * the final message. The request's signal aborts the HTTP call when the browser goes away. With eager input streaming a
 * tool input can arrive as broken JSON, which makes the SDK reject: only that case becomes a result (the broken call
 * marked, for the loop to answer with an error the model can retry from, and no other call run); everything else throws.
 */
const claudeTurn: ModelTurn = async (p, onText) => {
  const client = new Anthropic({ apiKey: config.anthropicApiKey!, maxRetries: 1, ...(fetchOverride ? { fetch: fetchOverride } : {}) })
  const stream = client.beta.messages.stream(
    {
      model: p.model,
      max_tokens: p.max_tokens,
      betas: [THINKING_BETA],
      thinking: THINKING,
      output_config: { effort: EFFORT },
      system: p.system,
      tools: p.tools as Anthropic.Beta.Messages.BetaToolUnion[],
      messages: p.messages as Anthropic.Beta.Messages.BetaMessageParam[],
    },
    { signal: p.signal },
  )
  const seen = tracker()
  stream.on('streamEvent', (e) => seen.onEvent(e))
  stream.on('text', (delta) => onText(delta))
  let message: Anthropic.Beta.Messages.BetaMessage
  try {
    message = await stream.finalMessage()
  } catch (err) {
    if (p.signal.aborted || !isToolJsonError(err) || !seen.broken().length) throw err
    return seen.partial()
  }
  // The SDK's parser is tolerant: input it read without throwing can still be broken JSON, silently cut short
  const bad = new Map(seen.broken().map((b) => [(b as { id: string }).id, (b as { raw?: string }).raw ?? '']))
  const content: ModelBlock[] = []
  for (const b of message.content) {
    if (b.type === 'text') content.push({ type: 'text', text: b.text })
    else if (b.type === 'tool_use') content.push(bad.has(b.id) ? { type: 'tool_use', id: b.id, name: b.name, input: {}, invalidJson: bad.get(b.id) } : { type: 'tool_use', id: b.id, name: b.name, input: b.input })
    else if (b.type === 'thinking') content.push({ type: 'thinking', thinking: b.thinking, signature: b.signature })
    else if (b.type === 'redacted_thinking') content.push({ type: 'redacted_thinking', data: b.data })
  }
  return {
    content,
    stopReason: message.stop_reason ?? 'end_turn',
    usage: {
      input_tokens: message.usage.input_tokens,
      output_tokens: message.usage.output_tokens,
      cache_read_input_tokens: message.usage.cache_read_input_tokens,
      cache_creation_input_tokens: message.usage.cache_creation_input_tokens,
    },
  }
}

export function assistantModel(): ModelTurn {
  return override ?? claudeTurn
}
