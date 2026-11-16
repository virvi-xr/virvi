/**
 * BEAT reissue (LIV-11): moving a person's BEATs from a compromised wallet to a new one. The shapes the person's routes
 * (/api/beats/reissue-requests) and the admin queue (/api/admin/beats/reissue-requests) return, and their plain copy.
 * The server is apps/server/src/beats/reissue.ts.
 */
import {
  BEAT_CHAIN_INFO, BEAT_REISSUE_NOTE_MAX, BEAT_REISSUE_OPEN, BEAT_REISSUE_REASON_MAX,
  type BeatChain, type BeatReissueBlocker, type BeatReissueFileStatus, type BeatReissueFlag, type BeatReissueItemState, type BeatReissueStatus, type SignInMethod,
} from '@virvixr/shared'
import { shortWallet } from './studio-people'

export { BEAT_REISSUE_NOTE_MAX, BEAT_REISSUE_REASON_MAX }

// ── Shapes ───────────────────────────────────────────────────────────────────

export interface ReissueBeat {
  claimId: string | null
  beatId: string | null
  name: string
  chain: BeatChain
  tokenId: string
  tradeable: boolean
  /** Null until a Safe file was prepared for its chain. */
  state: BeatReissueItemState | null
}

export interface ReissueRequest {
  id: string
  oldWallet: string
  newWallet: string
  reason: string | null
  status: BeatReissueStatus
  reviewNote: string | null
  createdAt: string
  reviewedAt: string | null
  proposedAt: string | null
  doneAt: string | null
  cancelledAt: string | null
  withdrawnAt: string | null
  beats: ReissueBeat[]
}

export interface LinkedBy { method: SignInMethod; how?: 'sign_up' | 'link' | 'visitor' | 'trial'; wallet?: string | null; email?: string | null }

export interface AdminReissueBeat extends ReissueBeat {
  chainState: { oldBalance: string; replacedBy: string | null; newMinted: boolean } | null
  blockers: (BeatReissueBlocker | string)[]
  eligible: boolean
  landed: boolean
  fileId: string | null
  callIndex: number | null
  txUrl: string | null
}

export interface AdminReissueFile {
  id: string
  chain: BeatChain
  callIndex: number
  kind: 'plain' | 'tradeable'
  tokenIds: string[]
  status: BeatReissueFileStatus
  checksum: string
  filename: string
  proposedAt: string
  doneAt: string | null
  voidedAt: string | null
}

export interface AdminReissueRequest extends Omit<ReissueRequest, 'beats'> {
  account: { id: string; displayName: string; email: string | null } | null
  reviewer: { id: string; displayName: string } | null
  filedVia: LinkedBy | null
  cancelledVia: LinkedBy | null
  dataDeletedAt: string | null
  audit: { at: string; by: string | null; action: string; note?: string }[]
  flags: BeatReissueFlag[]
  otherSignIns: { email: boolean; password: boolean; oauth: boolean }
  wallets: { wallet: string; linked: boolean; blocked: boolean; linkedAt: string | null; linkedBy: LinkedBy | null; lastSignInAt: string | null }[]
  walletEvents: { wallet: string; event: string; at: string; byUserId: string | null; requestId: string | null; note: string | null }[]
  history: { id: string; status: BeatReissueStatus; oldWallet: string; newWallet: string; createdAt: string; filedVia: LinkedBy | null; cancelledAt: string | null; cancelledVia: LinkedBy | null; reviewedAt: string | null; doneAt: string | null; withdrawnAt: string | null }[]
  reviewWallets: { wallet: string; linkedAt: string; linkedBy: LinkedBy; why: 'linked_by_old_wallet' | 'no_history_recent' }[]
  files: AdminReissueFile[]
  beats: AdminReissueBeat[]
}

/** A Safe Transaction Builder file (the JSON the signers drag into the Safe). */
export type SafeBatchFile = Record<string, unknown>

