import { describe, it, expect } from 'vitest'
import {
  canSend, checkoutBody, composerState, reloadsOn, revisionActions, viewButtonRendering, dialogTotal, finalizeStrip, triangleWarning, frameAt, paymentBanner, initialTicks, nextPoll, pieceTabStatus, progressFor, slotSelection, stageState, viewKey,
  type FinalizedRevision, type Quote, type QuoteLine, type StudioDetail, type StudioPiece, type StudioEvent, type StudioProposal,
} from './studio'
import { formatBytesShort, uploadProblem } from './studio'
import { HELD_REPORT_COPY, PAUSED_NOTE, flagSummary, reportCopy, type AdminStudioFlag } from './studio'
import { giftCodeStatus } from './studio'
import { AGENTS, DEFAULT_AGENT, agentLabel, otherAgents, designBadge, designIdFromPath, formatCents, refreshDue, giftRedeemMessage, giftRedeemSuccess, refusalMessage, relativeTime, untilReset, usageLine, type StudioDesign, type StudioUsage } from './studio'

const NOW = new Date('2026-10-29T21:55:00Z')
const at = (ms: number) => new Date(NOW.getTime() + ms).toISOString()
const MIN = 60_000

describe('AGENTS', () => {
  it('offers Claude Code, Codex and Grok Build, none of them coming soon', () => {
    expect(AGENTS).toEqual([
      { id: 'claude', label: 'Claude Code' },
      { id: 'codex', label: 'Codex' },
      { id: 'grok', label: 'Grok Build' },
    ])
    expect(AGENTS.every((a) => !('soon' in a))).toBe(true)
  })
  it('preselects Codex, the cheapest, and lists the others under Change agent', () => {
    expect(DEFAULT_AGENT).toBe('codex')
    expect(otherAgents('codex').map((a) => a.id)).toEqual(['claude'])
    expect(otherAgents('claude').map((a) => a.id)).toEqual(['codex'])
  })
  it('no longer offers Grok Build, but a design already on it keeps its name and can switch away', () => {
    expect(otherAgents('grok').map((a) => a.id)).toEqual(['claude', 'codex'])
    expect(agentLabel('grok')).toBe('Grok Build')
  })
})

describe('refusalMessage', () => {
  const r = (code: string, body: Record<string, unknown> = {}, status = 409) => refusalMessage({ status, body: { code, ...body } }, NOW)

  it('names when the allowance comes back and offers a top-up', () => {
    expect(r('allowance', { resetsAt: at(125 * MIN) }, 429)).toEqual({
      text: 'You’ve used today’s prompts. More at midnight UTC (in 2 h 5 min).',
      action: 'topup',
    })
  })
  it('never shows the cost ceiling’s numbers', () => {
    const m = r('cost_ceiling', { resetsAt: at(125 * MIN) }, 429)
    expect(m.text).toBe('The studio needs a rest for today. Come back tomorrow.')
    expect(m.text).not.toMatch(/\d/)
    expect(m.action).toBeUndefined()
  })
  it('says the agent is busy', () => {
    expect(r('busy').text).toBe('The agent is still working on your last message.')
  })
  it('points the open-design limit at settings', () => {
    expect(r('open_design_limit', {}, 403)).toEqual({
      text: 'Your plan has room for one open design. Archive or finalize the one you have, or upgrade.',
      action: 'settings',
    })
  })
  it('names the pieces that failed the checker and offers the free fix', () => {
    expect(r('checks_failed', { categories: ['hat', 'feet'] })).toEqual({
      text: 'hat and feet failed the checker. Ask the agent to fix it: it doesn’t use a prompt.',
      action: 'fix',
    })
    expect(r('checks_failed', { categories: ['upper_body'] }).text).toMatch(/^upper body failed/)
  })
  it('explains payments being off and Stripe not answering', () => {
    expect(r('payments_unavailable', {}, 503).text).toBe('Payments aren’t available right now.')
    expect(r('stripe_error', {}, 502).text).toBe('Stripe didn’t answer. Try again in a moment.')
    expect(r('free_finalize_busy').text).toBe('Your free finalize is held by another checkout. Try again in a few minutes.')
  })
  it('falls back to plain words for anything else', () => {
    expect(r('who_knows')).toEqual({ text: 'Something went wrong. Try again.' })
    expect(refusalMessage({}, NOW)).toEqual({ text: 'Something went wrong. Try again.' })
  })
})

