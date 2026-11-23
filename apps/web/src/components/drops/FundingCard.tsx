'use client'
import { useEffect, useState } from 'react'
import { useApi } from '@/lib/api'
import { shortWallet } from '@/lib/studio-people'
import { dropsError, formatPol, fundingLines, polIsZero, type HostGiveaway } from '@/lib/drops'
import { SelectField } from '@/components/ui'

/** Who pays the gas, how far the POL goes, and sending the host's own POL back to one of their verified wallets. */
export function FundingCard({ giveaway: g, disabled, onSent }: { giveaway: HostGiveaway; disabled: boolean; onSent: () => void }) {
  const api = useApi()
  const [wallets, setWallets] = useState<string[] | null>(null)
  const [to, setTo] = useState('')
  const [sending, setSending] = useState(false)
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null)

  useEffect(() => {
    api.getGiveawaySendBackWallets()
      .then((d) => { setWallets(d.wallets); setTo((t) => t || d.wallets[0] || '') })
      .catch(() => setWallets([]))
  }, [api])

  const { lines, warning } = fundingLines(g.funding)
  const nothing = polIsZero(g.funding.withdrawableWei)

  const sendBack = async () => {
    if (!to) return
    setSending(true)
    setMessage(null)
    try {
      const r = await api.sendBackGiveaway(g.id, to)
      setMessage({ ok: true, text: `Sending ${formatPol(r.valueWei)} POL to ${r.toWallet}.` })
      onSent()
    } catch (err) {
      setMessage({ ok: false, text: dropsError(err) })
    }
    setSending(false)
  }

  return (
    <section className="rounded-lg border border-gray-800 bg-gray-900 p-4">
      <h2 className="mb-2 text-lg font-semibold">Funding</h2>
      <p className="mb-2 text-sm text-gray-400">Balance: <span className="font-mono text-gray-200">{formatPol(g.funding.balanceWei)} POL</span></p>
      {lines.map((l) => <p key={l} className="text-sm text-gray-200">{l}</p>)}
      {warning && <p role="alert" className="mt-2 rounded-md bg-yellow-400/10 px-3 py-2 text-sm text-yellow-300">{warning}</p>}

      <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-gray-800 pt-4">
        {wallets && wallets.length === 0 ? (
          <p className="text-sm text-gray-500">Link a wallet to your account to send POL back.</p>
        ) : (
          <>
            <SelectField label="Send to" value={to} onChange={setTo} className="w-56">
              {(wallets ?? []).map((w) => <option key={w} value={w}>{shortWallet(w)}</option>)}
            </SelectField>
            <button type="button" onClick={sendBack} disabled={nothing || !to || sending || disabled}
              className="rounded-md bg-gray-800 px-4 py-2 text-sm hover:bg-gray-700 disabled:opacity-50">
              {sending ? 'Sending…' : `Send back ${formatPol(g.funding.withdrawableWei)} POL`}
            </button>
          </>
        )}
        {message && <p role={message.ok ? 'status' : 'alert'} className={`w-full text-sm ${message.ok ? 'text-green-400' : 'text-red-400'}`}>{message.text}</p>}
      </div>
    </section>
  )
}
