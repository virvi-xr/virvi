// Virvi Assistant (LIV-155): types shared by the server and the dashboard.

export type AssistantEffect = 'read' | 'write'
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
}

export interface AssistantPlanView {
  planId: string
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
  | { type: 'link'; label: string; href: string }
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
  links: { label: string; href: string }[]
  createdAt: string
}