describe('formatCents', () => {
  it('drops zero cents and keeps the rest', () => {
    expect(formatCents(2900)).toBe('$29')
    expect(formatCents(1950)).toBe('$19.50')
    expect(formatCents(0)).toBe('$0')
  })
})

describe('untilReset', () => {
  it('counts hours and minutes, or minutes alone under an hour', () => {
    expect(untilReset(at(20 * MIN), NOW)).toBe('20 min')
    expect(untilReset(at(180 * MIN), NOW)).toBe('3 h 0 min')
    expect(untilReset(at(-5 * MIN), NOW)).toBe('0 min')
  })
})

describe('designIdFromPath', () => {
  const id = '2f1c6a0e-8d3b-4c1a-9f6e-0b7d5e4a3c21'
  it('reads the design id from the path in a static export', () => {
    expect(designIdFromPath(`/studio/${id}/`)).toBe(id)
    expect(designIdFromPath(`/studio/${id}`, '_')).toBe(id)
  })
  it('refuses the placeholder and anything that is not a uuid', () => {
    expect(designIdFromPath('/studio/_/')).toBeNull()
    expect(designIdFromPath('/studio/not-a-design/')).toBeNull()
    expect(designIdFromPath('/studio/')).toBeNull()
  })
  it('prefers a real route param', () => {
    expect(designIdFromPath('/studio/_/', id)).toBe(id)
  })
})

describe('refreshDue', () => {
  it('re-reads frame urls after 45 minutes, well before they expire', () => {
    const t0 = 1_000_000
    expect(refreshDue(t0, t0 + 44 * MIN)).toBe(false)
    expect(refreshDue(t0, t0 + 46 * MIN)).toBe(true)
  })
})

describe('designBadge', () => {
  const d = (over: Partial<StudioDesign>): StudioDesign => ({
    id: 'd1', name: 'Cap', kind: 'wearable', agent: 'claude', status: 'idle', archivedAt: null, lastJobAt: null,
    finalizedAt: null, createdAt: NOW.toISOString(), ...over,
  })
  it('names each state', () => {
    expect(designBadge(d({}))).toEqual({ label: 'Draft', tone: 'violet' })
    expect(designBadge(d({ status: 'building' }))).toEqual({ label: 'Building', tone: 'info' })
    expect(designBadge(d({ finalizedAt: NOW.toISOString() }))).toEqual({ label: 'Finalized', tone: 'success' })
    expect(designBadge(d({ archivedAt: NOW.toISOString() }))).toEqual({ label: 'Archived', tone: 'neutral' })
  })
  it('lets archived win over finalized', () => {
    expect(designBadge(d({ archivedAt: NOW.toISOString(), finalizedAt: NOW.toISOString(), status: 'building' })).label).toBe('Archived')
  })
})

describe('relativeTime', () => {
  it('reads as plain words', () => {
    expect(relativeTime(at(-20 * 1000), NOW)).toBe('just now')
    expect(relativeTime(at(-5 * MIN), NOW)).toBe('5 min ago')
    expect(relativeTime(at(-3 * 60 * MIN), NOW)).toBe('3 h ago')
    expect(relativeTime(at(-50 * 60 * MIN), NOW)).toBe('2 days ago')
    expect(relativeTime(at(-25 * 60 * MIN), NOW)).toBe('1 day ago')
  })
})

describe('usageLine', () => {
  const u: StudioUsage = { plan: 'free', promptsLeft: 3, credits: 0, allowance: 3, resetsAt: NOW.toISOString(), openDesigns: 0, openDesignLimit: 1, topup: { cents: 500, prompts: 10 }, paused: false, giftedPrompts: 0, freeFinalizes: { available: 0, held: 0 } }
  it('names the plan and the prompts left, and bought prompts when there are any', () => {
    expect(usageLine(u)).toBe('free plan · 3 prompts left today')
    expect(usageLine({ ...u, credits: 7 })).toBe('free plan · 3 prompts left today · 7 bought')
  })
  it('adds free finalizes when there are any, and those held by an open checkout', () => {
    expect(usageLine({ ...u, freeFinalizes: { available: 1, held: 0 } })).toBe('free plan · 3 prompts left today · 1 free finalize')
    expect(usageLine({ ...u, freeFinalizes: { available: 2, held: 0 } })).toBe('free plan · 3 prompts left today · 2 free finalizes')
    expect(usageLine({ ...u, freeFinalizes: { available: 0, held: 1 } })).toBe('free plan · 3 prompts left today · 1 free finalize held by an open checkout')
    expect(usageLine({ ...u, freeFinalizes: { available: 2, held: 2 } })).toBe('free plan · 3 prompts left today · 2 free finalizes · 2 free finalizes held by an open checkout')
  })
})

