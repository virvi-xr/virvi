import { agentLabel, type StudioDetail, type StudioKind, type StudioMessage, type StudioSupportView } from './studio'

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
 * admin), the owner's name for the owner's own words when support is looking, and none for the owner's own words to
 * the owner. A system note has none.
 */
export function messageLabel(m: Pick<StudioMessage, 'role' | 'agent' | 'support'>, detail: Pick<StudioDetail, 'support'>): string | null {
  if (m.role === 'system') return null
  if (m.role === 'agent') return agentLabel(m.agent)
  if (m.support) return SUPPORT_LABEL
  return detail.support ? supportOwnerName(detail.support) : null
}

/** Whether a message sits on the right, as the viewer's own: the owner's for the owner, support's for an admin. */
export function messageIsViewers(m: Pick<StudioMessage, 'role' | 'support'>, detail: Pick<StudioDetail, 'support'>): boolean {
  if (m.role !== 'user') return false
  return detail.support ? !!m.support : !m.support
}

/**
 * The owner's controls on the design page. Support can prompt, render, check and finalize; renaming or archiving,
 * switching the agent, adding or removing files, mistake reports, buying prompts and MANA refunds stay the owner's.
 */
export function designControls(detail: Pick<StudioDetail, 'support'>): {
  designMenu: boolean; switchAgent: boolean; uploads: boolean; reports: boolean; topup: boolean
} {
  const owner = !detail.support
  return { designMenu: owner, switchAgent: owner, uploads: owner, reports: owner, topup: owner }
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