export interface SafeBatchPreview {
  chain: BeatChain
  files: { kind: 'plain' | 'tradeable'; tokenIds: string[]; callIndex: number; file: SafeBatchFile }[]
  beats: Omit<AdminReissueBeat, 'state' | 'fileId' | 'callIndex' | 'txUrl'>[]
  proposed: AdminReissueFile[]
}

export type ProposedReissueFile = AdminReissueFile & { file: SafeBatchFile }

// ── The person's page ────────────────────────────────────────────────────────

export const MOVE_TITLE = 'Move my BEATs to a new wallet'
export const MOVE_INTRO = [
  "If a wallet you used for BEATs was lost or stolen, Virvi can send your BEATs again to a new wallet. A person at Virvi checks every request.",
  'You must ask from a session that is not signed in with the old wallet: sign in with your new wallet, or with your email. The new wallet must already be linked to your account (above).',
  'A BEAT can only be moved after its event has ended. A tradeable BEAT that is no longer in the old wallet (sold, sent on or burned) can\'t be moved.',
]
export const MOVE_WHAT_HAPPENS = [
  "When Virvi approves, the old wallet is blocked from Virvi: it can't sign in, and its sessions are refused. Virvi also removes your API keys and paired devices, so you'll set them up again.",
  'Moving a BEAT is recorded on Polygon, a public blockchain: anyone can see that the old wallet was replaced by the new one for that BEAT, and it can\'t be deleted. The old copy stays in the old wallet, frozen: it can never be moved.',
  "The hosts of the event see the new wallet in their list, marked as reissued.",
  'Virvi keeps your request (both wallets, your reason and how you were signed in) until 30 days after it closes, or until you delete your data.',
]
/** Shown to the person once a request is approved (fix round 3). */
export const APPROVED_NOTE = 'We removed your API keys and paired devices, and your old wallet can no longer sign in. Set your keys and devices up again.'

export const REISSUE_STATUS_LABELS: Record<BeatReissueStatus, string> = {
  pending: 'Waiting for review',
  approved: 'Approved, being prepared',
  rejected: 'Not approved',
  proposed: 'Being sent on Polygon',
  done: 'Done',
  cancelled: 'Cancelled',
  withdrawn: 'Withdrawn by Virvi',
}

export const ITEM_STATE_LABELS: Record<BeatReissueItemState, string> = {
  proposed: 'Waiting to be sent',
  skipped: "Can't be moved",
  reissued: 'Moved to the new wallet',
  clash: 'Sent, needs a check by Virvi',
  withdrawn: 'Withdrawn',
}
export const itemStateLabel = (s: BeatReissueItemState | null) => (s ? ITEM_STATE_LABELS[s] : 'Not prepared yet')

export const isOpen = (r: Pick<ReissueRequest, 'status'>) => BEAT_REISSUE_OPEN.includes(r.status)

/** The person's form: what is wrong, or null. */
export function moveFormError(f: { oldWallet: string; newWallet: string; reason: string }): string | null {
  const addr = /^0x[0-9a-fA-F]{40}$/
  if (!addr.test(f.oldWallet.trim())) return 'Give the old wallet as a 0x address.'
  if (!addr.test(f.newWallet.trim())) return 'Pick the new wallet.'
  if (f.oldWallet.trim().toLowerCase() === f.newWallet.trim().toLowerCase()) return 'The old and new wallets must be different.'
  if (!f.reason.trim()) return 'Say what happened to the old wallet.'
  if ([...f.reason.trim()].length > BEAT_REISSUE_REASON_MAX) return `The reason can be up to ${BEAT_REISSUE_REASON_MAX} characters.`
  return null
}