const usage = (over: Partial<StudioUsage> = {}): StudioUsage => ({
  plan: 'free', promptsLeft: 3, credits: 0, allowance: 3, resetsAt: at(125 * MIN), openDesigns: 1, openDesignLimit: 1,
  topup: { cents: 500, prompts: 10 }, paused: false, giftedPrompts: 0, freeFinalizes: { available: 0, held: 0 }, ...over,
})
const detail = (over: Partial<StudioDetail> = {}): StudioDetail => ({
  design: { id: 'd1', name: 'Cap', kind: 'wearable', agent: 'claude', status: 'idle', archivedAt: null, lastJobAt: null, finalizedAt: null, createdAt: NOW.toISOString() },
  pieces: [], messages: [], activeJob: null, lastPrompt: null, uploads: [],
  set: { revisions: '', views: {}, checks: [], freeFixesLeft: {} }, ...over,
})

describe('progressFor', () => {
  const ev: StudioEvent[] = [
    { type: 'phase', jobId: 'j1', phase: 'building' },
    { type: 'progress', jobId: 'j1', text: 'Shaping the brim so it clears the hair' },
    { type: 'progress', jobId: 'j1', text: 'Running: blender -b /opt/assets/AvatarShape_A.blend --python build_cap.py' },
    { type: 'progress', jobId: 'other', text: 'Not this job' },
  ]
  it('skips the agent’s commands and keeps its note', () => {
    expect(progressFor(ev, 'j1')).toBe('Shaping the brim so it clears the hair')
  })
  it('shortens file paths to their last segment', () => {
    expect(progressFor([{ type: 'progress', jobId: 'j1', text: 'Wrote /work/design/out/hat/cap.glb and /tmp/x/y.png' }], 'j1'))
      .toBe('Wrote cap.glb and y.png')
  })
  it('falls back to the phase in plain words', () => {
    expect(progressFor([{ type: 'phase', jobId: 'j1', phase: 'checking' }], 'j1')).toBe('Running the checks…')
    expect(progressFor([{ type: 'phase', jobId: 'j1', phase: 'packaging' }], 'j1')).toBe('Packaging your files…')
  })
  it('shows a later phase over an older note', () => {
    expect(progressFor([...ev, { type: 'phase', jobId: 'j1', phase: 'rendering' }], 'j1')).toBe('Rendering the preview…')
  })
  it('is null with nothing heard for the job', () => {
    expect(progressFor(ev, 'j9')).toBeNull()
  })
})

describe('slot proposals', () => {
  const proposal: StudioProposal = { slots: [
    { category: 'hat', recommended: true }, { category: 'eyewear', recommended: true },
    { category: 'upper_body', recommended: false }, { category: 'feet', recommended: false },
  ] }
  it('cannot build with nothing ticked', () => {
    expect(slotSelection(proposal, new Set())).toEqual({ canBuild: false, slots: [] })
  })
  it('builds the ticked slots in the proposal’s order', () => {
    expect(slotSelection(proposal, new Set(['feet', 'eyewear']))).toEqual({ canBuild: true, slots: ['eyewear', 'feet'] })
  })
  it('starts with the recommended slots ticked', () => {
    expect([...initialTicks(proposal)]).toEqual(['hat', 'eyewear'])
  })
})

describe('nextPoll', () => {
  const active = detail({ activeJob: { id: 'j1', type: 'prompt', status: 'taken' } })
  it('does not poll an idle design', () => {
    expect(nextPoll(detail(), false)).toBeNull()
  })
  it('polls often while the room is down and rarely while it is up', () => {
    expect(nextPoll(active, false)).toBe(5000)
    expect(nextPoll(active, true)).toBe(30000)
  })
})

