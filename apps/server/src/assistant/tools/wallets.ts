import type { ToolCtx } from './types.js'

const REF = /^\[?wallet (\d+)\]?$/i
const FULL = /^0x[0-9a-f]{40}$/i

/** A wallet a tool argument names: a `[wallet N]` reference from this conversation or a full address. Lowercase, or null. */
export function resolveWallet(value: string, ctx: ToolCtx): string | null {
  const v = value.trim()
  const ref = REF.exec(v)
  if (ref) return ctx.walletRefs[Number(ref[1]) - 1] ?? null
  return FULL.test(v) ? v.toLowerCase() : null
}

/** 0x1234…abcd: short enough that redaction (40+ hex) never masks it. */
export function shortWallet(wallet: string): string {
  return `${wallet.slice(0, 6)}…${wallet.slice(-4)}`
}
