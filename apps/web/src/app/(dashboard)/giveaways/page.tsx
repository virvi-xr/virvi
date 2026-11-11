'use client'
import { useApi, useDemoPrefix } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { useSearchParams, useRouter } from 'next/navigation'
import { useEffect, useState, Suspense } from 'react'
import { Badge, badgeClass, PageHeader, PrimaryButton, Skeleton, tableHead } from '@/components/ui'
import { PlusIcon } from '@/components/icons'
import { countLabel } from '@/lib/format'

export default function GiveawaysPage() {
  return (
    <Suspense fallback={<Skeleton />}>
      <GiveawaysContent />
    </Suspense>
  )
}

function GiveawaysContent() {
  const { token } = useAuth()
  const api = useApi()
  const prefix = useDemoPrefix()
  const searchParams = useSearchParams()
  const router = useRouter()
  const selectedId = searchParams.get('id')
  const [giveaways, setGiveaways] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [showCreate, setShowCreate] = useState(false)
  const [newName, setNewName] = useState('')
  const [newClaimLimit, setNewClaimLimit] = useState('1')
  const [newEnabled, setNewEnabled] = useState(true)

  useEffect(() => {
    if (!token) return
    api.getGiveaways()
      .then(data => { setGiveaways(data.giveaways); setLoading(false) })
      .catch(() => setLoading(false))
  }, [token])

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!newName.trim()) return
    const { giveaway } = await api.createGiveaway({
      name: newName.trim(),
      claimLimit: parseInt(newClaimLimit) || 1,
      enabled: newEnabled,
    })
    setGiveaways(prev => [giveaway, ...prev])
    setNewName('')
    setNewClaimLimit('1')
    setNewEnabled(true)
    setShowCreate(false)
  }

  if (selectedId) {
    return (
      <div className="mx-auto max-w-7xl">
        <GiveawayDetail id={selectedId} onDeleted={() => {
          setGiveaways(prev => prev.filter(g => g.id !== selectedId))
          router.push(`${prefix}/giveaways`)
        }} />
      </div>
    )
  }


  return (
    <div className="mx-auto max-w-7xl">
      <PageHeader
        crumbs={['Workspace', 'Giveaways']}
        title="Giveaways"
        count={loading ? undefined : countLabel(giveaways.length)}
        subtitle="Set up rewards for the people who visit your scenes."
        actions={<PrimaryButton onClick={() => setShowCreate(!showCreate)}><PlusIcon size={16} /> Create Giveaway</PrimaryButton>}
      />

      {showCreate && (
        <form onSubmit={handleCreate} className="mb-6 rounded-lg border border-gray-800 bg-gray-900 p-4 space-y-3">
          <div className="flex gap-2">
            <input type="text" value={newName} onChange={e => setNewName(e.target.value)}
              placeholder="Giveaway name" autoFocus
              className="flex-1 rounded-md bg-gray-950 px-4 py-2 text-white outline-none focus:border-blue-400 border border-gray-800" />
            <input type="number" value={newClaimLimit} onChange={e => setNewClaimLimit(e.target.value)}
              placeholder="Claim limit" min="1"
              className="w-32 rounded-md bg-gray-950 px-4 py-2 text-white outline-none focus:border-blue-400 border border-gray-800" />
          </div>
          <div className="flex items-center gap-4">
            <label className="flex items-center gap-2 text-sm text-gray-300">
              <input type="checkbox" checked={newEnabled} onChange={e => setNewEnabled(e.target.checked)}
                className="rounded" />
              Enabled
            </label>
            <div className="flex-1" />
            <button type="submit" className="rounded-md bg-blue-600 px-4 py-2 text-sm hover:bg-blue-700">Create</button>
            <button type="button" onClick={() => setShowCreate(false)} className="rounded-md bg-gray-800 px-4 py-2 text-sm hover:bg-gray-700">Cancel</button>
          </div>
        </form>
      )}

      {loading ? (
        <Skeleton />
      ) : giveaways.length === 0 ? (
        <p className="text-gray-500">No giveaways yet. Create one to get started.</p>
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
          {giveaways.map(g => (
            <button key={g.id} onClick={() => router.push(`${prefix}/giveaways?id=${g.id}`)}
              className="rounded-lg border border-gray-800 bg-gray-900 p-4 hover:border-gray-600 transition-colors text-left">
              <div className="flex items-center justify-between">
                <h3 className="font-semibold">{g.name}</h3>
                <Badge tone={g.enabled ? 'success' : 'neutral'}>{g.enabled ? 'Enabled' : 'Disabled'}</Badge>
              </div>
              <p className="mt-2 text-sm text-gray-400">Claim limit: {g.claimLimit ?? 1}</p>
              <p className="mt-1 text-xs text-gray-600">ID: {g.id}</p>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

// ── Giveaway Detail View ────────────────────────────────────────────────────

function GiveawayDetail({ id, onDeleted }: { id: string; onDeleted: () => void }) {
  const { token } = useAuth()
  const api = useApi()
  const prefix = useDemoPrefix()
  const [giveaway, setGiveaway] = useState<any>(null)
  const [claims, setClaims] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [claimsLoading, setClaimsLoading] = useState(true)
  const [error, setError] = useState('')

  // Edit form state
  const [editName, setEditName] = useState('')
  const [editClaimLimit, setEditClaimLimit] = useState('1')
  const [saving, setSaving] = useState(false)

  // Add item form
  const [showAddItem, setShowAddItem] = useState(false)
  const [itemName, setItemName] = useState('')
  const [itemImageUrl, setItemImageUrl] = useState('')
  const [itemContractAddress, setItemContractAddress] = useState('')
  const [itemTokenId, setItemTokenId] = useState('')

  // Delete confirmation
  const [confirmDelete, setConfirmDelete] = useState(false)

  useEffect(() => {
    if (!token) return
    loadGiveaway()
    loadClaims()
  }, [token, id])

  const loadGiveaway = async () => {
    try {
      const { giveaway: g } = await api.getGiveaway(id)
      setGiveaway(g)
      setEditName(g.name)
      setEditClaimLimit(String(g.claimLimit ?? 1))
      setLoading(false)
    } catch (err: any) {
      setError(err.message)
      setLoading(false)
    }
  }

  const loadClaims = async () => {
    try {
      const { claims: c } = await api.getGiveawayClaims(id)
      setClaims(c)
      setClaimsLoading(false)
    } catch {
      setClaimsLoading(false)
    }
  }

  const handleUpdate = async (e: React.FormEvent) => {
    e.preventDefault()
    setSaving(true)
    try {
      const { giveaway: updated } = await api.updateGiveaway(id, {
        name: editName.trim(),
        claimLimit: parseInt(editClaimLimit) || 1,
      })
      setGiveaway((prev: any) => ({ ...prev, ...updated }))
    } catch (err: any) {
      setError(err.message)
    }
    setSaving(false)
  }

  const handleToggleEnabled = async () => {
    try {
      const { giveaway: updated } = await api.updateGiveaway(id, { enabled: !giveaway.enabled })
      setGiveaway((prev: any) => ({ ...prev, ...updated }))
    } catch (err: any) {
      setError(err.message)
    }
  }

  const handleAddItem = async (e: React.FormEvent) => {
    e.preventDefault()
    try {
      const { item } = await api.addGiveawayItem(id, {
        name: itemName.trim() || undefined,
        imageUrl: itemImageUrl.trim() || undefined,
        contractAddress: itemContractAddress.trim() || undefined,
        tokenId: itemTokenId.trim() || undefined,
      })
      setGiveaway((prev: any) => ({ ...prev, items: [...(prev.items || []), item] }))
      setItemName('')
      setItemImageUrl('')
      setItemContractAddress('')
      setItemTokenId('')
      setShowAddItem(false)
    } catch (err: any) {
      setError(err.message)
    }
  }

  const handleDeleteItem = async (itemId: string) => {
    try {
      await api.deleteGiveawayItem(id, itemId)
      setGiveaway((prev: any) => ({
        ...prev,
        items: (prev.items || []).filter((i: any) => i.id !== itemId),
      }))
    } catch (err: any) {
      setError(err.message)
    }
  }

  const handleDelete = async () => {
    try {
      await api.deleteGiveaway(id)
      onDeleted()
    } catch (err: any) {
      setError(err.message)
    }
  }

  if (loading) return <Skeleton />
  if (error && !giveaway) return <p className="text-red-400">Error: {error}</p>
  if (!giveaway) return <p className="text-gray-500">Giveaway not found.</p>

  return (
    <div className="space-y-6">
      <PageHeader
        crumbs={['Workspace', { label: 'Giveaways', href: `${prefix}/giveaways` }, giveaway.name]}
        title={giveaway.name}
        subtitle={<span className="text-sm text-gray-500">Claims: {giveaway.claimCount ?? 0} &middot; Items: {giveaway.items?.length ?? 0} &middot; ID: {giveaway.id}</span>}
        actions={
          <button onClick={handleToggleEnabled} title={giveaway.enabled ? 'Click to disable' : 'Click to enable'}
            className={`${badgeClass(giveaway.enabled ? 'success' : 'neutral')} hover:brightness-125`}>
            {giveaway.enabled ? 'Enabled' : 'Disabled'}
          </button>
        }
      />

      {error && <p className="text-red-400 text-sm">{error}</p>}

      {/* ── Edit Form ───────────────────────────────────────────────────────── */}
      <form onSubmit={handleUpdate} className="rounded-lg border border-gray-800 bg-gray-900 p-4 space-y-3">
        <h2 className="text-lg font-semibold">Settings</h2>
        <div className="flex gap-2">
          <input type="text" value={editName} onChange={e => setEditName(e.target.value)}
            placeholder="Name"
            className="flex-1 rounded-md bg-gray-950 px-4 py-2 text-white outline-none focus:border-blue-400 border border-gray-800" />
          <input type="number" value={editClaimLimit} onChange={e => setEditClaimLimit(e.target.value)}
            placeholder="Claim limit" min="1"
            className="w-32 rounded-md bg-gray-950 px-4 py-2 text-white outline-none focus:border-blue-400 border border-gray-800" />
          <button type="submit" disabled={saving}
            className="rounded-md bg-blue-600 px-4 py-2 text-sm hover:bg-blue-700 disabled:opacity-50">
            {saving ? 'Saving...' : 'Save'}
          </button>
        </div>
      </form>

      {/* ── Items Section ───────────────────────────────────────────────────── */}
      <div className="rounded-lg border border-gray-800 bg-gray-900 p-4 space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">Items</h2>
          <button onClick={() => setShowAddItem(!showAddItem)}
            className="text-sm text-blue-400 hover:text-blue-300">
            + Add Item
          </button>
        </div>

        {showAddItem && (
          <form onSubmit={handleAddItem} className="space-y-2 border-t border-gray-800 pt-3">
            <div className="grid grid-cols-2 gap-2">
              <input type="text" value={itemName} onChange={e => setItemName(e.target.value)}
                placeholder="Item name"
                className="rounded-md bg-gray-950 px-3 py-2 text-sm text-white outline-none focus:border-blue-400 border border-gray-800" />
              <input type="text" value={itemImageUrl} onChange={e => setItemImageUrl(e.target.value)}
                placeholder="Image URL"
                className="rounded-md bg-gray-950 px-3 py-2 text-sm text-white outline-none focus:border-blue-400 border border-gray-800" />
              <input type="text" value={itemContractAddress} onChange={e => setItemContractAddress(e.target.value)}
                placeholder="Contract address"
                className="rounded-md bg-gray-950 px-3 py-2 text-sm text-white outline-none focus:border-blue-400 border border-gray-800" />
              <input type="text" value={itemTokenId} onChange={e => setItemTokenId(e.target.value)}
                placeholder="Token ID"
                className="rounded-md bg-gray-950 px-3 py-2 text-sm text-white outline-none focus:border-blue-400 border border-gray-800" />
            </div>
            <div className="flex gap-2">
              <button type="submit" className="rounded-md bg-blue-600 px-3 py-1.5 text-sm hover:bg-blue-700">Add</button>
              <button type="button" onClick={() => setShowAddItem(false)} className="rounded-md bg-gray-800 px-3 py-1.5 text-sm hover:bg-gray-700">Cancel</button>
            </div>
          </form>
        )}

        {(!giveaway.items || giveaway.items.length === 0) ? (
          <p className="text-sm text-gray-500">No items yet.</p>
        ) : (
          <div className="space-y-2">
            {giveaway.items.map((item: any) => (
              <div key={item.id} className="flex items-center justify-between rounded-md bg-gray-800/50 px-3 py-2">
                <div className="flex items-center gap-3 min-w-0">
                  {item.imageUrl && (
                    <img src={item.imageUrl} alt={item.name || 'item'} className="h-8 w-8 rounded object-cover" />
                  )}
                  <div className="min-w-0">
                    <p className="text-sm font-medium truncate">{item.name || 'Unnamed item'}</p>
                    <p className="text-xs text-gray-500 truncate">
                      {item.contractAddress ? `${item.contractAddress.slice(0, 10)}...` : ''}
                      {item.contractAddress && item.tokenId ? ' / ' : ''}
                      {item.tokenId ? `#${item.tokenId}` : ''}
                      {!item.contractAddress && !item.tokenId ? 'No contract info' : ''}
                    </p>
                  </div>
                </div>
                <button onClick={() => handleDeleteItem(item.id)}
                  className="ml-2 text-xs text-red-400 hover:text-red-300 shrink-0">
                  Delete
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ── Claims Section ──────────────────────────────────────────────────── */}
      <div className="rounded-lg border border-gray-800 bg-gray-900 p-4 space-y-3">
        <h2 className="text-lg font-semibold">Claims ({claims.length})</h2>

        {claimsLoading ? (
          <Skeleton rows={2} className="h-12" />
        ) : claims.length === 0 ? (
          <p className="text-sm text-gray-500">No claims yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className={tableHead}>
                <tr className="border-b border-gray-800">
                  <th className="pb-2 pr-4">Wallet / User</th>
                  <th className="pb-2 pr-4">Item</th>
                  <th className="pb-2 pr-4">Status</th>
                  <th className="pb-2">Claimed At</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-800/50">
                {claims.map((claim: any) => (
                  <tr key={claim.id}>
                    <td className="py-2 pr-4 truncate max-w-[200px]">
                      {claim.walletAddress
                        ? `${claim.walletAddress.slice(0, 6)}...${claim.walletAddress.slice(-4)}`
                        : claim.userId || 'Unknown'}
                    </td>
                    <td className="py-2 pr-4">{claim.item?.name || claim.itemId?.slice(0, 8) || 'N/A'}</td>
                    <td className="py-2 pr-4">
                      <Badge tone={claim.status === 'completed' ? 'success' : claim.status === 'pending' ? 'warning' : claim.status === 'failed' ? 'danger' : 'neutral'}>
                        {claim.status}
                      </Badge>
                    </td>
                    <td className="py-2 text-gray-400">
                      {claim.claimedAt ? new Date(claim.claimedAt).toLocaleString() : 'N/A'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* ── Delete Giveaway ─────────────────────────────────────────────────── */}
      <div className="rounded-lg border border-red-900/50 bg-gray-900 p-4">
        <h2 className="text-lg font-semibold text-red-400 mb-2">Danger Zone</h2>
        {!confirmDelete ? (
          <button onClick={() => setConfirmDelete(true)}
            className="rounded-md bg-red-900/30 px-4 py-2 text-sm text-red-400 hover:bg-red-900/50">
            Delete Giveaway
          </button>
        ) : (
          <div className="flex items-center gap-3">
            <p className="text-sm text-gray-300">Are you sure? This cannot be undone.</p>
            <button onClick={handleDelete}
              className="rounded-md bg-red-600 px-4 py-2 text-sm text-white hover:bg-red-700">
              Confirm Delete
            </button>
            <button onClick={() => setConfirmDelete(false)}
              className="rounded-md bg-gray-800 px-3 py-2 text-sm hover:bg-gray-700">
              Cancel
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
