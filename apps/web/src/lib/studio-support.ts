import { agentLabel, type StudioDetail, type StudioKind, type StudioMessage, type StudioSupportView } from './studio'
import { canAct, promptSenderId, senderLabel } from './studio-people'

/**
 * Virvi support: a Virvi admin helping on someone else's Design Studio design, on the design's own page. What it
 * shows and hides, and how the conversation names who said what.
 */

export const SUPPORT_LABEL = 'Virvi support'

/** Whose design it is, as the page names them: their name, else their email, else what kind of account it is. */
export function supportOwnerName(s: StudioSupportView): string {
  return s.ownerName?.trim() || s.ownerEmail || (s.trial ? 'a free-trial visitor' : 'this person')
}

/** The banner across the top of a design a Virvi admin is helping on. */
export function supportBanner(s: StudioSupportView): string {
  return `You’re viewing ${supportOwnerName(s)}’s design as ${SUPPORT_LABEL}.${s.trial ? ' It’s a free-trial design.' : ''} Your messages show in their conversation as ${SUPPORT_LABEL}, and nothing you send or finalize is charged.`
}

/**
 * The name over a message: the agent's for the agent, Virvi support for an admin's message (to the owner and to the
 * admin), and for a person's words their sender (LIV-159): You for my own, their name for someone else's. Support
 * sees every sender by name (the owner's when an older message has none). A system note has none, and so does a
 * person's message from before senders were sent.
 */
export function messageLabel(m: Pick<StudioMessage, 'role' | 'agent' | 'support' | 'sender'>, detail: Pick<StudioDetail, 'support'>, meId?: string | null): string | null {
  if (m.role === 'system') return null
  if (m.role === 'agent') return agentLabel(m.agent)
  if (m.support) return SUPPORT_LABEL
  if (detail.support) return m.sender?.displayName?.trim() || supportOwnerName(detail.support)
  return senderLabel(m, meId)
}

/**
 * Whether a message sits on the right, as the viewer's own: my own words (any person's words before senders were
 * sent: the owner's), support's for an admin.
 */
export function messageIsViewers(m: Pick<StudioMessage, 'role' | 'support' | 'sender'>, detail: Pick<StudioDetail, 'support'>, meId?: string | null): boolean {
  if (m.role !== 'user') return false
  if (detail.support) return !!m.support
  return m.sender && meId ? m.sender.userId === meId : !m.support
}

/**
 * The prompt the agent is on, with who sent it, for the box's "Working on Sam's prompt" (boxState): the sender is the
 * newest person's message's (promptSenderId). Support's prompt is Virvi support's to members, and the admin's own to
 * support. Null while no prompt runs.
 */
export function runningPrompt(detail: Pick<StudioDetail, 'activeJob' | 'messages' | 'support'>, meId: string | null | undefined) {
  const job = detail.activeJob
  if (job?.type !== 'prompt') return null
  const last = [...detail.messages].reverse().find((m) => m.role === 'user')
  if (last?.support) return { ...job, senderName: SUPPORT_LABEL, senderId: detail.support ? meId ?? null : null }
  return { ...job, senderName: job.senderName ?? null, senderId: promptSenderId(detail.messages) }
}

/**
 * The controls on the design page, by who is looking. Support can prompt, render, check and finalize; renaming or
 * archiving, switching the agent, adding or removing files, mistake reports, buying prompts and MANA refunds stay the
 * owner's. On a shared design (LIV-159) a collaborator works on it as the owner does (`act`: prompt, render, check,
 * finalize; files and buying prompts too) but can't rename, archive or switch the agent; a viewer only looks. Anyone
 * may report a revision they paid for (the server sends `reportableUntil` to the payer alone), and see the People.
 * `owner`: the owner is looking.
 */
export function designControls(detail: Pick<StudioDetail, 'support' | 'role'>): {
  designMenu: boolean; switchAgent: boolean; uploads: boolean; reports: boolean; topup: boolean; people: boolean; act: boolean; owner: boolean
} {
  const support = !!detail.support
  const role = support ? null : detail.role ?? 'owner'
  const owner = role === 'owner'
  const member = !support && canAct(role)
  return { designMenu: owner, switchAgent: owner, uploads: member, reports: !support, topup: member, people: !support, act: canAct(role), owner }
}

/** The Finalize dialog's button for support: the pieces are finalized for the owner at once, free. */
export function supportFinalizeLabel(s: StudioSupportView, busy: boolean): string {
  return busy ? 'Finalizing…' : `Finalize for ${supportOwnerName(s)} (free)`
}

// ── The admin list of designs ────────────────────────────────────────────────

export type AdminDesign = {
  id: string; name: string; kind: StudioKind | string; agent: string; status: string
  archivedAt: string | null; createdAt: string; lastActivityAt: string; lastPromptAt: string | null; pieceCount: number
  finalizedAt: string | null
  owner: { id: string; name: string | null; email: string | null; wallet: string | null; trial: boolean }
}

/** The admin list's query string: search, kind and the next page's cursor, each only when set. */
export function adminDesignsQuery(o: { q?: string; kind?: string; cursor?: string | null }): string {
  const p = new URLSearchParams()
  if (o.q?.trim()) p.set('q', o.q.trim())
  if (o.kind) p.set('kind', o.kind)
  if (o.cursor) p.set('cursor', o.cursor)
  const s = p.toString()
  return s ? `?${s}` : ''
}

const shortWallet = (w: string) => `${w.slice(0, 6)}…${w.slice(-4)}`

/** Who owns a design in the admin list: their name, then their email or wallet. */
export function adminDesignOwner(d: Pick<AdminDesign, 'owner'>): { name: string; detail: string | null } {
  const o = d.owner
  const contact = o.email ?? (o.wallet ? shortWallet(o.wallet) : null)
  if (o.trial) return { name: 'Free-trial visitor', detail: contact }
  return { name: o.name?.trim() || contact || o.id, detail: o.name?.trim() ? contact : null }
}

/** A row's pieces in the admin list. */
export const pieceCountLabel = (n: number) => (n === 0 ? 'No pieces yet' : n === 1 ? '1 piece' : `${n} pieces`)
