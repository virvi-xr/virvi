/**
 * The checkout page's Pay with MANA, as a pure state machine: idle → quoting → sending (the wallet is open) →
 * confirming (Polygon), or back to idle (the person said no), quoted (the wallet failed: a new price is needed) or
 * mismatch (for support). Each MANA attempt has a number: a quote or wallet answer for an earlier attempt never moves
 * the page, but a hash it returns is still reported against its own quote. Kept free of React so it tests in node.
 */
import type { ManaQuote } from './studio'

export type ManaState =
  | { step: 'idle'; attempt: number }
  | { step: 'quoting'; attempt: number }
  | { step: 'sending'; attempt: number; quote: ManaQuote }
  | { step: 'quoted'; attempt: number; quote: ManaQuote; error: string }
  | { step: 'confirming'; attempt: number; quote: ManaQuote; hash: string }
  | { step: 'mismatch'; attempt: number; hash: string; text: string }

export type ManaEvent =
  | { type: 'pay' } // the person asks for a (new) price
  | { type: 'quote'; attempt: number; quote: ManaQuote }
  | { type: 'quoteFailed'; attempt: number }
  | { type: 'rejected'; attempt: number } // the person said no in the wallet (4001): nothing was sent
  | { type: 'walletError'; attempt: number; text: string } // anything else: it may have been broadcast
  | { type: 'sent'; attempt: number; hash: string }
  | { type: 'txFailed'; attempt: number; text: string } // mined, but reverted: nothing was paid
  | { type: 'support'; attempt: number; hash: string; text: string } // doesn't match, too late, or the payment closed

export const MANA_IDLE: ManaState = { step: 'idle', attempt: 0 }

/** A price may be asked for only when no wallet prompt or confirmation is in flight. */
export const canQuote = (s: ManaState) => s.step === 'idle' || s.step === 'quoted'

export function manaReducer(s: ManaState, e: ManaEvent): ManaState {
  if (e.type === 'pay') return canQuote(s) ? { step: 'quoting', attempt: s.attempt + 1 } : s
  if (e.attempt !== s.attempt) return s // an earlier attempt's answer
  switch (e.type) {
    case 'quote': return s.step === 'quoting' ? { step: 'sending', attempt: s.attempt, quote: e.quote } : s
    case 'quoteFailed': return s.step === 'quoting' ? { step: 'idle', attempt: s.attempt } : s
    case 'rejected': return s.step === 'sending' ? { step: 'idle', attempt: s.attempt } : s
    case 'walletError': return s.step === 'sending' ? { step: 'quoted', attempt: s.attempt, quote: s.quote, error: e.text } : s
    case 'sent': return s.step === 'sending' ? { step: 'confirming', attempt: s.attempt, quote: s.quote, hash: e.hash } : s
    case 'txFailed': return s.step === 'confirming' ? { step: 'quoted', attempt: s.attempt, quote: s.quote, error: e.text } : s
    case 'support': return s.step === 'confirming' ? { step: 'mismatch', attempt: s.attempt, hash: e.hash, text: e.text } : s
  }
}

/**
 * What a hash the wallet returned for `attempt` (quoted as `quote`) leads to: follow it on this page, or, for an
 * attempt the page has moved on from, report it once against its own quote (the server settles it within the grace,
 * and a duplicate becomes credit) without moving the page.
 */
export function onSent(s: ManaState, attempt: number, quote: ManaQuote, hash: string): { follow: boolean; reportStale: { paymentId: string; hash: string } | null } {
  if (s.step === 'sending' && s.attempt === attempt) return { follow: true, reportStale: null }
  return { follow: false, reportStale: { paymentId: quote.paymentId, hash } }
}

/** One confirmation poll's answer, in the flow's terms. */
export type ConfirmOutcome = 'paid' | 'claimed' | 'retry' | { txFailed: true } | { support: 'tx_used' | 'mismatch' | 'closed' }

/** A `mana-tx` or payment poll answer (or refusal): keep going, finish, or stop. */
export function confirmOutcome(r: { reported?: 'granted' | 'confirming'; paymentStatus?: string; err?: { status?: number; body?: { code?: string } } }): ConfirmOutcome {
  if (r.reported === 'granted' || r.paymentStatus === 'paid') return 'paid'
  if (r.reported === 'confirming') return 'claimed'
  if (r.paymentStatus === 'expired') return { support: 'closed' } // the payment closed without this transaction settling it
  if (r.paymentStatus) return 'retry'
  const code = r.err?.body?.code
  const status = r.err?.status ?? 0
  if (code === 'tx_failed') return { txFailed: true }
  if (code === 'tx_used') return { support: 'tx_used' }
  // not mined yet, or the network or server hiccuped: ask again
  if (code === 'tx_not_found' || !(status >= 400 && status < 500)) return 'retry'
  return { support: 'mismatch' }
}

export type ManaView = {
  quote: ManaQuote | null
  expired: boolean
  message: string | null
  tone: 'status' | 'alert' | null
  /** `pay`: Pay with MANA; `requote`: Get a new price; null: nothing to press. */
  action: 'pay' | 'requote' | null
  /** Pay by card is open: nothing is in flight in a wallet or on Polygon. */
  cardOpen: boolean
}

export const CONFIRMING = 'Waiting for Polygon confirmations…'

export function manaView(s: ManaState, now: Date): ManaView {
  const quote = 'quote' in s ? s.quote : null
  const expired = !!quote && new Date(quote.expiresAt).getTime() <= now.getTime()
  switch (s.step) {
    case 'idle': return { quote, expired, message: null, tone: null, action: 'pay', cardOpen: true }
    case 'quoting': return { quote, expired, message: null, tone: null, action: null, cardOpen: false }
    case 'sending':
      // Never a new price while the wallet may still send this one: that could pay twice
      return {
        quote, expired, tone: 'status', action: null, cardOpen: false,
        message: expired
          ? 'This price has expired. Reject the payment in your wallet, then pay with MANA again for a new price.'
          : 'Confirm the payment in your wallet.',
      }
    case 'quoted':
      // The wallet may have broadcast it, so the same quote is never offered again: a new price only
      return { quote, expired, message: s.error, tone: 'alert', action: 'requote', cardOpen: true }
    case 'confirming': return { quote, expired: false, message: CONFIRMING, tone: 'status', action: null, cardOpen: false }
    case 'mismatch': return { quote, expired: false, message: s.text, tone: 'alert', action: null, cardOpen: true }
  }
}