describe('composerState', () => {
  it('is busy while a prompt runs', () => {
    expect(composerState(detail({ activeJob: { id: 'j1', type: 'prompt', status: 'queued' } }), usage(), NOW).mode).toBe('busy')
  })
  it('offers Continue after the agent stopped at its cost limit', () => {
    expect(composerState(detail({ lastPrompt: { jobId: 'j1', outcome: 'ceiling', status: 'done' } }), usage(), NOW).mode).toBe('continue')
  })
  it('offers Continue after the agent stopped at its step limit', () => {
    expect(composerState(detail({ lastPrompt: { jobId: 'j1', outcome: 'turns', status: 'done' } }), usage(), NOW).mode).toBe('continue')
  })
  it('is out of prompts with the allowance copy', () => {
    expect(composerState(detail(), usage({ promptsLeft: 0 }), NOW)).toEqual({
      mode: 'out', note: 'You’ve used today’s prompts. More at midnight UTC (in 2 h 5 min).',
    })
  })
  it('sends otherwise, noting the prompts left and the plan', () => {
    expect(composerState(detail(), usage(), NOW)).toEqual({ mode: 'send', note: '3 prompts left today · free plan' })
    expect(composerState(detail({ activeJob: { id: 'r1', type: 'render', status: 'queued' } }), usage(), NOW).mode).toBe('send')
  })
  it('takes no prompts on an archived design', () => {
    expect(composerState(detail({ design: { ...detail().design, archivedAt: NOW.toISOString() } }), usage(), NOW))
      .toEqual({ mode: 'archived', note: 'This design is archived. Unarchive it to keep working on it.' })
  })
})

describe('viewKey', () => {
  it('matches the server’s keys', () => {
    expect(viewKey('wearable', { bodyShape: 'male', outfit: 'default', emote: null })).toBe('spin-male-default')
    expect(viewKey('wearable', { bodyShape: 'female', outfit: 'outfit-2', emote: 'dance' })).toBe('spin-female-outfit-2-dance')
    expect(viewKey('emote', { bodyShape: 'male', outfit: 'default', emote: null })).toBe('emote-male-default')
  })
})

describe('frameAt', () => {
  it('turns one full turn per stage width, the way the cursor moves', () => {
    expect(frameAt(0, 0, 400, 36)).toBe(0)
    expect(frameAt(0, 400, 400, 36)).toBe(0)
    expect(frameAt(0, 100, 400, 36)).toBe(27)
    expect(frameAt(5, -60, 400, 36)).toBe(10)
  })
  it('stays put on a stage with no width', () => {
    expect(frameAt(7, 50, 0, 36)).toBe(7)
  })
})

const piece = (over: Partial<StudioPiece> = {}): StudioPiece => ({
  id: 'p1', category: 'hat', name: 'Neon Cap',
  revision: { number: 2, changeKind: 'changed', checker: { pass: true, failures: 0, warnings: 0 }, createdAt: NOW.toISOString() },
  renders: {}, finalized: [], ...over,
})

describe('stageState', () => {
  const key = 'spin-male-default'
  it('says so when nothing is built yet', () => {
    expect(stageState(undefined, key, new Set())).toEqual({ kind: 'empty', text: 'The agent hasn’t built anything yet. Describe what you want on the left.' })
  })
  it('shows a ready view’s frames', () => {
    const p = piece({ renders: { [key]: { status: 'ready', frames: 2, urls: ['a', 'b'], renderedAt: NOW.toISOString() } } })
    expect(stageState(p, key, new Set())).toEqual({ kind: 'frames', urls: ['a', 'b'], renderedAt: NOW.toISOString() })
  })
  it('offers a retry for a view that failed', () => {
    const p = piece({ renders: { [key]: { status: 'failed', frames: 0, urls: [], renderedAt: NOW.toISOString() } } })
    expect(stageState(p, key, new Set())).toEqual({ kind: 'empty', text: 'That view didn’t render. Pick it again to retry.' })
    expect(stageState(p, key, new Set([key]))).toEqual({ kind: 'rendering' })
  })
  it('is rendering once asked for, or while queued', () => {
    expect(stageState(piece(), key, new Set([key]))).toEqual({ kind: 'rendering' })
    const queued = piece({ renders: { [key]: { status: 'queued', frames: 0, urls: [], renderedAt: NOW.toISOString() } } })
    expect(stageState(queued, key, new Set())).toEqual({ kind: 'rendering' })
  })
  it('never shows an empty frame list as a picture', () => {
    const p = piece({ renders: { [key]: { status: 'ready', frames: 0, urls: [], renderedAt: NOW.toISOString() } } })
    expect(stageState(p, key, new Set()).kind).toBe('empty')
  })
})

describe('pieceTabStatus', () => {
  it('is building while a prompt runs, ready with a revision, new otherwise', () => {
    const busy = detail({ activeJob: { id: 'j1', type: 'prompt', status: 'taken' } })
    expect(pieceTabStatus(piece(), busy)).toBe('building')
    expect(pieceTabStatus(piece({ revision: null }), busy)).toBe('building')
    expect(pieceTabStatus(piece(), detail())).toBe('ready')
    expect(pieceTabStatus(piece({ revision: null }), detail())).toBe('new')
    expect(pieceTabStatus(piece(), detail({ activeJob: { id: 'r1', type: 'render', status: 'queued' } }))).toBe('ready')
  })
})

