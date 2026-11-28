'use client'
import { useCallback, useEffect, useState } from 'react'
import { useAuth } from '@/lib/auth'
import { useApi, type Webhook, type WebhookDelivery } from '@/lib/api'
import { deliveryLine, WEBHOOK_EVENT_LABELS } from '@/lib/webhooks'
import { ConfirmAction, Skeleton } from '@/components/ui'

/** Settings card (LIV-39): endpoints Virvi POSTs events to, signed with each one's secret. */
export function Webhooks() {
  const { token } = useAuth()
  const api = useApi()
  const [hooks, setHooks] = useState<Webhook[] | null>(null)
  const [eventsList, setEventsList] = useState<string[]>([])
  const [url, setUrl] = useState('')
  const [chosen, setChosen] = useState<string[]>([])
  const [secret, setSecret] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [open, setOpen] = useState<string | null>(null)
  const [deliveries, setDeliveries] = useState<WebhookDelivery[] | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    try {
      const d = await api.getWebhooks()
      setHooks(d.webhooks)
      setEventsList(d.events)
    } catch (err: any) {
      setError(err?.message ?? "Couldn't load webhooks")
      setHooks([])
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token])
  useEffect(() => { load() }, [load])

  const add = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    if (!chosen.length) return setError('Choose at least one event.')
    setBusy(true)
    try {
      const r = await api.createWebhook(url.trim(), chosen)
      setSecret(r.secret)
      setUrl('')
      setChosen([])
      await load()
    } catch (err: any) {
      setError(err?.message ?? "Couldn't add the webhook")
    } finally {
      setBusy(false)
    }
  }

  const showDeliveries = async (id: string) => {
    if (open === id) return setOpen(null)
    setOpen(id)
    setDeliveries(null)
    try { setDeliveries((await api.getWebhookDeliveries(id)).deliveries) } catch { setDeliveries([]) }
  }

  const test = async (id: string) => {
    setError(null)
    try {
      const r = await api.testWebhook(id)
      setOpen(id)
      setDeliveries((await api.getWebhookDeliveries(id)).deliveries)
      if (r.delivery?.status !== 'delivered') setError(`The test didn't go through: ${r.delivery ? deliveryLine(r.delivery) : 'no delivery'}`)
    } catch (err: any) {
      setError(err?.message ?? "Couldn't send the test")
    }
  }

  return (
    <section className="mt-10" aria-labelledby="webhooks-heading">
      <h2 id="webhooks-heading" className="mb-1 text-lg font-semibold">Webhooks</h2>
      <p className="mb-4 text-sm text-gray-400">
        Virvi sends a signed POST to your address when these happen. <a href="/docs/api/webhooks/" className="text-blue-400 underline underline-offset-2 hover:text-blue-300">How to check the signature</a>
      </p>
      {error && <div role="alert" className="mb-3 rounded-md bg-red-900/50 border border-red-700 px-4 py-2 text-sm text-red-300">{error}</div>}
      {secret && (
        <div className="mb-4 rounded-lg border border-yellow-700 bg-yellow-900/30 p-4 text-sm">
          <p className="mb-2 font-medium text-yellow-300">This signing secret is shown once. Copy it now.</p>
          <code className="block break-all rounded bg-gray-950 px-3 py-2 font-mono text-xs text-gray-100">{secret}</code>
          <button type="button" onClick={() => setSecret(null)} className="mt-2 text-xs text-gray-300 underline underline-offset-2">Done</button>
        </div>
      )}
      <form onSubmit={add} className="mb-4 space-y-2 rounded-lg border border-gray-800 bg-gray-900 p-4">
        <div className="flex flex-wrap gap-2">
          <input aria-label="Webhook URL (https://…)" type="url" required value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://example.com/virvi-webhook"
            className="min-w-64 flex-1 rounded-md border border-gray-800 bg-gray-950 px-4 py-2 text-sm text-white outline-none focus:border-blue-400" />
          <button type="submit" disabled={busy} className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium hover:bg-blue-700 disabled:opacity-50">Add webhook</button>
        </div>
        <fieldset className="flex flex-wrap gap-x-4 gap-y-1">
          <legend className="sr-only">Events to send</legend>
          {eventsList.map((ev) => (
            <label key={ev} className="flex items-center gap-1.5 text-sm text-gray-300">
              <input type="checkbox" checked={chosen.includes(ev)} onChange={(e) => setChosen(e.target.checked ? [...chosen, ev] : chosen.filter((x) => x !== ev))} />
              <span className="font-mono text-xs text-gray-200">{ev}</span> <span className="text-xs text-gray-400">{WEBHOOK_EVENT_LABELS[ev]}</span>
            </label>
          ))}
        </fieldset>
      </form>
      {hooks === null ? <Skeleton rows={2} className="h-12" />
      : hooks.length === 0 ? <p className="text-sm text-gray-500">No webhooks yet.</p>
      : (
        <ul className="space-y-2">
          {hooks.map((h) => (
            <li key={h.id} className="rounded-lg border border-gray-800 bg-gray-900 p-4 text-sm">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="min-w-0">
                  <p className="truncate font-mono text-gray-100">{h.url}</p>
                  <p className="text-xs text-gray-400">{h.events.join(', ')}</p>
                </div>
                <div className="flex gap-2">
                  <button type="button" onClick={() => test(h.id)} className="rounded-md bg-gray-800 px-3 py-1.5 text-xs hover:bg-gray-700">Send test</button>
                  <button type="button" onClick={() => showDeliveries(h.id)} aria-expanded={open === h.id} className="rounded-md bg-gray-800 px-3 py-1.5 text-xs hover:bg-gray-700">{open === h.id ? 'Hide deliveries' : 'Deliveries'}</button>
                  <ConfirmAction prompt="Delete this webhook? Virvi stops sending to it." confirmLabel="Delete" onConfirm={async () => { await api.deleteWebhook(h.id); await load() }}
                    className="rounded-md border border-red-800 bg-red-900/50 px-3 py-1.5 text-xs text-red-300 hover:bg-red-900">Delete</ConfirmAction>
                </div>
              </div>
              {open === h.id && (
                <div className="mt-3 border-t border-gray-800 pt-3">
                  {deliveries === null ? <p className="text-xs text-gray-400">Loading…</p>
                  : deliveries.length === 0 ? <p className="text-xs text-gray-400">Nothing sent yet.</p>
                  : (
                    <ul className="space-y-1">
                      {deliveries.map((d) => (
                        <li key={d.id} className="flex flex-wrap gap-x-3 text-xs">
                          <span className="text-gray-400">{new Date(d.createdAt).toLocaleString()}</span>
                          <span className="font-mono text-gray-200">{d.event}</span>
                          <span className={d.status === 'delivered' ? 'text-green-300' : d.status === 'failed' ? 'text-red-300' : 'text-yellow-300'}>{deliveryLine(d)}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
