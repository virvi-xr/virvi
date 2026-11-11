import type { DesignRole, StudioDesign, StudioMessage } from './studio'

/**
 * Design Studio sharing (LIV-159): who may do what on a design, whose prompt the agent is on, who said what, and the
 * copy for invites. The server's shapes are in apps/server/src/routes/studio.ts and studio/invites.ts.
 */

export type InviteRole = Exclude<DesignRole, 'owner'>
export const INVITE_ROLES: InviteRole[] = ['collaborator', 'viewer']

/** A pending invite as the owner sees it: to an email or a wallet address, one of them null (`link` is its invite page, to copy). */
export type StudioInvite = { id: string; email: string | null; wallet?: string | null; role: InviteRole; expiresAt: string; link?: string }
/** Who an invite is sent to, as the invite route takes it. */
export type InviteTarget = { email: string } | { wallet: string }
/** An invite matched to my account, on my Studio page. */
export type MyInvite = { id: string; designId: string; designName: string; inviterName: string | null; role: InviteRole; expiresAt: string }
/** What an invite link's page shows before it is accepted. */
export type InviteLinkView = { designId: string; designName: string; inviterName: string | null; role: InviteRole; status: 'open' | 'expired' | 'used' }
/** A package kept from a design I've left ("Finalized while you were on it"). */
export type PastPackage = { entitlementId: string; designName: string; category: string; revisionNumber: number; finalizedAt: string }

/** Instead of the message box, for a viewer. */
export const VIEWER_NOTE = 'You can view this design. Ask the owner to make you a collaborator to send prompts.'

/** Whether the reader may work on the design: everyone but a viewer (null is Virvi support; undefined, a design from before roles). */
export const canAct = (role: DesignRole | null | undefined) => role !== 'viewer'

/**
 * The message box: open, the viewer's note instead of it, or disabled while the agent is on a prompt, saying whose.
 * `job.senderId`: who sent it (promptSenderId), null for support's prompt.
 */
export function boxState(
  role: DesignRole | null | undefined,
  job: { type: string; senderName?: string | null; senderId?: string | null } | null,
  meId: string | null | undefined,
): 'open' | 'viewer' | { busyFor: string } {
  if (!canAct(role)) return 'viewer'
  if (job?.type !== 'prompt') return 'open'
  if (meId && job.senderId === meId) return { busyFor: 'Working on your prompt' }
  const name = job.senderName?.trim()
  return { busyFor: name ? `Working on ${name}’s prompt` : 'Working on someone else’s prompt' }
}

/**
 * Who sent the prompt running now: the newest person's message is its own (one prompt runs at a time, and its message
 * goes in with it). Null for support's, and for messages from a server that predates senders.
 */
export function promptSenderId(messages: Pick<StudioMessage, 'role' | 'sender'>[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') return messages[i].sender?.userId ?? null
  }
  return null
}

/** The name over a person's message: You for my own, else theirs. Null for the agent's, a system note, support's, and one with no sender. */
export function senderLabel(m: Pick<StudioMessage, 'role' | 'sender'>, meId: string | null | undefined): string | null {
  if (m.role !== 'user' || !m.sender) return null
  if (meId && m.sender.userId === meId) return 'You'
  return m.sender.displayName?.trim() || 'Someone'
}

/** An invite link that can't be accepted any more: a plain line. */
export function inviteStatusCopy(status: InviteLinkView['status']): string | null {
  if (status === 'expired') return 'This invite has expired. Ask the owner to send a new one.'
  if (status === 'used') return 'This invite has already been used.'
  return null
}

/** The invite field's text as the route takes it: something that starts 0x (and has no @) is a wallet, the rest an email. Null when empty. */
export function inviteTarget(raw: string): InviteTarget | null {
  const to = raw.trim()
  if (!to) return null
  return /^0x/i.test(to) && !to.includes('@') ? { wallet: to } : { email: to }
}

/** A wallet address as 0x1234…abcd. */
export const shortWallet = (wallet: string) => `${wallet.slice(0, 6)}…${wallet.slice(-4)}`

/** How a pending invite is named in the owner's list: its email, or its wallet shortened with the full address as `title`. */
export function invitee(i: Pick<StudioInvite, 'email' | 'wallet'>): { label: string; title: string | undefined } {
  if (!i.email && i.wallet) return { label: shortWallet(i.wallet), title: i.wallet }
  return { label: i.email ?? '', title: undefined }
}

