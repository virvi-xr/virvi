/** Trial sessions: reading "account required" refusals, the words for them, and the bridge to the sign-up sheet. */
import { readTrialSession } from './session'

export interface BlockedCtx { designName?: string; revisions?: number; /** The locked page's name, for a nav click. */ label?: string }
export interface SignUpRequest { action: string; ctx: BlockedCtx; /** Which tab the sheet opens on (default: create account). */ tab?: 'create' | 'signin' }

/** The refused action when an error is a trial's `403 account_required`, else null. */
export function accountRequired(err: unknown): { action: string } | null {
  const e = err as { status?: number; body?: { error?: string; action?: unknown } } | null
  if (e?.status !== 403 || e.body?.error !== 'account_required' || typeof e.body.action !== 'string') return null
  return { action: e.body.action }
}

const DEFAULT_TITLE = 'Create a free account to use this.'

/** `emphasis` is a part of `title` (the design's name) the sheet shows in italics. */
export function blockedCopy(action: string, ctx: BlockedCtx): { title: string; unlocks: string; emphasis?: string } {
  const name = ctx.designName?.trim()
  const revs = ctx.revisions
  if (action.startsWith('nav:')) {
    const label = ctx.label?.trim()
    return { title: `Create a free account to use ${label || 'this'}.`, unlocks: 'Your trial designs move into your account.' }
  }
  switch (action) {
    case 'POST /api/studio/designs/:id/finalize': {
      const saved = typeof revs === 'number' && revs > 0
        ? `Your design and its ${revs} revision${revs === 1 ? ' is' : 's are'} saved.`
        : 'Your design is saved.'
      return { title: `Create a free account to ${name ? `finalize ${name}` : 'finalize this design'}. ${saved}`, unlocks: 'Finalizing turns your design into a finished, wearable-ready set.', ...(name ? { emphasis: name } : {}) }
    }
    case 'GET /api/studio/designs/:id/packages':
    case 'GET /api/studio/designs/:id/pieces/:category/revisions/:number/package':
    case 'POST /api/studio/designs/:id/pieces/:category/revisions/:number/package/retry':
      return { title: 'Create a free account to download your design.', unlocks: 'Packages and downloads are ready to take with you once you have an account.' }
    case 'POST /api/studio/topups':
      return { title: 'Create a free account to get more prompts.', unlocks: 'Accounts can top up prompts and keep designing.' }
    case 'POST /api/studio/gift-codes/redeem':
      return { title: 'Create a free account to redeem a gift code.', unlocks: 'Gift codes add prompts to your account.' }
    case 'more_designs':
      return { title: 'Create a free account to start another design.', unlocks: 'Accounts can keep more designs open at once.' }
    case 'more_prompts':
      return { title: "Create a free account to keep designing. You've used your trial prompts.", unlocks: 'Your design and its revisions are saved to your account.' }
    case 'upload_more':
      return { title: 'Create a free account to upload more images.', unlocks: 'Accounts can add more reference images to a design.' }
    default:
      return { title: DEFAULT_TITLE, unlocks: 'Your trial designs move into your account.' }
  }
}

const ACTION_LABELS: Record<string, string> = {
  'POST /api/studio/designs/:id/finalize': 'Finalize',
  'GET /api/studio/designs/:id/packages': 'Download',
  'GET /api/studio/designs/:id/pieces/:category/revisions/:number/package': 'Download',
  'POST /api/studio/designs/:id/pieces/:category/revisions/:number/package/retry': 'Download',
  'POST /api/studio/topups': 'Buy prompts',
  'POST /api/studio/gift-codes/redeem': 'Redeem',
  more_designs: 'New design',
  more_prompts: 'Send',
  upload_more: 'Upload',
}

/** The one-time note after Google or Discord sign-in sent a visitor back; null when there was no blocked action. */
export function signedInNote(action: string | null): string | null {
  if (!action) return null
  const label = ACTION_LABELS[action]
  return label ? `You're signed in — press ${label} again` : "You're signed in"
}

/** A trial's tokens were refused as ended: swap to the account session another tab stored, or sign out. */
export function trialEndedOutcome(stored: { token: string; user?: unknown } | null, currentToken: string): 'swap' | 'logout' {
  const user = stored?.user as { trial?: boolean } | null | undefined
  return stored && stored.token !== currentToken && user && !user.trial ? 'swap' : 'logout'
}

/** A trial access token that has run out, or will within a minute: renew it before it carries the trial into a sign-up. */
export function trialBearerStale(token: string, now: number): boolean {
  return !readTrialSession(token, now + 60_000)
}