const PERSON_ERRORS: Record<string, string> = {
  bad_wallet: 'Give both wallets as 0x addresses.',
  same_wallet: 'The old and new wallets must be different.',
  bad_reason: `Say what happened to the old wallet, in up to ${BEAT_REISSUE_REASON_MAX} characters.`,
  wallet_not_linked: 'The new wallet must be linked to your account and verified. Link it under Linked Wallets first.',
  no_beats_on_wallet: 'We found no BEATs sent to that wallet on your account.',
  request_open: 'You already have a request open. Wait for it to finish, or cancel it first.',
  signed_in_with_old_wallet: 'Sign in with your new wallet, or with your email, to ask for this.',
  cancel_not_allowed: 'Sign in with your new wallet, or with your email, to cancel this.',
  not_pending: 'This request is already being handled, so it can no longer be cancelled.',
  account_required: 'Sign in to your Virvi account on the web to do this.',
  wallet_blocked: 'This wallet can no longer sign in to Virvi.',
  wallet_unlinked: 'This wallet can no longer sign in to Virvi.',
}
export function moveError(err: unknown): string {
  const code = (err as { body?: { error?: string } } | null)?.body?.error ?? (err as Error | null)?.message ?? ''
  return PERSON_ERRORS[code] ?? 'Something went wrong. Try again.'
}

// ── The admin queue ──────────────────────────────────────────────────────────

export const REISSUE_FILTERS = ['open', 'pending', 'approved', 'proposed', 'done', 'rejected', 'cancelled', 'withdrawn', 'all'] as const

export const FLAG_LABELS: Record<BeatReissueFlag, string> = {
  new_wallet_recent: 'New wallet linked under 7 days before the request',
  new_wallet_linked_by_old_wallet: 'The new wallet was linked while signed in with the old wallet',
  recent_cancel: 'Another request was cancelled in the last 30 days',
  earlier_reissue: 'This account already had a reissue',
  follow_up_reissue: 'This old wallet received a reissue in the last 30 days',
  clash: 'A BEAT was moved on chain but its claim could not move (another claim holds the new wallet)',
}

export const BLOCKER_LABELS: Record<BeatReissueBlocker, string> = {
  NothingToReplace: 'The old wallet no longer holds this tradeable BEAT',
  AlreadyReplaced: 'Already replaced on chain',
  AlreadyMinted: 'The new wallet already has it',
  ClaimOnNewWallet: 'Another claim on this BEAT already uses the new wallet',
  BeatOpen: 'Wait until it ends',
  ChainUnavailable: "Couldn't read Polygon. Try again",
  Unavailable: 'Unavailable on this chain',
  NotMintedTo: 'The old wallet was never sent this BEAT on chain',
  Withdrawn: 'Its file was withdrawn',
}
export const blockerLabel = (b: string) => BLOCKER_LABELS[b as BeatReissueBlocker] ?? b

export const REVIEW_WHY: Record<'linked_by_old_wallet' | 'no_history_recent', string> = {
  linked_by_old_wallet: 'Linked while signed in with the old wallet',
  no_history_recent: 'Linked in the last 30 days, with no record of how',
}

export function linkedByLabel(l: LinkedBy | null): string {
  if (!l) return 'Unknown'
  const how = l.how === 'sign_up' ? 'made the account' : l.how === 'visitor' ? 'came from an in-world visitor' : l.how === 'trial' ? 'from a trial' : 'linked'
  const who = l.method === 'wallet' && l.wallet ? `signed in with ${shortWallet(l.wallet)}` : l.method === 'email' ? `signed in with email${l.email ? ` ${l.email}` : ''}`
    : l.method === 'oauth' ? `signed in with Google or Discord${l.email ? ` (${l.email})` : ''}` : 'no record of how'
  return `${how}, ${who}`
}

