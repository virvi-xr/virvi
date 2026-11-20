// Virvi Assistant (LIV-155): the model seam. One streamed Claude call per loop step; tests swap in a scripted turn.
import Anthropic from '@anthropic-ai/sdk'
import { config } from '../config.js'

export const MAX_TOKENS = 2048

export interface ModelParams {
  model: string
  system: Array<{ type: 'text'; text: string; cache_control?: { type: 'ephemeral' } }>
  tools: unknown[]
  messages: unknown[]
  max_tokens: number
  signal: AbortSignal
}

export interface ModelResult {
  content: Array<{ type: 'text'; text: string } | { type: 'tool_use'; id: string; name: string; input: unknown }>
  stopReason: string
  usage: { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number | null; cache_creation_input_tokens?: number | null }
}

export type ModelTurn = (p: ModelParams, onText: (delta: string) => void) => Promise<ModelResult>

let override: ModelTurn | null = null

/** Tests swap the model (never a real call); null puts the real one back. */
export function setAssistantModel(fn: ModelTurn | null): void {
  override = fn
}

export function modelAvailable(): boolean {
  return !!config.anthropicApiKey || override !== null
}

/**
 * The real turn: messages.stream with text deltas passed on as they come, then the final message. The request's
 * signal aborts the HTTP call when the browser goes away. Only text and tool_use blocks come back: thinking blocks
 * (adaptive thinking is the model's default) are left out of the stored history, which the API accepts.
 */
const claudeTurn: ModelTurn = async (p, onText) => {
  const client = new Anthropic({ apiKey: config.anthropicApiKey!, maxRetries: 1 })
  const stream = client.messages.stream(
    {
      model: p.model,
      max_tokens: p.max_tokens,
      system: p.system,
      tools: p.tools as Anthropic.Messages.ToolUnion[],
      messages: p.messages as Anthropic.Messages.MessageParam[],
    },
    { signal: p.signal },
  )
  stream.on('text', (delta) => onText(delta))
  const message = await stream.finalMessage()
  const content: ModelResult['content'] = []
  for (const b of message.content) {
    if (b.type === 'text') content.push({ type: 'text', text: b.text })
    else if (b.type === 'tool_use') content.push({ type: 'tool_use', id: b.id, name: b.name, input: b.input })
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
