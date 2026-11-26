'use client'

import { useEffect, useState } from 'react'
import type { AdminAdvertiserLead } from '@virvixr/shared'
import { useAuth } from '@/lib/auth'
import { useApi } from '@/lib/api'
import { PageHeader, PrimaryButton, Skeleton, tableHeadBand, TableScroll } from '@/components/ui'

const dateFmt = new Intl.DateTimeFormat('en-US', { dateStyle: 'medium' })

/** Admin: advertisers who asked for early access from the landing page, newest first. */
export default function AdminAdvertisersPage() {
  const { user } = useAuth()
  const api = useApi()
  const [leads, setLeads] = useState<AdminAdvertiserLead[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (user?.role !== 'admin') return
    api.getAdminAdvertiserLeads().then((d) => setLeads(d.leads), (e) => setError(e?.message ?? 'Something went wrong'))
  }, [user?.role])

  if (user?.role !== 'admin') return <p className="text-gray-400">Admin access required.</p>

  const copyEmails = async () => {
    try {
      await navigator.clipboard.writeText((leads ?? []).map((l) => l.email).join(', '))
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      setError('Could not copy to the clipboard')
    }
  }

  return (
    <div className="mx-auto max-w-7xl">
      <PageHeader
        crumbs={['System', { label: 'Admin', href: '/admin' }, 'Advertisers']}
        title="Advertisers"
        count={leads ? String(leads.length) : undefined}
        subtitle="People who asked for advertising early access from the landing page. Each agreed to be contacted about advertising on Virvi."
        actions={leads?.length ? <PrimaryButton onClick={copyEmails}>{copied ? 'Copied' : 'Copy emails'}</PrimaryButton> : undefined}
      />
      {error && <p className="mb-4 text-sm text-red-400">{error}</p>}
      {!leads ? (
        <Skeleton rows={2} className="h-12" />
      ) : leads.length === 0 ? (
        <p className="text-gray-400">No one has asked for early access yet.</p>
      ) : (
        <TableScroll label="Advertisers" className="rounded-lg border border-gray-800">
          <table className="w-full text-sm">
            <thead className={tableHeadBand}>
              <tr>
                <th className="p-2">Email</th>
                <th className="p-2">Name</th>
                <th className="p-2">Company</th>
                <th className="p-2">Website</th>
                <th className="p-2">Wants to advertise</th>
                <th className="p-2">Submitted</th>
              </tr>
            </thead>
            <tbody>
              {leads.map((l) => (
                <tr key={l.id} className="border-t border-gray-800 align-top">
                  <td className="p-2"><a href={`mailto:${l.email}`} className="text-blue-400 hover:text-blue-300 underline underline-offset-2">{l.email}</a></td>
                  <td className="p-2">{l.name ?? '—'}</td>
                  <td className="p-2">{l.company ?? '—'}</td>
                  <td className="p-2">
                    {l.website ? <a href={l.website} target="_blank" rel="noopener noreferrer" className="text-blue-400 hover:text-blue-300 underline underline-offset-2">{l.website}</a> : '—'}
                  </td>
                  <td className="p-2 max-w-xs whitespace-pre-wrap text-gray-300">{l.message ?? '—'}</td>
                  <td className="p-2 whitespace-nowrap text-gray-400">{dateFmt.format(new Date(l.createdAt))}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableScroll>
      )}
    </div>
  )
}
