import type { AssistantBudget } from '@virvixr/shared'

/** The budget line under the panel title; null when there is nothing to say (no cap, or not loaded yet). */
export function budgetLine(b: AssistantBudget | null): { text: string; upgrade: boolean } | null {
  if (!b) return null
  if (b.percentLeft === 0) {
    const on = b.resetsAt ? ` It comes back on ${new Date(b.resetsAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}.` : ''
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
