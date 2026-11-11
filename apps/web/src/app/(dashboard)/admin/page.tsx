'use client'

import { useAuth } from '@/lib/auth'
import { useApi, type AdminArReport } from '@/lib/api'
import { reportReasonLabel } from '@/lib/ar'
import { useState, useEffect } from 'react'
import Link from 'next/link'
import { ConfirmAction, PageHeader, Skeleton, tableHead } from '@/components/ui'
import { StatCard } from '@/components/analytics/StatCard'

type Tab = 'users' | 'orgs'

interface Stats {
  totalUsers: number
  trialGuests?: number
  totalOrgs: number
  totalScenes: number
  totalMedia: number
  totalStorageBytes: number
  activeSubscriptionsByTier: Record<string, number>
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.floor(Math.log(bytes) / Math.log(1024))
  return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`
}

export default function AdminPage() {
  const { user } = useAuth()
  const api = useApi()
  const [tab, setTab] = useState<Tab>('users')
  const [stats, setStats] = useState<Stats | null>(null)
  const [statsLoading, setStatsLoading] = useState(true)

  // Users state
  const [users, setUsers] = useState<any[]>([])
  const [usersTotal, setUsersTotal] = useState(0)
  const [usersOffset, setUsersOffset] = useState(0)
  const [usersSearch, setUsersSearch] = useState('')
  const [usersSearchInput, setUsersSearchInput] = useState('')
  const [usersLoading, setUsersLoading] = useState(false)
  const PAGE_SIZE = 25

  // Orgs state
  const [orgs, setOrgs] = useState<any[]>([])
  const [orgsTotal, setOrgsTotal] = useState(0)
  const [orgsOffset, setOrgsOffset] = useState(0)
  const [orgsLoading, setOrgsLoading] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)

  // Space reports (Virvi Spaces visitors)
  const [reports, setReports] = useState<AdminArReport[]>([])
  const [reportsResolved, setReportsResolved] = useState(false)
  const [reportsLoading, setReportsLoading] = useState(true)

  useEffect(() => {
    if (user?.role !== 'admin') return
    setReportsLoading(true)
    api.getAdminArReports(reportsResolved ? 'resolved' : 'open')
      .then(data => setReports(data.reports))
      .catch(err => console.error('Failed to load space reports:', err))
      .finally(() => setReportsLoading(false))
  }, [user?.role, reportsResolved])

  useEffect(() => {
    if (user?.role !== 'admin') return
    setStatsLoading(true)
    api.getAdminStats()
      .then(data => setStats(data))
      .catch(err => console.error('Failed to load stats:', err))
      .finally(() => setStatsLoading(false))
  }, [user?.role])

  useEffect(() => {
    if (user?.role !== 'admin' || tab !== 'users') return
    setUsersLoading(true)
    api.getAdminUsers({ limit: PAGE_SIZE, offset: usersOffset, search: usersSearch || undefined })
      .then(data => { setUsers(data.users); setUsersTotal(data.total) })
      .catch(err => console.error('Failed to load users:', err))
      .finally(() => setUsersLoading(false))
  }, [user?.role, tab, usersOffset, usersSearch])

  useEffect(() => {
    if (user?.role !== 'admin' || tab !== 'orgs') return
    setOrgsLoading(true)
    api.getAdminOrgs({ limit: PAGE_SIZE, offset: orgsOffset })
      .then(data => { setOrgs(data.organizations); setOrgsTotal(data.total) })
      .catch(err => console.error('Failed to load orgs:', err))
      .finally(() => setOrgsLoading(false))
  }, [user?.role, tab, orgsOffset])

  if (user?.role !== 'admin') {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-gray-400">Access denied. Admin role required.</p>
      </div>
    )
  }

  const handleRoleChange = async (userId: string, newRole: string) => {
    setActionError(null)
    try {
      await api.updateUserRole(userId, newRole)
      setUsers((prev) =>
        prev.map((u) => (u.id === userId ? { ...u, role: newRole } : u)),
      )
    } catch (err) {
      setActionError(`Failed to update role: ${(err as Error).message}`)
    }
  }

  const handleReportStatus = async (id: string, status: 'open' | 'resolved') => {
    setActionError(null)
    try {
      await api.setAdminArReportStatus(id, status)
      setReports((prev) => prev.filter((r) => r.id !== id))
    } catch (err) {
      setActionError(`Failed to update report: ${(err as Error).message}`)
    }
  }

  const refreshStats = () => {
    api.getAdminStats().then(data => setStats(data)).catch(() => {})
  }

  const handleDeleteUser = async (userId: string, displayName: string) => {
    setActionError(null)
    try {
      await api.deleteUser(userId)
      setUsers((prev) => prev.filter((u) => u.id !== userId))
      setUsersTotal((prev) => prev - 1)
      refreshStats()
    } catch (err) {
      setActionError(`Failed to delete user ${displayName}: ${(err as Error).message}`)
    }
  }

  const handleDeleteOrg = async (orgId: string, name: string) => {
    setActionError(null)
    try {
      await api.deleteOrg(orgId)
      setOrgs((prev) => prev.filter((o) => o.id !== orgId))
      setOrgsTotal((prev) => prev - 1)
      refreshStats()
    } catch (err) {
      setActionError(`Failed to delete organization ${name}: ${(err as Error).message}`)
    }
  }

  const handleUsersSearch = (e: React.FormEvent) => {
    e.preventDefault()
    setUsersOffset(0)
    setUsersSearch(usersSearchInput)
  }

  const totalUsersPages = Math.ceil(usersTotal / PAGE_SIZE)
  const currentUsersPage = Math.floor(usersOffset / PAGE_SIZE) + 1
  const totalOrgsPages = Math.ceil(orgsTotal / PAGE_SIZE)
  const currentOrgsPage = Math.floor(orgsOffset / PAGE_SIZE) + 1

  return (
    <div className="mx-auto max-w-7xl space-y-6">
      <PageHeader
        crumbs={['System', 'Admin']}
        title="Admin Dashboard"
        subtitle="Platform stats, users and the catalog."
        actions={
          <div className="flex gap-2">
            <Link href="/admin/ads" className="rounded-md border border-gray-800 bg-gray-900 px-3 py-2 text-sm hover:border-gray-700">Ads</Link>
            <Link href="/admin/advertisers" className="rounded-md border border-gray-800 bg-gray-900 px-3 py-2 text-sm hover:border-gray-700">Advertisers</Link>
            <Link href="/admin/catalog" className="rounded-md border border-gray-800 bg-gray-900 px-3 py-2 text-sm hover:border-gray-700">Catalog packs</Link>
            <Link href="/admin/errors" className="rounded-md border border-gray-800 bg-gray-900 px-3 py-2 text-sm hover:border-gray-700">Errors</Link>
            <Link href="/admin/studio" className="rounded-md border border-gray-800 bg-gray-900 px-3 py-2 text-sm hover:border-gray-700">Studio flags</Link>
            <Link href="/admin/studio/gift-codes" className="rounded-md border border-gray-800 bg-gray-900 px-3 py-2 text-sm hover:border-gray-700">Gift codes</Link>
          </div>
        }
      />

      {actionError && <p className="text-sm text-red-400" role="alert">{actionError}</p>}

      {/* Stats Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {statsLoading ? (
          <div className="col-span-full"><Skeleton rows={1} /></div>
        ) : stats ? (
          <>
            <StatCard label="Total Users" value={String(stats.totalUsers)} hint={stats.trialGuests ? `+ ${stats.trialGuests} trial guests` : undefined} />
            <StatCard label="Total Organizations" value={String(stats.totalOrgs)} />
            <StatCard label="Total Scenes" value={String(stats.totalScenes)} />
            <StatCard label="Storage Used" value={formatBytes(stats.totalStorageBytes)} />
          </>
        ) : null}
      </div>

      {/* Space reports */}
      <div className="rounded-lg border border-gray-800 bg-gray-900 p-4 space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">Space reports</h2>
          <label className="flex items-center gap-2 text-sm text-gray-400">
            <input type="checkbox" checked={reportsResolved} onChange={(e) => setReportsResolved(e.target.checked)} />
            Show resolved
          </label>
        </div>
        {reportsLoading ? (
          <Skeleton rows={1} className="h-12" />
        ) : reports.length === 0 ? (
          <p className="text-sm text-gray-400">{reportsResolved ? 'No resolved reports.' : 'No open reports.'}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm text-left">
              <thead className={`${tableHead} border-b border-gray-800`}>
                <tr>
                  <th className="px-3 py-2">Time</th>
                  <th className="px-3 py-2">Space</th>
                  <th className="px-3 py-2">Scene</th>
                  <th className="px-3 py-2">Reason</th>
                  <th className="px-3 py-2">Platform</th>
                  <th className="px-3 py-2" />
                </tr>
              </thead>
              <tbody>
                {reports.map((r) => (
                  <tr key={r.id} className="border-b border-gray-800 hover:bg-gray-800/50">
                    <td className="px-3 py-2 whitespace-nowrap text-gray-400">{new Date(r.createdAt).toLocaleString()}</td>
                    <td className="px-3 py-2 text-white">{r.spaceName}</td>
                    <td className="px-3 py-2 text-gray-300">
                      <Link href={`/scenes?id=${r.sceneId}`} className="hover:underline">{r.sceneName}</Link>
                    </td>
                    <td className="px-3 py-2 text-gray-300">{reportReasonLabel(r.reason)}</td>
                    <td className="px-3 py-2 text-gray-400">{r.platform}</td>
                    <td className="px-3 py-2 text-right">
                      <button
                        onClick={() => handleReportStatus(r.id, reportsResolved ? 'open' : 'resolved')}
                        className="rounded-md border border-gray-700 px-3 py-1 text-xs hover:border-gray-500"
                      >
                        {reportsResolved ? 'Reopen' : 'Resolved'}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Tabs */}
      <div className="flex gap-2 border-b border-gray-700 pb-0">
        <button
          onClick={() => setTab('users')}
          className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px ${
            tab === 'users'
              ? 'border-white text-white'
              : 'border-transparent text-gray-400 hover:text-white'
          }`}
        >
          Users
        </button>
        <button
          onClick={() => setTab('orgs')}
          className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px ${
            tab === 'orgs'
              ? 'border-white text-white'
              : 'border-transparent text-gray-400 hover:text-white'
          }`}
        >
          Organizations
        </button>
      </div>

      {/* Users Tab */}
      {tab === 'users' && (
        <div className="space-y-4">
          <form onSubmit={handleUsersSearch} className="flex gap-2">
            <input
              type="text"
              placeholder="Search by name or email..."
              value={usersSearchInput}
              onChange={(e) => setUsersSearchInput(e.target.value)}
              className="flex-1 rounded-md bg-gray-800 border border-gray-700 px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-gray-500"
            />
            <button
              type="submit"
              className="rounded-md bg-gray-700 px-4 py-2 text-sm text-white hover:bg-gray-600"
            >
              Search
            </button>
          </form>

          {usersLoading ? (
            <Skeleton rows={2} className="h-12" />
          ) : (
            <>
              <div className="overflow-x-auto">
                <table className="w-full text-sm text-left">
                  <thead className={`${tableHead} border-b border-gray-800`}>
                    <tr>
                      <th className="px-3 py-2">Name</th>
                      <th className="px-3 py-2">Email</th>
                      <th className="px-3 py-2">Role</th>
                      <th className="px-3 py-2">Created</th>
                      <th className="px-3 py-2">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {users.map((u) => (
                      <tr key={u.id} className="border-b border-gray-800 hover:bg-gray-800/50">
                        <td className="px-3 py-2 text-white">{u.displayName}</td>
                        <td className="px-3 py-2 text-gray-300">{u.email || '-'}</td>
                        <td className="px-3 py-2">
                          <select
                            value={u.role}
                            onChange={(e) => handleRoleChange(u.id, e.target.value)}
                            className="bg-gray-700 border border-gray-600 text-white text-xs rounded px-2 py-1 focus:outline-none"
                          >
                            <option value="admin">admin</option>
                            <option value="creator">creator</option>
                            <option value="viewer">viewer</option>
                          </select>
                        </td>
                        <td className="px-3 py-2 text-gray-400">
                          {new Date(u.createdAt).toLocaleDateString()}
                        </td>
                        <td className="px-3 py-2">
                          <ConfirmAction
                            prompt={`Delete user "${u.displayName}"? This cannot be undone.`}
                            confirmLabel="Delete"
                            onConfirm={() => handleDeleteUser(u.id, u.displayName)}
                            className="text-red-400 hover:text-red-300 text-xs"
                            disabled={u.id === user?.id}
                            title={u.id === user?.id ? 'Cannot delete yourself' : 'Delete user'}
                          >
                            Delete
                          </ConfirmAction>
                        </td>
                      </tr>
                    ))}
                    {users.length === 0 && (
                      <tr>
                        <td colSpan={5} className="px-3 py-8 text-center text-gray-500">
                          No users found.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>

              {/* Pagination */}
              {usersTotal > PAGE_SIZE && (
                <div className="flex items-center justify-between text-sm text-gray-400">
                  <span>
                    Showing {usersOffset + 1}-{Math.min(usersOffset + PAGE_SIZE, usersTotal)} of{' '}
                    {usersTotal}
                  </span>
                  <div className="flex gap-2">
                    <button
                      onClick={() => setUsersOffset((prev) => Math.max(0, prev - PAGE_SIZE))}
                      disabled={usersOffset === 0}
                      className="px-3 py-1 rounded bg-gray-800 hover:bg-gray-700 disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      Prev
                    </button>
                    <span className="px-2 py-1">
                      Page {currentUsersPage} of {totalUsersPages}
                    </span>
                    <button
                      onClick={() => setUsersOffset((prev) => prev + PAGE_SIZE)}
                      disabled={usersOffset + PAGE_SIZE >= usersTotal}
                      className="px-3 py-1 rounded bg-gray-800 hover:bg-gray-700 disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      Next
                    </button>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      )}

      {/* Organizations Tab */}
      {tab === 'orgs' && (
        <div className="space-y-4">
          {orgsLoading ? (
            <Skeleton rows={2} className="h-12" />
          ) : (
            <>
              <div className="overflow-x-auto">
                <table className="w-full text-sm text-left">
                  <thead className={`${tableHead} border-b border-gray-800`}>
                    <tr>
                      <th className="px-3 py-2">Name</th>
                      <th className="px-3 py-2">Slug</th>
                      <th className="px-3 py-2">Members</th>
                      <th className="px-3 py-2">Scenes</th>
                      <th className="px-3 py-2">Created</th>
                      <th className="px-3 py-2">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {orgs.map((o) => (
                      <tr key={o.id} className="border-b border-gray-800 hover:bg-gray-800/50">
                        <td className="px-3 py-2 text-white">{o.name}</td>
                        <td className="px-3 py-2 text-gray-300">{o.slug}</td>
                        <td className="px-3 py-2 text-gray-300">{o.memberCount}</td>
                        <td className="px-3 py-2 text-gray-300">{o.sceneCount}</td>
                        <td className="px-3 py-2 text-gray-400">
                          {new Date(o.createdAt).toLocaleDateString()}
                        </td>
                        <td className="px-3 py-2">
                          <ConfirmAction
                            prompt={`Delete organization "${o.name}"? This cannot be undone.`}
                            confirmLabel="Delete"
                            onConfirm={() => handleDeleteOrg(o.id, o.name)}
                            className="text-red-400 hover:text-red-300 text-xs"
                          >
                            Delete
                          </ConfirmAction>
                        </td>
                      </tr>
                    ))}
                    {orgs.length === 0 && (
                      <tr>
                        <td colSpan={6} className="px-3 py-8 text-center text-gray-500">
                          No organizations found.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>

              {/* Pagination */}
              {orgsTotal > PAGE_SIZE && (
                <div className="flex items-center justify-between text-sm text-gray-400">
                  <span>
                    Showing {orgsOffset + 1}-{Math.min(orgsOffset + PAGE_SIZE, orgsTotal)} of{' '}
                    {orgsTotal}
                  </span>
                  <div className="flex gap-2">
                    <button
                      onClick={() => setOrgsOffset((prev) => Math.max(0, prev - PAGE_SIZE))}
                      disabled={orgsOffset === 0}
                      className="px-3 py-1 rounded bg-gray-800 hover:bg-gray-700 disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      Prev
                    </button>
                    <span className="px-2 py-1">
                      Page {currentOrgsPage} of {totalOrgsPages}
                    </span>
                    <button
                      onClick={() => setOrgsOffset((prev) => prev + PAGE_SIZE)}
                      disabled={orgsOffset + PAGE_SIZE >= orgsTotal}
                      className="px-3 py-1 rounded bg-gray-800 hover:bg-gray-700 disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      Next
                    </button>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  )
}
