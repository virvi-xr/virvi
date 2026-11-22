// Virvi Assistant (LIV-155): types shared by the server and the dashboard.

export type AssistantEffect = 'read' | 'write' | 'paid' | 'public'
export type AssistantActionStatus = 'planned' | 'awaiting_confirmation' | 'running' | 'done' | 'failed' | 'undone' | 'cancelled'

export interface AssistantActionView {
  id: string
  tool: string
  label: string
  orgName: string | null
  status: AssistantActionStatus
  canUndo: boolean
  error: string | null
  planId: string | null
  step: number | null
  /** A card's line under its label: the design, the cost and what is sent. Null for everything but cards. */
  detail: string | null
}

/** One row of the Settings activity list: an action plus when it ran and where. */
export type AssistantActivityItem = AssistantActionView & {
  createdAt: string
  conversationId: string | null
  effect: AssistantEffect
}

export interface AssistantPlanView {
  planId: string
  /** A plan is one or more write steps; a card is one paid step, shown with its `detail` line. */
  kind: 'plan' | 'card'
  /** The card's cost line; null for plans. */
  detail: string | null
  steps: AssistantActionView[]
  token: string
  expiresAt: string
}

/** Users only ever see a percentage, never dollars. */
export interface AssistantBudget {
  percentLeft: number
  warn: boolean
  resetsAt: string | null
}

export type AssistantAccess =
  | { state: 'hidden' }
  | { state: 'locked'; reason: 'plan' | 'trial' }
  | { state: 'ok'; budget: AssistantBudget }

export interface AssistantPageContext {
  path: string
  sceneId?: string
  eventId?: string
  locationId?: string
}

export type AssistantStreamEvent =
  | { type: 'text'; delta: string }
  | { type: 'action'; action: AssistantActionView }
  | { type: 'plan'; plan: AssistantPlanView }
  | { type: 'link'; label: string; href: string; detail?: string }
  | { type: 'budget'; budget: AssistantBudget }
  | { type: 'error'; code: string; message: string }
  | { type: 'done'; messageId: string | null }

export interface AssistantConversationSummary {
  id: string
  title: string
  updatedAt: string
}

export interface AssistantMessageView {
  id: string
  role: 'user' | 'assistant'
  text: string
  actions: AssistantActionView[]
  /** `detail`: a line under the link (a Finalize total, why prompts ran out). */
  links: { label: string; href: string; detail?: string }[]
  createdAt: string
}

// ── Shows (phase 2b): a saved checklist for one event ──

export const SHOW_ITEM_KINDS = ['event', 'scene_link', 'showing', 'raffle', 'raffle_scheduled', 'beat', 'beat_paid', 'wearable_design', 'wearable_published'] as const
export type ShowItemKind = (typeof SHOW_ITEM_KINDS)[number]
export type ShowItemState = 'todo' | 'waiting' | 'done' | 'skipped'

/** What an item points at: the rows the assistant made or found for it. */
export interface ShowItemRef {
  eventId?: string
  sceneId?: string
  showingId?: string
  raffleId?: string
  beatId?: string
  designId?: string
}

/** A published wearable, pasted as its Decentraland Marketplace link. */
export interface ShowWearable {
  contract: string
  itemId: string
  url: string
}

/** An item as stored: its state is never stored, it is computed from the rows `ref` points at on every read. */
export interface ShowItem {
  id: string
  kind: ShowItemKind
  label: string
  ref: ShowItemRef
  wearable?: ShowWearable
}

export interface ShowItemView {
  id: string
  kind: ShowItemKind
  label: string
  state: ShowItemState
  note: string | null
  ref: ShowItemRef
  wearable: ShowWearable | null
}

export interface ShowView {
  id: string
  title: string
  eventId: string | null
  orgName: string | null
  createdAt: string
  closedAt: string | null
  /** How long a new wearable takes; set when the show has a wearable to design. */
  timeline: string | null
  /** Set when the event starts too soon for a wearable still to be designed to get through curation. */
  warning: string | null
  items: ShowItemView[]
}