const line = (over: Partial<QuoteLine>): QuoteLine => ({
  category: 'hat', revisionId: 'r1', revisionNumber: 1, pieceName: 'Neon Cap', priceKind: 'first', amountCents: 2900, waived: false, ...over,
})
const quote = (lines: QuoteLine[], over: Partial<Quote> = {}): Quote => ({
  pieces: [], lines, totalCents: lines.reduce((n, l) => n + (l.waived ? 0 : l.amountCents), 0), blocked: [], giftsUsed: 0, reportsHeld: [], notes: [], ...over,
})

describe('finalizeStrip', () => {
  it('prices the finalize and says what it unlocks', () => {
    expect(finalizeStrip(quote([line({})]), 'wearable')).toEqual({
      unlocks: 'Finalize to get the GLBs, thumbnail, Builder settings, listing text, curation report, renders and a promo clip.',
      button: 'Finalize · $29',
      blocked: null,
      warnings: [],
    })
    expect(finalizeStrip(quote([line({ category: 'emote', amountCents: 1500 })]), 'emote').unlocks)
      .toBe('Finalize to get the GLB, thumbnail, emote report, renders and a promo clip.')
  })
  it('has no button with nothing to pay for', () => {
    expect(finalizeStrip(quote([]), 'wearable').button).toBeNull()
    expect(finalizeStrip(null, 'wearable').button).toBeNull()
  })
  it('warns about a piece over its triangle budget without blocking it', () => {
    const over = { category: 'earring', name: 'Neon Hoops', revisionNumber: 1, revisionId: 'r1', state: 'payable' as const, kind: 'first' as const,
      checker: { pass: true, failures: 0, warnings: 1, triangles: { count: 1346, limit: 500 } } }
    const strip = finalizeStrip(quote([line({ category: 'earring' })], { pieces: [over] }), 'wearable')
    expect(strip.blocked).toBeNull()
    expect(strip.button).toBe('Finalize · $29')
    expect(strip.warnings).toEqual([
      'Neon Hoops has 1,346 triangles, more than the 500 Decentraland recommends for an earring. You can still finalize and deploy it.'])
  })
  it('names the pieces the checker blocks', () => {
    expect(finalizeStrip(quote([], { blocked: ['feet'] }), 'wearable').blocked)
      .toBe('feet failed the checker. Ask the agent to fix it: it doesn’t use a prompt.')
  })
})

describe('checkoutBody', () => {
  it('sends only reports of 10 to 2000 characters, trimmed', () => {
    expect(checkoutBody({ hat: '  the brim clips the hair  ', feet: 'bad' })).toEqual({ reports: { hat: 'the brim clips the hair' } })
    expect(checkoutBody({ feet: 'short' })).toEqual({})
    expect(checkoutBody({ feet: 'x'.repeat(2001) })).toEqual({})
  })
})

describe('dialogTotal', () => {
  it('leaves out the lines reported as the agent’s mistake', () => {
    const q = quote([line({ priceKind: 'revision', amountCents: 1500 }), line({ category: 'feet', priceKind: 'revision_extra', amountCents: 1000 })])
    expect(dialogTotal(q, ['hat'])).toBe(1000)
    expect(dialogTotal(q, [])).toBe(2500)
  })
})

describe('dialogTotal with gift lines', () => {
  it('counts a gift line as 0, reported or not', () => {
    const q = quote([line({ priceKind: 'revision', amountCents: 1500, gift: true }), line({ category: 'feet', priceKind: 'revision_extra', amountCents: 1000 })])
    expect(dialogTotal(q, [])).toBe(1000)
    expect(dialogTotal(q, ['hat'])).toBe(1000)
    expect(dialogTotal(q, ['feet'])).toBe(0)
  })
})

