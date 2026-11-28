import type { WebhookDelivery } from './api'

/** LIV-39: what each event is, in the Settings list. */
export const WEBHOOK_EVENT_LABELS: Record<string, string> = {
  'deployment.finished': 'A deploy of one of your scenes went live or failed',
  'event.started': 'One of your events started',
  'webhook.test': 'Test',
}

/** A delivery's outcome in a few words. */
export function deliveryLine(d: Pick<WebhookDelivery, 'status' | 'attempts' | 'responseStatus' | 'lastError'>): string {
  if (d.status === 'delivered') return `Delivered${d.responseStatus ? ` (${d.responseStatus})` : ''}`
  const why = d.lastError ?? 'no answer'
  if (d.status === 'failed') return `Gave up after ${d.attempts} tries: ${why}`
  return d.attempts ? `Retrying (try ${d.attempts} failed: ${why})` : 'Waiting to send'
}
