/**
 * What a model call costs, in USD. Prices are per million tokens, from Anthropic's published rates (claude-api skill,
 * 2026-10 table). Cache writes are the 5-minute kind at 1.25x the input price; the assistant never asks for the 1-hour
 * TTL. An unknown model throws at call time, so a bad ASSISTANT_MODEL fails loudly instead of metering at zero.
 */
export interface ModelPrice {
  inPerMTok: number
  outPerMTok: number
  cacheReadPerMTok: number
  cacheWritePerMTok: number
}

const PRICES: Record<string, ModelPrice> = {
  'claude-sonnet-5-5': { inPerMTok: 2, outPerMTok: 10, cacheReadPerMTok: 0.2, cacheWritePerMTok: 2.5 },
  'claude-opus-5-5': { inPerMTok: 4, outPerMTok: 20, cacheReadPerMTok: 0.2, cacheWritePerMTok: 5 },
}

export function modelPrice(model: string): ModelPrice {
  const p = PRICES[model]
  if (!p) throw new Error(`No price known for assistant model "${model}"; add it to assistant/pricing.ts`)
  return p
}

export interface CallUsage {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens?: number | null
  cache_creation_input_tokens?: number | null
}

export function callCostUsd(model: string, usage: CallUsage): number {
  const p = modelPrice(model)
  return (
    usage.input_tokens * p.inPerMTok +
    usage.output_tokens * p.outPerMTok +
    (usage.cache_read_input_tokens ?? 0) * p.cacheReadPerMTok +
    (usage.cache_creation_input_tokens ?? 0) * p.cacheWritePerMTok
  ) / 1_000_000
}