describe('giftRedeemMessage', () => {
  const refused = (status: number, error: string) => ({ status, body: { error } })
  it('says why a code was refused', () => {
    expect(giftRedeemMessage(refused(404, 'unknown_code'))).toBe("That code isn't right. Check it and try again.")
    expect(giftRedeemMessage(refused(410, 'code_off'))).toBe('That code has been turned off.')
    expect(giftRedeemMessage(refused(410, 'code_expired'))).toBe('That code has expired.')
    expect(giftRedeemMessage(refused(410, 'code_used_up'))).toBe('That code has been used up.')
    expect(giftRedeemMessage(refused(409, 'already_redeemed'))).toBe("You've already used that code.")
  })
  it('says to wait when rate-limited, and falls back otherwise', () => {
    expect(giftRedeemMessage({ status: 429, body: { error: 'rate_limited' } })).toBe('Too many tries. Try again in an hour.')
    expect(giftRedeemMessage({ status: 400 })).toBe("That code isn't right. Check it and try again.")
    expect(giftRedeemMessage({ status: 500 })).toBe('Something went wrong. Try again.')
  })
})

describe('giftRedeemSuccess', () => {
  it('lists what was added, leaving out a zero part', () => {
    expect(giftRedeemSuccess({ prompts: 20, finalizes: 1 })).toBe('Added 20 prompts and 1 free finalize.')
    expect(giftRedeemSuccess({ prompts: 1, finalizes: 2 })).toBe('Added 1 prompt and 2 free finalizes.')
    expect(giftRedeemSuccess({ prompts: 20, finalizes: 0 })).toBe('Added 20 prompts.')
    expect(giftRedeemSuccess({ prompts: 0, finalizes: 3 })).toBe('Added 3 free finalizes.')
  })
})

describe('paymentBanner', () => {
  const started = NOW.getTime()
  const paid = (status: string) => detail({ pieces: [piece({ finalized: [{
    revision: 2, kind: 'revision', status, amountCents: 1500, paymentId: 'pay1', paidAt: at(10_000), report: null, reportableUntil: null,
  }] })] })
  it('shows nothing without a payment in the URL', () => {
    expect(paymentBanner(null, paid('ready'), started, NOW)).toBeNull()
  })
  it('says the files are being packaged until they are ready', () => {
    expect(paymentBanner('pay1', detail(), started, new Date(started + 30_000))).toEqual({ kind: 'packaging', text: 'Payment received. Packaging your files…' })
    expect(paymentBanner('pay1', paid('packaging'), started, NOW)).toEqual({ kind: 'packaging', text: 'Payment received. Packaging your files…' })
    expect(paymentBanner('pay1', paid('ready'), started, NOW)).toEqual({ kind: 'ready', text: 'Your files are ready below.' })
  })
  it('stops claiming the payment after two minutes with nothing', () => {
    expect(paymentBanner('pay1', detail(), started, new Date(started + 121_000))).toEqual({
      kind: 'slow', text: 'Stripe hasn’t confirmed the payment yet. This page will update when it does.',
    })
  })
  it('points at the retry when packaging failed', () => {
    expect(paymentBanner('pay1', paid('failed'), started, NOW)?.kind).toBe('failed')
  })
  it('waits for the revision this payment bought, not one bought earlier', () => {
    const earlier = detail({ pieces: [piece({ finalized: [{
      revision: 1, kind: 'first', status: 'ready', amountCents: 2900, paymentId: 'pay0', paidAt: at(-20 * MIN), report: null, reportableUntil: null,
    }] })] })
    expect(paymentBanner('pay1', earlier, started, NOW)?.kind).toBe('packaging')
  })
})

describe('revisionActions', () => {
  const f = (over: Partial<FinalizedRevision> = {}): FinalizedRevision => ({
    revision: 2, kind: 'revision', status: 'ready', amountCents: 1500, paymentId: 'pay1', paidAt: at(-3600_000), report: null,
    reportableUntil: at(13 * 24 * 3600_000), ...over,
  })
  it('downloads a ready package, waits on packaging, retries a failed one', () => {
    expect(revisionActions(f(), NOW)).toEqual({ download: true, retry: false, packaging: false, report: 'open' })
    expect(revisionActions(f({ status: 'packaging' }), NOW)).toMatchObject({ download: false, retry: false, packaging: true })
    expect(revisionActions(f({ status: 'failed' }), NOW)).toMatchObject({ download: false, retry: true, packaging: false })
  })
  it('closes the report window by date', () => {
    expect(revisionActions(f({ reportableUntil: at(-1000) }), NOW).report).toBe('closed')
  })
  it('offers no report on a first finalize or an uncharged revision', () => {
    expect(revisionActions(f({ kind: 'first', amountCents: 2900, reportableUntil: null }), NOW).report).toBe('none')
    expect(revisionActions(f({ amountCents: 0, reportableUntil: null }), NOW).report).toBe('none')
  })
  it('shows a report already made', () => {
    expect(revisionActions(f({ report: { status: 'refunded', createdAt: NOW.toISOString() }, reportableUntil: null }), NOW).report).toBe('done')
    expect(revisionActions(f({ amountCents: 0, report: { status: 'waived', createdAt: NOW.toISOString() }, reportableUntil: null }), NOW).report).toBe('done')
  })
})

