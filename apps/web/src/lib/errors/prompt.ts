import { errorSignature, expectedReason, promptDecision, type ClientErrorEvent, type PromptFacts, type PromptKind } from '@virvixr/shared'

/**
 * Asking users about errors only when it helps (LIV-66 §4), the browser's part. Pure: reporter.ts asks the server
 * (`POST /api/errors/prompt`) and shows the toast. An account's 24-hour and opt-out state lives on the server; a
 * guest's or trial's in localStorage, applied here with the same shared rule.
 */

export { promptDecision }

/** The server's answer. `saved`: an account's state was applied there; otherwise the browser applies its own. */
export interface PromptAnswer {
  prompt: PromptKind
  saved: boolean
  signature: string
  facts: PromptFacts
}

/**
 * Worth asking the server about: an error that broke something the user was doing (a call site marked it a user
 * action), not an expected 4xx. Never a background error, and never a crash screen (it has its own Report button).
 */
export function shouldCheckPrompt(e: ClientErrorEvent): boolean {
  if (!e.userFacing || e.kind === 'crash' || e.kind === 'report') return false
  if (e.kind === 'api' && e.status !== undefined && expectedReason(e.status)) return false
  return true
}

/** One check per signature per page: the same grouping the server uses. */
export const promptKey = (e: ClientErrorEvent) =>
  errorSignature({ kind: e.kind, status: e.status, method: e.method, path: e.path, errorType: e.errorType, message: e.message, stack: e.stack })

/** The check's body: only what signs the error. No breadcrumbs, error body, page, scene or request id. */
export function promptRequestBody(e: ClientErrorEvent): string {
  const { kind, t, method, path, status, errorType, message, stack, userFacing } = e
  return JSON.stringify({ v: 1, event: { kind, t, method, path, status, errorType, message, stack, userFacing } })
}

export const LOCAL_KEY = 'virvi.errorPrompts'
const MAX_KNOWN = 200

export interface LocalPromptState {
  askedAt: number | null
  optedOut: boolean
  /** Signatures "we know about this" was shown for (newest last). */
  known: string[]
}

const fresh = (): LocalPromptState => ({ askedAt: null, optedOut: false, known: [] })

export function readLocal(storage: Pick<Storage, 'getItem'> | null): LocalPromptState {
  try {
    const raw = storage?.getItem(LOCAL_KEY)
    if (!raw) return fresh()
    const v = JSON.parse(raw) as Partial<LocalPromptState>
    return {
      askedAt: typeof v.askedAt === 'number' ? v.askedAt : null,
      optedOut: v.optedOut === true,
      known: Array.isArray(v.known) ? v.known.filter((k): k is string => typeof k === 'string').slice(-MAX_KNOWN) : [],
    }
  } catch {
    return fresh()
  }
}

export function writeLocal(storage: Pick<Storage, 'setItem'> | null, s: LocalPromptState): void {
  try { storage?.setItem(LOCAL_KEY, JSON.stringify(s)) } catch { /* private mode, full storage: no state kept */ }
}

/** What to show, and the guest's state after it. An account's answer is final (the server applied its state). */
export function decideFromAnswer(a: PromptAnswer, local: LocalPromptState, now: number): { prompt: PromptKind; local: LocalPromptState } {
  if (a.saved) return { prompt: a.prompt, local }
  // The server's `none` with userFacing set means it is expected (or overflow): nothing to decide
  const prompt = promptDecision(true, a.facts, { askedAt: local.askedAt, optedOut: local.optedOut, knownShown: local.known.includes(a.signature) }, now)
  if (prompt === 'ask') return { prompt, local: { ...local, askedAt: now } }
  if (prompt === 'known') return { prompt, local: { ...local, known: [...local.known.filter((k) => k !== a.signature), a.signature].slice(-MAX_KNOWN) } }
  return { prompt, local }
}
