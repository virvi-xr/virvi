import type { AssistantBudget, AssistantPlanView } from '@virvixr/shared'

/** The budget line under the panel title; null when there is nothing to say (no cap, or not loaded yet). */
export function budgetLine(b: AssistantBudget | null): { text: string; upgrade: boolean } | null {
  if (!b) return null
  if (b.percentLeft === 0) {
    const on = b.resetsAt ? ` It comes back on ${new Date(b.resetsAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' })}.` : ''
    return { text: `You've used this month's assistant budget.${on}`, upgrade: true }
  }
  if (b.warn) return { text: `You've used ${100 - b.percentLeft}% of this month's assistant budget`, upgrade: false }
  if (b.resetsAt === null && b.percentLeft >= 100) return null
  return { text: `${b.percentLeft}% of this month's assistant budget left`, upgrade: false }
}

export function lockedCopy(reason: 'plan' | 'trial'): { text: string; link: { label: string; href: string } | null } {
  return reason === 'plan'
    ? { text: 'The assistant is included with paid plans.', link: { label: 'See plans', href: '/settings' } }
    : { text: 'Create an account to use the assistant.', link: null }
}

export function planButtonLabel(n: number): string {
  return n === 1 ? 'Do this change' : `Do these ${n} changes`
}

/** The approve button: a card (one paid action) is confirmed; a plan says how many changes it makes. */
export function approveLabel(plan: Pick<AssistantPlanView, 'kind' | 'steps'>): string {
  return plan.kind === 'card' ? 'Confirm' : planButtonLabel(plan.steps.length)
}

/** When an action happened, for the activity list: "20 Nov 2026, 09:05" in the viewer's time zone. */
export function activityDate(iso: string, timeZone?: string): string {
  const d = new Date(iso)
  const day = d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone })
  const time = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone })
  return `${day}, ${time}`
}

/** True when the JWT's `exp` is within `ms` of `now`, or can't be read (renew to be safe). */
export function tokenExpiresWithin(token: string, ms: number, now = Date.now()): boolean {
  try {
    const part = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')
    const { exp } = JSON.parse(atob(part)) as { exp?: number }
    if (typeof exp !== 'number') return true
    return exp * 1000 - now < ms
  } catch {
    return true
  }
}

export const REAPPROVE = 'Ask again to approve this plan.'

/** Steps still waiting for an approval this panel can no longer give (the plan's token only lives in its stream). */
export function needsReapproval(actions: Array<{ status: string }>): boolean {
  return actions.some((a) => a.status === 'awaiting_confirmation')
}

/** Whether an approve run ended refused: an error and no step that got as far as running. */
export function approveRefused(run: { error: string | null; ran: boolean }): boolean {
  return run.error !== null && !run.ran
}

/** The error code the server uses for an expired plan (410), as streamAssistant reports it. */
export const isExpiredCode = (code: string | null): boolean => code === 'expired' || code === 'http_410'