/** The line after a resend: an email invite is mailed again, a wallet invite only renewed (and its account told again). */
export function resendDone(i: Pick<StudioInvite, 'email' | 'wallet'>): string {
  const { label } = invitee(i)
  return i.email ? `Sent the invite to ${label} again.` : `Renewed the invite for ${label}.`
}

/** What an invite, member or leave route's refusal means, in a line. `to`: what the invite was to, when there is one. */
export function peopleRefusal(err: { status?: number; body?: { code?: string; error?: string } }, to?: 'email' | 'wallet'): string {
  const code = err.body?.code ?? err.body?.error
  const wallet = to === 'wallet'
  switch (code) {
    case 'already_member': return wallet ? 'That wallet is already on this design.' : 'They’re already on this design.'
    case 'already_invited': return wallet ? 'That wallet already has an invite to this design.' : 'They already have an invite to this design.'
    case 'members_full': return 'This design is full. Remove someone or cancel an invite to make room.'
    case 'invite_limit': return 'You’ve sent today’s invites. Try again tomorrow.'
    case 'self': return wallet ? 'That’s your own wallet.' : 'That’s your own email address.'
    case 'archived': return 'This design is archived. Unarchive it to invite people.'
    case 'resend_too_soon': return 'This invite was sent less than an hour ago. Try again later.'
    case 'resend_limit': return 'This invite has been sent as many times as it can be. Cancel it and invite them again.'
    case 'used':
    case 'expired': return inviteStatusCopy(code)!
    case 'account_required': return 'Create a free account to join a design.'
  }
  if (err.status === 400 && err.body?.error?.startsWith('email')) return 'Enter an email or a wallet address.'
  if (err.status === 400 && err.body?.error?.startsWith('wallet')) return 'Enter a full wallet address: 0x and 40 letters or numbers.'
  return 'Something went wrong. Try again.'
}

/** Accepting an invite (from the Studio page or a link) refused, in the accepter's terms; `openDesign`: link to the design. */
export function acceptRefusal(err: { status?: number; body?: { code?: string; error?: string } }): { text: string; openDesign: boolean } {
  const code = err.body?.code ?? err.body?.error
  if (code === 'already_member') return { text: 'You’re already on this design.', openDesign: true }
  if (code === 'members_full') return { text: 'This design is full. Ask the owner to make room.', openDesign: false }
  return { text: peopleRefusal(err), openDesign: false }
}

export const roleLabel = (role: DesignRole | string) => role === 'owner' ? 'Owner' : role === 'viewer' ? 'Viewer' : 'Collaborator'

/** When a pending invite runs out, for the owner's list. */
export function inviteExpiry(expiresAt: string, now: Date): string {
  const ms = Date.parse(expiresAt) - now.getTime()
  if (ms <= 0) return 'Expired'
  const days = Math.floor(ms / 86_400_000)
  return days === 0 ? 'Expires today' : `Expires in ${days} day${days === 1 ? '' : 's'}`
}

/** The Studio page's lists: my own designs, and the ones shared with me (a design from before roles is mine). */
export function splitDesigns(designs: StudioDesign[]): { mine: StudioDesign[]; shared: StudioDesign[] } {
  const shared = (d: StudioDesign) => !!d.role && d.role !== 'owner'
  return { mine: designs.filter((d) => !shared(d)), shared: designs.filter(shared) }
}

const INVITE_TOKEN = /^[A-Za-z0-9_-]{20,100}$/

/** The invite link page, /studio/invite/<token>: someone signed out is sent to sign up (with sign in beside it), not just sign in. */
export const isInvitePath = (pathname: string) => /^\/studio\/invite\/[^/]+\/?$/.test(pathname)

/** The invite link's token: the static export has one page for every token, at `_`, so it comes from the URL. */
export function inviteTokenFromPath(pathname: string, param?: string): string | null {
  if (param && param !== '_' && INVITE_TOKEN.test(param)) return param
  const m = /^\/studio\/invite\/([^/]+)\/?$/.exec(pathname)
  return m && INVITE_TOKEN.test(m[1]) ? m[1] : null
}
