'use client'
import { useApi } from '@/lib/api'
import { ErrorPromptSetting } from './ErrorPromptSetting'
import { PrivacySetting } from './PrivacySetting'
import { NotificationSettings } from './NotificationSettings'
import { AssistantActivity } from './AssistantActivity'
import { memberLabel, type OrgMember, type OrgSummary } from '@/lib/orgs'
import { deleteAccountRequest, DELETE_WORD } from '@/lib/account-delete'
import { useAuth } from '@/lib/auth'
import { useEffect, useState } from 'react'
import { useDialog } from '@/lib/use-dialog'
import { LinkedWallets } from './LinkedWallets'
import { EmailVerification } from './EmailVerification'
import { MoveBeats } from './MoveBeats'
import { RaffleEntries } from './RaffleEntries'
import { LinkedHyperfySessions } from './LinkedHyperfySessions'
import { PairedHeadsets } from './PairedHeadsets'
import { Badge, PageHeader, PlatformBadge, Skeleton, tableHeadBand, TableScroll } from '@/components/ui'
import { useInstance } from '@/lib/instance'
import { canManageBranding } from '@/lib/branding'
import { BrandingSettings } from './BrandingSettings'
import { BillingSection } from './BillingSection'

export default function SettingsPage() {
  const { user, token, updateUser, signOut } = useAuth()
  const api = useApi()
  const [orgs, setOrgs] = useState<OrgSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [showCreate, setShowCreate] = useState(false)
  const [newOrgName, setNewOrgName] = useState('')
  const [expandedOrgId, setExpandedOrgId] = useState<string | null>(null)
  const [members, setMembers] = useState<Record<string, OrgMember[]>>({})
  const [membersLoading, setMembersLoading] = useState<string | null>(null)
  const [inviteEmail, setInviteEmail] = useState('')
  const [inviteRole, setInviteRole] = useState('member')
  const [error, setError] = useState<string | null>(null)
  const [activeOrgId, setActiveOrgId] = useState<string | null>(null)

  // Account state
  const [displayName, setDisplayName] = useState('')
  const [profileSaving, setProfileSaving] = useState(false)
  const [profileSuccess, setProfileSuccess] = useState(false)
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [passwordSaving, setPasswordSaving] = useState(false)
  const [passwordSuccess, setPasswordSuccess] = useState(false)
  const [passwordError, setPasswordError] = useState<string | null>(null)
  const [showDeleteModal, setShowDeleteModal] = useState(false)
  const [deletePassword, setDeletePassword] = useState('')
  const [deleteLoading, setDeleteLoading] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  /** Whether deleting asks for the password (true) or the typed DELETE (false); null while it is being asked. */
  const [deleteHasPassword, setDeleteHasPassword] = useState<boolean | null>(null)

  // API Keys state
  const [apiKeys, setApiKeys] = useState<any[]>([])
  const [apiKeysLoading, setApiKeysLoading] = useState(true)
  const [newKeyName, setNewKeyName] = useState('')
  const [newKeyAccess, setNewKeyAccess] = useState<'read' | 'full'>('full')
  /** LIV-170: limit the new key to some scenes; null while the account's scenes haven't been loaded */
  const [keyLimited, setKeyLimited] = useState(false)
  const [keySceneChoices, setKeySceneChoices] = useState<Array<{ id: string; name: string }> | null>(null)
  const [keyScenes, setKeyScenes] = useState<string[]>([])
  /** LIV-170: the key whose MCP activity is open, and its calls (null while loading) */
  const [activityFor, setActivityFor] = useState<string | null>(null)
  const [keyCalls, setKeyCalls] = useState<Awaited<ReturnType<typeof api.getApiKeyCalls>>['calls'] | null>(null)
  const toggleActivity = (keyId: string) => {
    if (activityFor === keyId) return setActivityFor(null)
    setActivityFor(keyId)
    setKeyCalls(null)
    api.getApiKeyCalls(keyId).then((d) => setKeyCalls(d.calls), () => setKeyCalls([]))
  }
  const [createdKey, setCreatedKey] = useState<string | null>(null)
  const [keyCopied, setKeyCopied] = useState(false)
  const [showCreateKey, setShowCreateKey] = useState(false)
  const [deletingKeyId, setDeletingKeyId] = useState<string | null>(null)

  // Platform Hooks state
  const [hooks, setHooks] = useState<any[]>([])
  const [hooksLoading, setHooksLoading] = useState(true)
  const [deletingHookId, setDeletingHookId] = useState<string | null>(null)

  const instance = useInstance()

  // Initialize display name from user
  useEffect(() => {
    if (user?.displayName) setDisplayName(user.displayName)
  }, [user?.displayName])

  useEffect(() => {
    if (!token) return
    api.getOrgs()
      .then(data => {
        setOrgs(data.organizations)
        // Detect active org — look for one flagged active, or fall back to first
        const active = data.organizations.find((o) => o.isActive) || data.organizations[0]
        if (active) setActiveOrgId(active.id)
        setLoading(false)
      })
      .catch(() => setLoading(false))
  }, [token])

  // Fetch API keys
  useEffect(() => {
    if (!token) return
    api.getApiKeys()
      .then(data => {
        setApiKeys(data.keys)
        setApiKeysLoading(false)
      })
      .catch(() => setApiKeysLoading(false))
  }, [token])

  // Fetch platform hooks
  useEffect(() => {
    if (!token) return
    api.getHooks()
      .then(data => {
        setHooks(data.hooks)
        setHooksLoading(false)
      })
      .catch(() => setHooksLoading(false))
  }, [token])

  const handleCreateApiKey = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!newKeyName.trim()) return
    setError(null)
    try {
      // The reply is the new row plus the raw key, shown once
      if (keyLimited && keyScenes.length === 0) { setError('Choose at least one scene, or turn off "Only some scenes".'); return }
      const { key, ...apiKey } = await api.createApiKey(newKeyName.trim(), newKeyAccess, keyLimited ? keyScenes : [])
      setApiKeys(prev => [{ ...apiKey, lastUsedAt: null }, ...prev])
      setCreatedKey(key)
      setNewKeyAccess('full')
      setKeyLimited(false)
      setKeyScenes([])
      setKeyCopied(false)
      setNewKeyName('')
      setShowCreateKey(false)
    } catch (err: any) {
      setError(err.message)
    }
  }

  const handleCopyKey = async () => {
    if (!createdKey) return
    await navigator.clipboard.writeText(createdKey)
    setKeyCopied(true)
  }

  const handleDeleteApiKey = async (keyId: string) => {
    setError(null)
    try {
      await api.deleteApiKey(keyId)
      setApiKeys(prev => prev.filter(k => k.id !== keyId))
      setDeletingKeyId(null)
    } catch (err: any) {
      setError(err.message)
    }
  }

  const handleDeleteHook = async (hookId: string) => {
    setError(null)
    try {
      await api.deleteHook(hookId)
      setHooks(prev => prev.filter(h => h.id !== hookId))
      setDeletingHookId(null)
    } catch (err: any) {
      setError(err.message)
    }
  }

  const handleCreateOrg = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!newOrgName.trim()) return
    setError(null)
    try {
      const { organization } = await api.createOrg(newOrgName.trim())
      setOrgs(prev => [organization, ...prev])
      setNewOrgName('')
      setShowCreate(false)
    } catch (err: any) {
      setError(err.message)
    }
  }

  const handleToggleExpand = async (orgId: string) => {
    if (expandedOrgId === orgId) {
      setExpandedOrgId(null)
      return
    }
    setExpandedOrgId(orgId)
    if (!members[orgId]) {
      setMembersLoading(orgId)
      try {
        const data = await api.getOrgMembers(orgId)
        setMembers(prev => ({ ...prev, [orgId]: data.members }))
      } catch {
        setMembers(prev => ({ ...prev, [orgId]: [] }))
      }
      setMembersLoading(null)
    }
  }

  const handleSwitchOrg = async (orgId: string) => {
    setError(null)
    try {
      await api.setActiveOrg(orgId)
      setActiveOrgId(orgId)
    } catch (err: any) {
      setError(err.message)
    }
  }

  const handleInvite = async (orgId: string) => {
    if (!inviteEmail.trim()) return
    setError(null)
    try {
      await api.inviteToOrg(orgId, inviteEmail.trim(), inviteRole)
      setInviteEmail('')
      setInviteRole('member')
    } catch (err: any) {
      setError(err.message)
    }
  }

  const handleRemoveMember = async (orgId: string, userId: string) => {
    setError(null)
    try {
      await api.removeOrgMember(orgId, userId)
      setMembers(prev => ({
        ...prev,
        [orgId]: (prev[orgId] || []).filter((m) => m.userId !== userId),
      }))
      setOrgs(prev => prev.map((o) => (o.id === orgId ? { ...o, memberCount: Math.max(0, o.memberCount - 1) } : o)))
    } catch (err: any) {
      setError(err.message)
    }
  }

  const isAdminOrOwner = (org: OrgSummary) => {
    return org.role === 'owner' || org.role === 'admin'
  }

  const handleUpdateProfile = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!displayName.trim()) return
    setProfileSaving(true)
    setProfileSuccess(false)
    setError(null)
    try {
      const { user: updated } = await api.updateProfile(displayName.trim())
      updateUser({ displayName: updated.displayName })
      setProfileSuccess(true)
      setTimeout(() => setProfileSuccess(false), 3000)
    } catch (err: any) {
      setError(err.message)
    }
    setProfileSaving(false)
  }

  const handleChangePassword = async (e: React.FormEvent) => {
    e.preventDefault()
    setPasswordError(null)
    setPasswordSuccess(false)

    if (newPassword.length < 8) {
      setPasswordError('New password must be at least 8 characters')
      return
    }
    if (newPassword !== confirmPassword) {
      setPasswordError('Passwords do not match')
      return
    }

    setPasswordSaving(true)
    try {
      await api.changePassword(currentPassword, newPassword)
      setPasswordSuccess(true)
      setCurrentPassword('')
      setNewPassword('')
      setConfirmPassword('')
      setTimeout(() => setPasswordSuccess(false), 3000)
    } catch (err: any) {
      setPasswordError(err.message)
    }
    setPasswordSaving(false)
  }

  const openDelete = () => {
    setShowDeleteModal(true)
    setDeleteHasPassword(null)
    // An account that can't answer is asked for a password, as before
    api.getAccount().then((a) => setDeleteHasPassword(a.hasPassword)).catch(() => setDeleteHasPassword(true))
  }

  const deleteBody = deleteHasPassword === null ? null : deleteAccountRequest(deleteHasPassword, deletePassword)

  const handleDeleteAccount = async () => {
    setDeleteError(null)
    if (!deleteBody) {
      setDeleteError(deleteHasPassword === false ? `Type ${DELETE_WORD} to confirm` : 'Password is required')
      return
    }
    setDeleteLoading(true)
    try {
      await api.deleteAccount(deleteBody)
      signOut()
    } catch (err: any) {
      // not_allowed_here (a session signed in with an open reissue's old wallet) carries its own plain message
      setDeleteError(err.body?.message ?? err.message)
      setDeleteLoading(false)
    }
  }

  const closeDelete = () => { setShowDeleteModal(false); setDeletePassword(''); setDeleteError(null) }
  const deleteDialog = useDialog(showDeleteModal, closeDelete, !deleteLoading)

  if (loading) return <Skeleton />

  return (
    <div className="mx-auto max-w-7xl">
      <PageHeader crumbs={['System', 'Settings']} title="Settings" subtitle="Your account, organizations, billing and API keys." />

      {error && (
        <div className="mb-4 rounded-md bg-red-900/50 border border-red-700 px-4 py-2 text-sm text-red-300">
          {error}
        </div>
      )}

      {/* Account */}
      <section className="mb-10">
        <h2 className="text-lg font-semibold mb-4">Account</h2>
        <div className="space-y-6">
          {/* Display Name */}
          <div className="rounded-lg border border-gray-800 bg-gray-900 p-6">
            <h3 className="text-sm font-medium text-gray-300 mb-3">Display Name</h3>
            <form onSubmit={handleUpdateProfile} className="flex gap-3">
              <input aria-label="Your display name"
                type="text"
                value={displayName}
                onChange={e => setDisplayName(e.target.value)}
                placeholder="Your display name"
                className="flex-1 rounded-md bg-gray-950 px-4 py-2 text-white outline-none focus:border-blue-400 border border-gray-800"
              />
              <button
                type="submit"
                disabled={profileSaving || displayName.trim() === (user?.displayName || '')}
                className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium hover:bg-blue-700 disabled:opacity-50 transition-colors"
              >
                {profileSaving ? 'Saving...' : profileSuccess ? 'Saved!' : 'Save'}
              </button>
            </form>
          </div>

          <EmailVerification />

          <LinkedWallets />

          <MoveBeats />

          <RaffleEntries />

          <PrivacySetting />

          <NotificationSettings />

          <ErrorPromptSetting />

          <AssistantActivity />

          <LinkedHyperfySessions />

          <PairedHeadsets />

          {/* Change Password */}
          <div className="rounded-lg border border-gray-800 bg-gray-900 p-6">
            <h3 className="text-sm font-medium text-gray-300 mb-3">Change Password</h3>
            {passwordError && (
              <div className="mb-3 rounded-md bg-red-900/50 border border-red-700 px-4 py-2 text-sm text-red-300">
                {passwordError}
              </div>
            )}
            {passwordSuccess && (
              <div className="mb-3 rounded-md bg-green-900/50 border border-green-700 px-4 py-2 text-sm text-green-300">
                Password changed successfully
              </div>
            )}
            <form onSubmit={handleChangePassword} className="space-y-3">
              <input aria-label="Current password"
                type="password"
                value={currentPassword}
                onChange={e => setCurrentPassword(e.target.value)}
                placeholder="Current password"
                className="w-full rounded-md bg-gray-950 px-4 py-2 text-white outline-none focus:border-blue-400 border border-gray-800"
              />
              <input aria-label="New password"
                type="password"
                value={newPassword}
                onChange={e => setNewPassword(e.target.value)}
                placeholder="New password"
                className="w-full rounded-md bg-gray-950 px-4 py-2 text-white outline-none focus:border-blue-400 border border-gray-800"
              />
              <input aria-label="Confirm new password"
                type="password"
                value={confirmPassword}
                onChange={e => setConfirmPassword(e.target.value)}
                placeholder="Confirm new password"
                className="w-full rounded-md bg-gray-950 px-4 py-2 text-white outline-none focus:border-blue-400 border border-gray-800"
              />
              <button
                type="submit"
                disabled={passwordSaving || !currentPassword || !newPassword || !confirmPassword}
                className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium hover:bg-blue-700 disabled:opacity-50 transition-colors"
              >
                {passwordSaving ? 'Changing...' : 'Change Password'}
              </button>
            </form>
          </div>

          {/* Danger Zone */}
          <div className="rounded-lg border border-red-900 bg-gray-900 p-6">
            <h3 className="text-sm font-medium text-red-400 mb-2">Danger Zone</h3>
            <p className="text-sm text-gray-400 mb-4">
              Once you delete your account, there is no going back. All your data will be permanently removed.
            </p>
            <button
              onClick={openDelete}
              className="rounded-md bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700 transition-colors"
            >
              Delete Account
            </button>
          </div>
        </div>
      </section>

      {/* Delete Account Modal */}
      {showDeleteModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
          <div ref={deleteDialog} role="dialog" aria-modal="true" aria-labelledby="delete-account-title" className="w-full max-w-md rounded-lg border border-gray-700 bg-gray-900 p-6 shadow-xl">
            <h3 id="delete-account-title" className="text-lg font-semibold text-white mb-2">Delete Account</h3>
            <p className="text-sm text-gray-400 mb-4">
              {deleteHasPassword === false
                ? <>This action is irreversible. Type <strong className="text-white">{DELETE_WORD}</strong> to confirm.</>
                : 'This action is irreversible. Enter your password to confirm.'}
            </p>
            {deleteError && (
              <div className="mb-3 rounded-md bg-red-900/50 border border-red-700 px-4 py-2 text-sm text-red-300">
                {deleteError}
              </div>
            )}
            <input aria-label={deleteHasPassword === false ? `Type ${DELETE_WORD}` : 'Your password'}
              type={deleteHasPassword === false ? 'text' : 'password'}
              autoComplete="off"
              disabled={deleteHasPassword === null}
              value={deletePassword}
              onChange={e => setDeletePassword(e.target.value)}
              placeholder={deleteHasPassword === false ? DELETE_WORD : 'Your password'}
              className="w-full rounded-md bg-gray-950 px-4 py-2 text-white outline-none mb-4 focus:border-blue-400 border border-gray-800"
            />
            <div className="flex justify-end gap-3">
              <button
                onClick={closeDelete}
                className="rounded-md bg-gray-800 px-4 py-2 text-sm font-medium hover:bg-gray-700 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleDeleteAccount}
                disabled={deleteLoading || !deleteBody}
                className="rounded-md bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50 transition-colors"
              >
                {deleteLoading ? 'Deleting...' : 'Delete My Account'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Your Organizations */}
      <section>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold">Your Organizations</h2>
          <button onClick={() => setShowCreate(!showCreate)}
            className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium hover:bg-blue-700">
            + Create Organization
          </button>
        </div>

        {showCreate && (
          <form onSubmit={handleCreateOrg} className="mb-6 flex gap-2">
            <input aria-label="Organization name" type="text" value={newOrgName} onChange={e => setNewOrgName(e.target.value)}
              placeholder="Organization name" autoFocus
              className="flex-1 rounded-md bg-gray-950 px-4 py-2 text-white outline-none focus:border-blue-400 border border-gray-800" />
            <button type="submit" className="rounded-md bg-blue-600 px-4 py-2 text-sm hover:bg-blue-700">Create</button>
            <button type="button" onClick={() => setShowCreate(false)} className="rounded-md bg-gray-800 px-4 py-2 text-sm hover:bg-gray-700">Cancel</button>
          </form>
        )}

        {orgs.length === 0 ? (
          <p className="text-gray-500">No organizations yet. Create one to get started.</p>
        ) : (
          <div className="space-y-3">
            {orgs.map(org => (
              <div key={org.id} className="rounded-lg border border-gray-800 bg-gray-900 overflow-hidden">
                {/* Org header */}
                <div className="flex items-center justify-between p-4 cursor-pointer hover:bg-gray-800/50 transition-colors"
                  onClick={() => handleToggleExpand(org.id)}>
                  <div className="flex items-center gap-3">
                    <div>
                      <div className="flex items-center gap-2">
                        <h3 className="font-semibold">{org.name}</h3>
                        {activeOrgId === org.id && (
                          <Badge tone="success">Active</Badge>
                        )}
                      </div>
                      <p className="mt-0.5 text-sm text-gray-400">
                        Role: <span className="capitalize">{org.role}</span>
                        {org.memberCount != null && <> &middot; {org.memberCount} member{org.memberCount !== 1 ? 's' : ''}</>}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    {activeOrgId !== org.id && (
                      <button onClick={(e) => { e.stopPropagation(); handleSwitchOrg(org.id) }}
                        className="rounded-md bg-gray-700 px-3 py-1.5 text-xs font-medium hover:bg-gray-600 transition-colors">
                        Switch
                      </button>
                    )}
                    <span className="text-gray-500 text-sm">{expandedOrgId === org.id ? '▲' : '▼'}</span>
                  </div>
                </div>

                {/* Expanded members section */}
                {expandedOrgId === org.id && (
                  <div className="border-t border-gray-800 p-4">
                    <h4 className="text-sm font-medium text-gray-300 mb-3">Members</h4>

                    {membersLoading === org.id ? (
                      <Skeleton rows={2} className="h-12" />
                    ) : (members[org.id] || []).length === 0 ? (
                      <p className="text-sm text-gray-500">No members found.</p>
                    ) : (
                      <div className="space-y-2 mb-4">
                        {(members[org.id] || []).map((member) => (
                          <div key={member.userId} className="flex items-center justify-between rounded-md bg-gray-800 px-3 py-2">
                            <div>
                              <p className="text-sm text-white">{memberLabel(member, user?.id)}</p>
                              <p className="text-xs text-gray-400 capitalize">{member.role}</p>
                            </div>
                            {isAdminOrOwner(org) && member.userId !== user?.id && (
                              <button onClick={() => handleRemoveMember(org.id, member.userId)}
                                className="rounded-md bg-red-900/50 border border-red-800 px-2 py-1 text-xs text-red-400 hover:bg-red-900 transition-colors">
                                Remove
                              </button>
                            )}
                          </div>
                        ))}
                      </div>
                    )}

                    {/* Invite form for admins/owners */}
                    {isAdminOrOwner(org) && (
                      <div className="mt-4 border-t border-gray-800 pt-4">
                        <h4 className="text-sm font-medium text-gray-300 mb-2">Invite Member</h4>
                        <div className="flex gap-2">
                          <input aria-label="Email address" type="email" value={inviteEmail} onChange={e => setInviteEmail(e.target.value)}
                            placeholder="Email address"
                            className="flex-1 rounded-md bg-gray-950 px-3 py-2 text-sm text-white outline-none focus:border-blue-400 border border-gray-800" />
                          <select aria-label="Role" value={inviteRole} onChange={e => setInviteRole(e.target.value)}
                            className="rounded-md bg-gray-950 px-3 py-2 text-sm text-white outline-none focus:border-blue-400 border border-gray-800">
                            <option value="member">Member</option>
                            <option value="admin">Admin</option>
                          </select>
                          <button onClick={() => handleInvite(org.id)}
                            className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium hover:bg-blue-700">
                            Invite
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Branding: self-hosted installs, instance admins only */}
      {canManageBranding(instance?.mode, user?.role) && <BrandingSettings />}

      <BillingSection />

      {/* API Keys */}
      <section className="mt-10">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold">API Keys</h2>
          <button onClick={() => { setShowCreateKey(!showCreateKey); setCreatedKey(null) }}
            className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium hover:bg-blue-700">
            + Create API Key
          </button>
        </div>
        <p className="mb-4 text-sm text-gray-400">
          A key acts as your account: use it with the REST API, or to <a href="/docs/agents/use-virvi-with-your-agent/#connect-with-mcp" className="text-blue-400 underline underline-offset-2 hover:text-blue-300">connect an AI agent</a> to Virvi&apos;s MCP server. A read-only key can look but never change anything.
        </p>

        {/* Newly created key banner */}
        {createdKey && (
          <div className="mb-6 rounded-lg border border-yellow-700 bg-yellow-900/30 p-4">
            <p className="text-sm font-medium text-yellow-300 mb-2">
              This key will only be shown once. Copy it now.
            </p>
            <div className="flex items-center gap-2">
              <code className="flex-1 rounded-md bg-gray-900 px-4 py-2 text-sm text-white font-mono select-all break-all">
                {createdKey}
              </code>
              <button onClick={handleCopyKey}
                className="shrink-0 rounded-md bg-gray-700 px-4 py-2 text-sm font-medium hover:bg-gray-600 transition-colors">
                {keyCopied ? 'Copied!' : 'Copy'}
              </button>
            </div>
            <button onClick={() => setCreatedKey(null)}
              className="mt-3 text-xs text-gray-400 hover:text-gray-300 transition-colors">
              Dismiss
            </button>
          </div>
        )}

        {/* Create key form */}
        {showCreateKey && (
          <form onSubmit={handleCreateApiKey} className="mb-6 flex flex-wrap gap-2">
            <input aria-label="Key name" type="text" value={newKeyName} onChange={e => setNewKeyName(e.target.value)}
              placeholder="Key name (e.g. production, ci/cd)" autoFocus
              className="flex-1 rounded-md bg-gray-950 px-4 py-2 text-white outline-none focus:border-blue-400 border border-gray-800" />
            <select aria-label="What the key can do" value={newKeyAccess} onChange={e => setNewKeyAccess(e.target.value as 'read' | 'full')}
              className="rounded-md bg-gray-800 px-3 py-2 text-sm text-white">
              <option value="full">Full access</option>
              <option value="read">Read only</option>
            </select>
            <button type="submit" className="rounded-md bg-blue-600 px-4 py-2 text-sm hover:bg-blue-700">Create</button>
            <button type="button" onClick={() => setShowCreateKey(false)} className="rounded-md bg-gray-800 px-4 py-2 text-sm hover:bg-gray-700">Cancel</button>
            <div className="basis-full space-y-2">
              <label className="flex items-center gap-2 text-sm text-gray-300">
                <input type="checkbox" checked={keyLimited} onChange={e => {
                  setKeyLimited(e.target.checked)
                  if (e.target.checked && !keySceneChoices) {
                    api.getScenes().then((d) => setKeySceneChoices((d.scenes ?? []).map((sc: any) => ({ id: sc.id, name: sc.name }))), () => setKeySceneChoices([]))
                  }
                }} />
                Only some scenes (the key can't touch anything else, including media and events)
              </label>
              {keyLimited && (
                keySceneChoices === null ? <p className="text-xs text-gray-400">Loading your scenes…</p>
                : keySceneChoices.length === 0 ? <p className="text-xs text-gray-400">You have no scenes yet.</p>
                : (
                  <fieldset className="flex flex-wrap gap-x-4 gap-y-1">
                    <legend className="sr-only">Scenes the key can use</legend>
                    {keySceneChoices.map((sc) => (
                      <label key={sc.id} className="flex items-center gap-1.5 text-sm text-gray-300">
                        <input type="checkbox" checked={keyScenes.includes(sc.id)}
                          onChange={e => setKeyScenes(e.target.checked ? [...keyScenes, sc.id] : keyScenes.filter((x) => x !== sc.id))} />
                        {sc.name}
                      </label>
                    ))}
                  </fieldset>
                )
              )}
            </div>
          </form>
        )}

        {apiKeysLoading ? (
          <Skeleton rows={2} className="h-12" />
        ) : apiKeys.length === 0 ? (
          <p className="text-gray-500">No API keys yet. Create one to get started.</p>
        ) : (
          <div className="space-y-3">
            {apiKeys.map(key => (
              <div key={key.id} className="flex flex-wrap items-center justify-between gap-y-3 rounded-lg border border-gray-800 bg-gray-900 p-4">
                <div className="min-w-0">
                  <p className="font-medium text-white">{key.name}{key.oauthClientId && <span className="ml-2 rounded bg-blue-900/60 px-2 py-0.5 text-xs font-normal text-blue-200">Connected app</span>}{key.access === 'read' && <span className="ml-2 rounded bg-gray-800 px-2 py-0.5 text-xs font-normal text-gray-300">Read only</span>}{key.sceneIds?.length > 0 && <span className="ml-2 rounded bg-gray-800 px-2 py-0.5 text-xs font-normal text-gray-300">{key.sceneIds.length === 1 ? '1 scene' : `${key.sceneIds.length} scenes`}</span>}</p>
                  <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-gray-400">
                    <span className="font-mono">{key.keyPrefix ? `${key.keyPrefix}...` : '---'}</span>
                    <span>Created {key.createdAt ? new Date(key.createdAt).toLocaleDateString() : '---'}</span>
                    <span>Last used {key.lastUsedAt ? new Date(key.lastUsedAt).toLocaleDateString() : 'Never'}</span>
                  </div>
                </div>
                <div className="shrink-0 ml-4 flex items-center gap-2">
                  <button type="button" onClick={() => toggleActivity(key.id)} aria-expanded={activityFor === key.id}
                    className="rounded-md bg-gray-800 px-3 py-1.5 text-xs hover:bg-gray-700">{activityFor === key.id ? 'Hide activity' : 'Activity'}</button>
                  {deletingKeyId === key.id ? (
                    <div className="flex items-center gap-2">
                      <span className="text-sm text-red-400">Delete?</span>
                      <button onClick={() => handleDeleteApiKey(key.id)}
                        className="rounded-md bg-red-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-700 transition-colors">
                        Confirm
                      </button>
                      <button onClick={() => setDeletingKeyId(null)}
                        className="rounded-md bg-gray-800 px-3 py-1.5 text-xs font-medium hover:bg-gray-700 transition-colors">
                        Cancel
                      </button>
                    </div>
                  ) : (
                    <button onClick={() => setDeletingKeyId(key.id)}
                      className="rounded-md bg-red-900/50 border border-red-800 px-3 py-1.5 text-xs text-red-400 hover:bg-red-900 transition-colors">
                      Delete
                    </button>
                  )}
                </div>
                {activityFor === key.id && (
                  <div className="basis-full border-t border-gray-800 pt-3 text-sm">
                    <p className="mb-2 text-xs text-gray-400">What an AI agent did with this key through Virvi&apos;s MCP server, newest first (the last 100, kept 90 days).</p>
                    {keyCalls === null ? <p className="text-xs text-gray-400">Loading…</p>
                    : keyCalls.length === 0 ? <p className="text-xs text-gray-400">No agent has used this key yet.</p>
                    : (
                      <ul className="space-y-1">
                        {keyCalls.map((c, i) => (
                          <li key={i} className="flex flex-wrap gap-x-3 text-xs">
                            <span className="text-gray-400">{new Date(c.at).toLocaleString()}</span>
                            <span className="font-mono text-gray-200">{c.tool}</span>
                            {c.sceneName && <span className="text-gray-300">{c.sceneName}</span>}
                            <span className={c.ok ? 'text-green-300' : 'text-red-300'}>{c.ok ? 'Done' : `Refused: ${c.error ?? 'failed'}`}</span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Platform Hooks */}
      <section className="mt-10">
        <h2 className="text-lg font-semibold mb-2">Platform Hooks</h2>
        <p className="text-sm text-gray-400 mb-4">
          External platforms register HTTP callbacks to receive real-time scene updates. This is used by platforms that can&apos;t use WebSocket (Second Life, IoT devices, etc.)
        </p>

        {hooksLoading ? (
          <Skeleton rows={2} className="h-12" />
        ) : hooks.length === 0 ? (
          <div className="rounded-lg border border-gray-800 bg-gray-900 p-6">
            <p className="text-gray-500">No platform hooks registered. External platforms register hooks automatically when they connect.</p>
          </div>
        ) : (
          <TableScroll label="Platform hooks" className="rounded-lg border border-gray-800">
            <table className="w-full text-sm">
              <thead className={tableHeadBand}>
                <tr>
                  <th className="px-4 py-3">Scene</th>
                  <th className="px-4 py-3">Platform</th>
                  <th className="px-4 py-3">Callback URL</th>
                  <th className="px-4 py-3">Element</th>
                  <th className="px-4 py-3">Mode</th>
                  <th className="px-4 py-3">Failures</th>
                  <th className="px-4 py-3">Registered</th>
                  <th className="px-4 py-3 text-right"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-800 bg-gray-900/50">
                {hooks.map(hook => (
                  <tr key={hook.id} className="hover:bg-gray-800/50 transition-colors">
                    <td className="px-4 py-3 text-white whitespace-nowrap">{hook.sceneName}</td>
                    <td className="px-4 py-3 text-gray-300 whitespace-nowrap">
                      <PlatformBadge platform={hook.platform} />
                    </td>
                    <td className="px-4 py-3 text-gray-300 max-w-[200px]">
                      <span className="block truncate font-mono text-xs" title={hook.callbackUrl}>
                        {hook.callbackUrl}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-gray-400 whitespace-nowrap text-xs">
                      {hook.elementType && hook.elementId ? (
                        <span>{hook.elementType} / {hook.elementId}</span>
                      ) : (
                        <span className="text-gray-600">--</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-gray-300 whitespace-nowrap">
                      <Badge tone={hook.mode === 'controller' ? 'violet' : 'info'}>{hook.mode}</Badge>
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap">
                      <span className={`text-xs font-medium ${hook.failureCount > 0 ? 'text-red-400' : 'text-gray-500'}`}>
                        {hook.failureCount}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-gray-400 whitespace-nowrap text-xs">
                      {hook.lastRegistered ? new Date(hook.lastRegistered).toLocaleString() : '--'}
                    </td>
                    <td className="px-4 py-3 text-right whitespace-nowrap">
                      {deletingHookId === hook.id ? (
                        <div className="flex items-center justify-end gap-2">
                          <span className="text-xs text-red-400">Delete?</span>
                          <button onClick={() => handleDeleteHook(hook.id)}
                            className="rounded-md bg-red-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-700 transition-colors">
                            Confirm
                          </button>
                          <button onClick={() => setDeletingHookId(null)}
                            className="rounded-md bg-gray-800 px-3 py-1.5 text-xs font-medium hover:bg-gray-700 transition-colors">
                            Cancel
                          </button>
                        </div>
                      ) : (
                        <button onClick={() => setDeletingHookId(hook.id)}
                          className="rounded-md bg-red-900/50 border border-red-800 px-3 py-1.5 text-xs text-red-400 hover:bg-red-900 transition-colors">
                          Delete
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableScroll>
        )}
      </section>
    </div>
  )
}