describe('viewButtonRendering', () => {
  const dance = { bodyShape: 'male', outfit: 'default', emote: 'dance' } as const
  const rendering = (v: { emote: string | null }) => v.emote === 'dance'
  it('marks the button that asked for the view, not the selected buttons it shares the view with', () => {
    expect(viewButtonRendering('emote', 'dance', dance, 'emote', rendering)).toBe(true)
    expect(viewButtonRendering('bodyShape', 'male', dance, 'emote', rendering)).toBe(false)
    expect(viewButtonRendering('outfit', 'default', dance, 'emote', rendering)).toBe(false)
  })
  it('marks an unselected button whose view is rendering', () => {
    const spin = { ...dance, emote: null }
    expect(viewButtonRendering('emote', 'dance', spin, 'bodyShape', rendering)).toBe(true)
    expect(viewButtonRendering('emote', 'wave', spin, 'emote', rendering)).toBe(false)
  })
})

describe('canSend', () => {
  it('lets a new message through after a cost stop, beside Continue', () => {
    expect(canSend('send')).toBe(true)
    expect(canSend('continue')).toBe(true)
    expect(canSend('busy')).toBe(false)
    expect(canSend('out')).toBe(false)
    expect(canSend('archived')).toBe(false)
  })
})

describe('reloadsOn', () => {
  it('re-reads the design when a job starts or ends, not on progress', () => {
    expect(reloadsOn({ type: 'job', jobId: 'j1', status: 'queued' })).toBe(true)
    expect(reloadsOn({ type: 'job', jobId: 'j1', status: 'done', outcome: 'ok' })).toBe(true)
    expect(reloadsOn({ type: 'job', jobId: 'j1', status: 'failed' })).toBe(true)
    expect(reloadsOn({ type: 'job', jobId: 'j1', status: 'taken' })).toBe(false)
    expect(reloadsOn({ type: 'progress', jobId: 'j1', text: 'hi' })).toBe(false)
  })
})

describe('uploads', () => {
  it('explains a refused file plainly', () => {
    expect(refusalMessage({ status: 400, body: { code: 'unsupported_file' } }, NOW).text).toBe(
      'That file type can’t be used. Upload an image (PNG, JPEG, WebP, GIF, TIFF, AVIF or SVG) or a 3D file (GLB, VRM, FBX, OBJ, STL or .blend).')
    expect(refusalMessage({ status: 413, body: { code: 'file_too_large' } }, NOW).text).toBe('That file is too big: images can be up to 20 MB, 3D files up to 25 MB.')
    // the server's own body-size refusal carries no code
    expect(refusalMessage({ status: 413, body: {} }, NOW).text).toBe('That file is too big: images can be up to 20 MB, 3D files up to 25 MB.')
    expect(refusalMessage({ status: 409, body: { code: 'too_many_uploads' } }, NOW).text).toBe('A design holds up to 12 files. Remove one to add another.')
    expect(refusalMessage({ status: 413, body: { code: 'image_too_large' } }, NOW).text).toBe('That image has more pixels than the studio can use (64 megapixels at most). Save a smaller copy and try again.')
  })

  it('checks a file before sending it', () => {
    expect(uploadProblem({ name: 'logo.svg', size: 2_000 })).toBeNull()
    expect(uploadProblem({ name: 'shoe.FBX', size: 2_000 })).toBeNull()
    expect(uploadProblem({ name: 'notes.pdf', size: 2_000 })).toMatch(/^That file type/)
    expect(uploadProblem({ name: 'huge.png', size: 21 * 1024 * 1024 })).toMatch(/^That file is too big/)
    expect(uploadProblem({ name: 'scene.glb', size: 24 * 1024 * 1024 })).toBeNull()
    expect(uploadProblem({ name: 'scene.glb', size: 26 * 1024 * 1024 })).toMatch(/^That file is too big/)
  })

  it('formats sizes', () => {
    expect(formatBytesShort(900)).toBe('900 B')
    expect(formatBytesShort(48_000)).toBe('47 KB')
    expect(formatBytesShort(3_400_000)).toBe('3.2 MB')
  })
})

