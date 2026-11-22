import type { ToolCtx } from './types.js'

const REF = /^\[?wallet (\d+)\]?$/i
const FULL = /^0x[0-9a-f]{40}$/i

/**
 * A wallet a tool argument names: a `[wallet N]` reference from this conversation, or one of the user's own wallets.
 * Any other full address is refused: the model only ever learns other people's wallets as references. Lowercase, or null.
 */
export function resolveWallet(value: string, ctx: ToolCtx): string | null {
  const v = value.trim()
  const ref = REF.exec(v)
  if (ref) return ctx.walletRefs[Number(ref[1]) - 1] ?? null
  if (!FULL.test(v)) return null
  const w = v.toLowerCase()
  return ctx.self.wallets.some((own) => own.toLowerCase() === w) ? w : null
}

/** 0x1234…abcd: short enough that redaction (40+ hex) never masks it. */
export function shortWallet(wallet: string): string {
  return `${wallet.slice(0, 6)}…${wallet.slice(-4)}`
}
