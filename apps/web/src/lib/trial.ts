/** Trial sessions: reading "account required" refusals, the words for them, and the bridge to the sign-up sheet. */

export interface BlockedCtx { designName?: string; revisions?: number }
export interface SignUpRequest { action: string; ctx: BlockedCtx }

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

/** A trial's tokens were refused as ended: swap to the account session another tab stored, or sign out. */
export function trialEndedOutcome(stored: { token: string; user?: unknown } | null, currentToken: string): 'swap' | 'logout' {
  const user = stored?.user as { trial?: boolean } | null | undefined
  return stored && stored.token !== currentToken && user && !user.trial ? 'swap' : 'logout'
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