export const APPROVE_WARNING = "Approving blocks the old wallet from Virvi everywhere: it can't sign in, and its sessions are refused. It also removes every API key and paired device on the account."
export const UNLINK_WARNING = 'Remove this wallet from the account and block it from Virvi?'
export const WITHDRAW_WARNING = 'Also discard (reject) the pending Safe transaction for this request, or it can still go through.'
/** The steps for the Safe's signers, in order. */
export const SAFE_STEPS = [
  'Open your Safe (app.safe.global) on the right network.',
  'Go to Apps, then Transaction Builder.',
  'Drag in this file.',
  'Press Simulate, and check it succeeds.',
  'Press Create batch.',
  'Get a second signer to approve it.',
  'Execute it.',
]
export const SAFE_ORDER_NOTE = "Send the non-tradeable file first. Each file is one Safe transaction. If a tradeable file fails, reject its Safe transaction (its nonce) before you send the next one."
export const SAFE_STATE_NOTE = 'Preparing the files marks the request as being sent. Virvi watches Polygon and finishes the request by itself once every BEAT has moved.'

/**
 * Plain text for the revocation audit note on approval (fix round 3): "Removed N API keys and M paired devices; the old
 * wallet's sessions are refused." The server writes the note; this finds the latest one.
 */
export function revocationNote(r: Pick<AdminReissueRequest, 'audit'>): string | null {
  const a = [...r.audit].reverse().find((x) => x.action === 'revoked_credentials')
  return a?.note ?? null
}

const ADMIN_ERRORS: Record<string, string> = {
  not_pending: 'This request has already been reviewed.',
  wallets_unreviewed: 'Choose keep or unlink for every wallet listed under "Wallets to decide on".',
  bad_wallets: 'Choose keep or unlink for every wallet listed under "Wallets to decide on".',
  bad_note: `Add a note (up to ${BEAT_REISSUE_NOTE_MAX} characters). The person sees it.`,
  wallet_not_linked: "The new wallet isn't linked and verified on the account any more. Reject the request.",
  no_beats_on_wallet: 'No minted BEATs are left on the old wallet for this account.',
  data_deleted: 'The person deleted their data. Withdraw this request.',
  not_approved: 'Approve the request first.',
  no_contract: 'There is no BEAT contract on that network.',
  nothing_to_reissue: 'Nothing can be moved right now. Check each BEAT below for why.',
  chain_unavailable: "Couldn't read Polygon. Try again in a minute.",
  bad_chain: 'Unknown network.',
  not_withdrawable: 'Only an approved or proposed request can be withdrawn.',
  file_not_proposed: 'That file was already withdrawn or finished.',
  already_landed: 'Part of this has already gone through on Polygon, so it can no longer be withdrawn.',
  file_voided: 'That file was withdrawn, so it can no longer be downloaded.',
  is_new_wallet: "That is the request's new wallet. Reject the request instead.",
  wallet_not_on_account: "That wallet isn't on this account.",
  not_blocked: "That wallet isn't blocked.",
  request_open: 'This wallet is the old wallet of an open request. Withdraw or reject the request first.',
  bad_status: 'Unknown filter.',
  bad_offset: 'Unknown page.',
  own_request: "You can't review your own request. Ask another admin.",
}
/** An admin failure as plain text, with the code kept for a developer (plain-ux I10). */
export function adminReissueError(err: unknown): { message: string; code: string | null } {
  const code = (err as { body?: { error?: string } } | null)?.body?.error ?? null
  return { message: (code && ADMIN_ERRORS[code]) || 'Something went wrong. Try again, or ask a developer to check the server logs.', code }
}

export const chainLabel = (c: BeatChain) => BEAT_CHAIN_INFO[c]?.label ?? c

/** The chains a request has BEATs on, in a fixed order. */
export const requestChains = (r: Pick<AdminReissueRequest, 'beats'>): BeatChain[] =>
  (['polygon', 'polygon-amoy'] as BeatChain[]).filter((c) => r.beats.some((b) => b.chain === c))

/** Downloads a JSON object as a file in the browser. */
export function saveJson(file: unknown, filename: string): void {
  const url = URL.createObjectURL(new Blob([JSON.stringify(file, null, 2)], { type: 'application/json' }))
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