/**
 * The bearer to carry into a sign-up after renewing a stale trial token. A refused renewal (session gone) means the trial
 * is over: carry on as a plain sign-up. A renewal that could not reach the server keeps the session: stop, because a plain
 * sign-up then would leave the trial's work behind.
 */
export function renewedTrialBearer(fresh: string | null, sessionKept: boolean): string | null {
  if (fresh) return fresh
  if (sessionKept) throw new Error("Couldn't reach Virvi. Check your connection and try again.")
  return null
}

const TRIAL_START_COPY: Record<string, string> = {
  trial_limit: 'Free tries from this network are used up for today. Create a free account to keep going.',
  bot_check_failed: "We couldn't confirm you're human. Try again.",
  trials_unavailable: "Free tries aren't available right now. Create a free account to start.",
  bad_device: 'Something went wrong starting your trial. Reload the page and try again.',
}

/** A refused trial start (the server's error code) in the page's words. */
export function trialStartMessage(code: string | undefined): string {
  return (code && TRIAL_START_COPY[code]) || 'Something went wrong starting your trial. Try again in a moment.'
}

/** A device id made once and kept: the server counts trials per device. */
export function deviceId(storage: Pick<Storage, 'getItem' | 'setItem'> = localStorage): string {
  try {
    const have = storage.getItem('virvi.device')
    if (have) return have
  } catch {}
  const id = crypto.randomUUID()
  try { storage.setItem('virvi.device', id) } catch {}
  return id
}

// ── Bridge between apiFetch (which awaits a sign-up) and the one <SignUpSheet> in the root layout ──

type Listener = (req: SignUpRequest | null) => void
let listener: Listener | null = null
let pending: { req: SignUpRequest; promise: Promise<string>; resolve: (token: string) => void; reject: (e: Error) => void } | null = null

/** The sheet registers here; it gets the open request, or null when closed. Returns an unsubscribe. */
export function subscribeSignUp(fn: Listener): () => void {
  listener = fn
  if (pending) fn(pending.req)
  return () => { if (listener === fn) listener = null }
}

/** Opens the sheet and resolves with the new account token once an in-page sign-up completes. A second call while one is open joins it. */
export function openSignUp(req: SignUpRequest): Promise<string> {
  if (pending) return pending.promise
  if (!listener) return Promise.reject(new Error('closed'))
  let resolve!: (t: string) => void
  let reject!: (e: Error) => void
  const promise = new Promise<string>((res, rej) => { resolve = res; reject = rej })
  pending = { req, promise, resolve, reject }
  listener(req)
  return promise
}

function settle(): typeof pending {
  const p = pending
  pending = null
  listener?.(null)
  return p
}

export function resolveSignUp(token: string): void { settle()?.resolve(token) }
export function dismissSignUp(): void { settle()?.reject(new Error('closed')) }

const HANDOVER_KEY = 'virvi.trialHandover'
const HANDOVER_TTL_MS = 15 * 60_000
type KV = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

function randomState(): string {
  const b = new Uint8Array(18)
  crypto.getRandomValues(b)
  return btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/**
 * Before leaving for Google or Discord from a trial: keep the trial's token in this tab (sessionStorage) with a random
 * `state` for the sign-in to carry. Returns that state (null when there is no trial). Only a callback that brings the same
 * state back within 15 minutes gets the trial, so neither a crafted sign-in link nor a crafted callback can move it.
 */
export function stashTrialHandover(storage: KV, stored: { token: string; refresh?: string | null; user: unknown } | null, fromAction: string | undefined, now: number): string | null {
  storage.removeItem(HANDOVER_KEY)
  if (!stored || !(stored.user as { trial?: boolean } | null)?.trial) return null
  const state = randomState()
  storage.setItem(HANDOVER_KEY, JSON.stringify({ trialToken: stored.refresh || stored.token, state, at: now, ...(fromAction ? { fromAction } : {}) }))
  return state
}

/** The hand-over for the sign-in that returned `state`, once (the entry is always removed), or null. */
export function takeTrialHandover(storage: KV, state: string | null, now: number): { trialToken: string; fromAction?: string } | null {
  const raw = storage.getItem(HANDOVER_KEY)
  storage.removeItem(HANDOVER_KEY)
  if (!raw || !state) return null
  try {
    const v = JSON.parse(raw)
    if (typeof v?.trialToken !== 'string' || v.state !== state || typeof v.at !== 'number' || now - v.at > HANDOVER_TTL_MS) return null
    return { trialToken: v.trialToken, ...(v.fromAction ? { fromAction: v.fromAction } : {}) }
  } catch {
    return null
  }
}
