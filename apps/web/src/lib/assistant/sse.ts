import type { AssistantStreamEvent } from '@virvixr/shared'
import { API_URL } from '../config'

/**
 * Reads server-sent events out of a text chunk. Frames end at a blank line; `:` comments (pings) are ignored.
 * Whatever follows the last blank line is an unfinished frame: it comes back as `carry` for the next chunk.
 */
export function parseSse(chunk: string, carry: string): { events: AssistantStreamEvent[]; carry: string } {
  const parts = (carry + chunk).replace(/\r\n/g, '\n').split('\n\n')
  const rest = parts.pop() ?? ''
  const events: AssistantStreamEvent[] = []
  for (const frame of parts) {
    const data = frame.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).replace(/^ /, '')).join('\n')
    if (!data) continue
    try {
      events.push(JSON.parse(data) as AssistantStreamEvent)
    } catch {
      // A frame that is not JSON is skipped
    }
  }
  return { events, carry: rest }
}

/**
 * POSTs to an assistant SSE route and hands each event to `onEvent`. A non-2xx answer becomes one `error` event
 * (the server's message) then `done`.
 *
 * This does not renew the session: a module function cannot call the `useAuth().renew` hook. The caller passes a
 * fresh token, so the panel renews first when the token expires within 60 seconds.
 */
export async function streamAssistant(
  url: string,
  body: unknown,
  token: string,
  onEvent: (e: AssistantStreamEvent) => void,
  signal: AbortSignal,
): Promise<void> {
  const res = await fetch(`${API_URL}${url}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({} as { error?: string; message?: string }))
    onEvent({ type: 'error', code: err.error || `http_${res.status}`, message: err.message || err.error || `Something went wrong (${res.status}).` })
    onEvent({ type: 'done', messageId: null })
    return
  }
  if (!res.body) return
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let carry = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    const r = parseSse(decoder.decode(value, { stream: true }), carry)
    carry = r.carry
    for (const e of r.events) onEvent(e)
  }
}