describe('the scope guard on the page', () => {
  it('a paused account sees the notice instead of the composer', () => {
    expect(PAUSED_NOTE).toBe('Your studio access is paused, so you can’t send new messages. You can still finalize and download your designs. Contact support@virvi.io.')
    expect(composerState(detail(), usage({ paused: true }), NOW)).toEqual({ mode: 'paused', note: PAUSED_NOTE })
    expect(composerState(detail({ activeJob: { id: 'j1', type: 'prompt', status: 'queued' } }), usage({ paused: true, promptsLeft: 0 }), NOW).mode).toBe('paused')
    expect(composerState(detail({ design: { ...detail().design, archivedAt: NOW.toISOString() } }), usage({ paused: true }), NOW).mode).toBe('archived')
    expect(canSend('paused')).toBe(false)
  })
  it('a held report is still charged in the dialog', () => {
    const q = quote([line({ priceKind: 'revision', amountCents: 1500 }), line({ category: 'feet', priceKind: 'revision_extra', amountCents: 1000 })], { reportsHeld: ['hat'] })
    expect(dialogTotal(q, ['hat', 'feet'])).toBe(1500)
  })
  it('says where a held or declined report stands', () => {
    expect(reportCopy('in_review')).toBe(HELD_REPORT_COPY)
    expect(HELD_REPORT_COPY).toBe('Your report is with our team. If it’s approved, this revision is refunded in full.')
    expect(reportCopy('declined')).toBe('Our team reviewed your report and this revision wasn’t refunded.')
    expect(reportCopy('approving')).toBe(HELD_REPORT_COPY)
    expect(reportCopy('refunded')).toBeNull()
    const f = (report: FinalizedRevision['report']): FinalizedRevision => ({ revision: 2, kind: 'revision', status: 'ready', amountCents: 1500, paymentId: 'p', paidAt: NOW.toISOString(), report, reportableUntil: null })
    expect(revisionActions(f({ status: 'in_review', createdAt: NOW.toISOString() }), NOW).report).toBe('done')
    expect(revisionActions(f({ status: 'declined', createdAt: NOW.toISOString() }), NOW).report).toBe('done')
  })
})

describe('flagSummary', () => {
  const event = (category: string, createdAt: string) => ({ by: 'check' as const, category, note: 'n', message: 'm', designId: 'd', createdAt })
  it('counts the turn-downs and names their kinds', () => {
    const flag: AdminStudioFlag = {
      id: 'f', status: 'open', openedAt: NOW.toISOString(), closedAt: null, paused: false,
      user: { id: 'u', email: 'a@b.test', plan: 'free' },
      events: [event('chat', at(0)), event('coding', at(-MIN)), event('coding', '2026-10-28T10:00:00Z')],
    }
    expect(flagSummary(flag)).toBe('3 turn-downs since Oct 28 · general chat, coding help')
    expect(flagSummary({ ...flag, events: [event('other', at(0))] })).toBe('1 turn-down since Oct 29 · other work')
  })
})

describe('giftCodeStatus', () => {
  const c = { disabledAt: null, expiresAt: null, uses: 0, maxUses: 2 }
  it('reads off, expired, used up, else active', () => {
    expect(giftCodeStatus(c, NOW)).toBe('Active')
    expect(giftCodeStatus({ ...c, uses: 2 }, NOW)).toBe('Used up')
    expect(giftCodeStatus({ ...c, expiresAt: at(-MIN) }, NOW)).toBe('Expired')
    expect(giftCodeStatus({ ...c, expiresAt: at(MIN) }, NOW)).toBe('Active')
    expect(giftCodeStatus({ ...c, disabledAt: at(-MIN), uses: 2 }, NOW)).toBe('Off')
  })
})

describe('triangleWarning', () => {
  it('is null within the budget or without a checker', () => {
    expect(triangleWarning('Neon Cap', 'hat', { pass: true, failures: 0, warnings: 0, triangles: null })).toBeNull()
    expect(triangleWarning('Neon Cap', 'hat', { pass: true, failures: 0, warnings: 0 })).toBeNull()
    expect(triangleWarning('Neon Cap', 'hat', null)).toBeNull()
  })
  it('names the count, the budget and the slot', () => {
    expect(triangleWarning('Courier Jacket', 'upper_body', { pass: true, failures: 0, warnings: 1, triangles: { count: 2100, limit: 1500 } }))
      .toBe('Courier Jacket has 2,100 triangles, more than the 1,500 Decentraland recommends for an upper body. You can still finalize and deploy it.')
  })
})
