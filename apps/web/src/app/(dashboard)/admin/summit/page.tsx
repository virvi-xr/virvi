'use client'

import { useEffect, useState } from 'react'
import type { AdminSummitSignups, SummitInPersonStatus } from '@virvixr/shared'
import { useAuth } from '@/lib/auth'
import { useApi } from '@/lib/api'
import { signupsCsv } from '@/lib/summit'
import { PageHeader, PrimaryButton, Skeleton } from '@/components/ui'
import { AdminSummit } from '@/components/summit/AdminSummit'

/** Admin: Virvi Launch Summit sign-ups from virvi.io/summit, with in-person confirmations and a CSV export. */
export default function AdminSummitPage() {
  const { user } = useAuth()
  const api = useApi()
  const [data, setData] = useState<AdminSummitSignups | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)

  const load = () => api.getAdminSummitSignups().then(setData, (e) => setError(e?.message ?? 'Something went wrong'))

  useEffect(() => {
    if (user?.role !== 'admin') return
    load()
  }, [user?.role])

  if (user?.role !== 'admin') return <p className="text-gray-400">Admin access required.</p>

  const decide = async (id: string, status: SummitInPersonStatus) => {
    setError(null)
    setBusyId(id)
    try {
      await api.setAdminSummitInPerson(id, status)
      await load() // the totals change too
    } catch (e: any) {
      setError(e?.message ?? 'Something went wrong')
    } finally {
      setBusyId(null)
    }
  }

  const exportCsv = () => {
    if (!data) return
    const url = URL.createObjectURL(new Blob([signupsCsv(data.signups)], { type: 'text/csv;charset=utf-8' }))
    const a = document.createElement('a')
    a.href = url
    a.download = `virvi-summit-signups-${new Date().toISOString().slice(0, 10)}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div className="mx-auto max-w-7xl">
      <PageHeader
        crumbs={['System', { label: 'Admin', href: '/admin' }, 'Summit']}
        title="Summit sign-ups"
        count={data ? String(data.signups.length) : undefined}
        subtitle="People who signed up for the Virvi Launch Summit at virvi.io/summit. Each agreed to get Summit emails."
        actions={data?.signups.length ? <PrimaryButton onClick={exportCsv}>Export CSV</PrimaryButton> : undefined}
      />
      {error && <p role="alert" className="mb-4 text-sm text-red-400">{error}</p>}
      {!data ? <Skeleton rows={3} className="h-12" /> : <AdminSummit signups={data.signups} totals={data.totals} onDecide={decide} busyId={busyId} />}
    </div>
  )
}
