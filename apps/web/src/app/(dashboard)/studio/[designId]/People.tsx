'use client'
import { useCallback, useEffect, useState } from 'react'
import { useApi } from '@/lib/api'
import { ConfirmAction, PrimaryButton, SelectField } from '@/components/ui'
import type { StudioDetail, StudioMember } from '@/lib/studio'
import { INVITE_ROLES, inviteExpiry, peopleRefusal, roleLabel, type InviteRole, type StudioInvite } from '@/lib/studio-people'

type Props = { designId: string; detail: StudioDetail; meId: string | null; onChanged: () => Promise<void>; onClose: () => void }

const nameOf = (m: Pick<StudioMember, 'displayName'>) => m.displayName?.trim() || 'Someone'
const small = 'rounded-md bg-gray-800 px-3 py-1.5 text-xs hover:bg-gray-700 disabled:opacity-50'

/**
 * The design's People panel (LIV-159). The owner invites by email with a role, changes roles, removes people, and
 * copies, resends or cancels pending invites; everyone else sees who is on the design and can leave it.
 */
export default function People({ designId, detail, meId, onChanged, onClose }: Props) {
  const api = useApi()
  const owner = detail.role === 'owner'
  const [members, setMembers] = useState<StudioMember[]>(detail.members ?? [])
  const [invites, setInvites] = useState<StudioInvite[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [status, setStatus] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const r = await api.getStudioPeople(designId)
      setMembers(r.members)
      setInvites(r.invites ?? [])
    } catch (err) {
      setError(peopleRefusal(err as never))
    }
  }, [designId]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { load() }, [load])

  /** One change: the panel and the design both re-read after it (a role change or removal changes the page too). */
  const run = async (fn: () => Promise<unknown>, done?: string): Promise<boolean> => {
    setBusy(true)
    setError(null)
    setStatus(null)
    try {
      await fn()
      if (done) setStatus(done)
      await load()
      await onChanged()
      return true
    } catch (err) {
      setError(peopleRefusal(err as never))
      return false
    } finally {
      setBusy(false)
    }
  }

  const leave = async () => {
    if (!meId) return
    setBusy(true)
    setError(null)
    try {
      await api.removeStudioMember(designId, meId)
      window.location.assign('/studio/')
    } catch (err) {
      setError(peopleRefusal(err as never))
      setBusy(false)
    }
  }

  return (
    <section aria-labelledby="people-heading" className="mb-6 rounded-lg border border-gray-800 bg-gray-900">
      <div className="flex items-center justify-between gap-3 border-b border-gray-800 px-4 py-3">
        <h2 id="people-heading" className="font-semibold">People</h2>
        <button type="button" onClick={onClose} className="text-sm text-gray-400 hover:text-white">Close</button>
      </div>

      {owner && <InviteForm busy={busy} onInvite={(email, role) => run(() => api.inviteToStudioDesign(designId, email, role), `Invited ${email}.`)} />}
      {status && <p className="px-4 pt-3 text-sm text-emerald-300" role="status">{status}</p>}
      {error && <p className="px-4 pt-3 text-sm text-amber-300" role="alert">{error}</p>}

      <ul className="divide-y divide-gray-800" aria-label="On this design">
        {members.map((m) => (
          <li key={m.userId} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 text-sm">
            <div className="min-w-0">
              <p className="truncate font-medium">{nameOf(m)}{m.userId === meId && <span className="ml-2 text-xs text-gray-500">You</span>}</p>
              {(!owner || m.role === 'owner') && <p className="text-xs text-gray-500">{roleLabel(m.role)}</p>}
            </div>
            {owner && m.role !== 'owner' && (
              <div className="flex flex-wrap items-center gap-2">
                <SelectField label={`${nameOf(m)}’s role`} value={m.role} className="w-40"
                  onChange={(role) => run(() => api.setStudioMemberRole(designId, m.userId, role as InviteRole))}>
                  {INVITE_ROLES.map((r) => <option key={r} value={r}>{roleLabel(r)}</option>)}
                </SelectField>
                <ConfirmAction prompt={`Remove ${nameOf(m)}?`} confirmLabel="Remove" disabled={busy} className={small}
                  onConfirm={() => run(() => api.removeStudioMember(designId, m.userId), `Removed ${nameOf(m)}.`)}>
                  Remove
                </ConfirmAction>
              </div>
            )}
          </li>
        ))}
      </ul>

      {owner && invites.length > 0 && (
        <div className="border-t border-gray-800">
          <h3 className="px-4 pt-3 text-xs font-medium uppercase tracking-wide text-gray-400">Pending invites</h3>
          <ul className="divide-y divide-gray-800">
            {invites.map((i) => (
              <PendingInvite key={i.id} invite={i} busy={busy}
                onResend={() => run(() => api.resendStudioInvite(designId, i.id), `Sent the invite to ${i.email} again.`)}
                onCancel={() => run(() => api.cancelStudioInvite(designId, i.id))} />
            ))}
          </ul>
        </div>
      )}

      {!owner && meId && (
        <div className="border-t border-gray-800 px-4 py-3">
          <ConfirmAction prompt="Leave this design? You keep the packages finalized while you were on it." confirmLabel="Leave" disabled={busy} className={small} onConfirm={leave}>
            Leave this design
          </ConfirmAction>
        </div>
      )}
    </section>
  )
}

function InviteForm({ busy, onInvite }: { busy: boolean; onInvite: (email: string, role: InviteRole) => Promise<boolean> }) {
  const [email, setEmail] = useState('')
  const [role, setRole] = useState<InviteRole>('collaborator')
  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    const to = email.trim()
    if (!to) return
    if (await onInvite(to, role)) setEmail('')
  }
  return (
    <form onSubmit={submit} className="flex flex-wrap items-end gap-2 border-b border-gray-800 px-4 py-3">
      <label className="min-w-0 flex-1 basis-56">
        <span className="mb-1 block text-xs text-gray-400">Invite by email</span>
        <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} maxLength={254} autoComplete="off" placeholder="name@example.com"
          className="w-full rounded-md border border-gray-800 bg-gray-950 px-3 py-2 text-sm text-white outline-none focus:border-blue-400" />
      </label>
      <SelectField label="Role" value={role} onChange={(r) => setRole(r as InviteRole)} className="w-40">
        {INVITE_ROLES.map((r) => <option key={r} value={r}>{roleLabel(r)}</option>)}
      </SelectField>
      <PrimaryButton type="submit" disabled={busy || !email.trim()}>Invite</PrimaryButton>
    </form>
  )
}

function PendingInvite({ invite, busy, onResend, onCancel }: { invite: StudioInvite; busy: boolean; onResend: () => void; onCancel: () => void }) {
  const [copied, setCopied] = useState(false)
  const [showLink, setShowLink] = useState(false)
  const copy = async () => {
    if (!invite.link) return
    try {
      await navigator.clipboard.writeText(invite.link)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      setShowLink(true)  // the clipboard is blocked: show the link to copy by hand
    }
  }
  return (
    <li className="space-y-2 px-4 py-3 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate font-medium">{invite.email}</p>
          <p className="text-xs text-gray-500">{roleLabel(invite.role)} · {inviteExpiry(invite.expiresAt, new Date())}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {invite.link && <button type="button" onClick={copy} className={small}>{copied ? 'Copied' : 'Copy link'}</button>}
          <button type="button" disabled={busy} onClick={onResend} className={small}>Resend</button>
          <button type="button" disabled={busy} onClick={onCancel} className={small}>Cancel</button>
        </div>
      </div>
      {showLink && invite.link && (
        <input readOnly value={invite.link} aria-label={`Invite link for ${invite.email}`} onFocus={(e) => e.currentTarget.select()}
          className="w-full rounded-md border border-gray-800 bg-gray-950 px-3 py-1.5 font-mono text-xs text-gray-300" />
      )}
    </li>
  )
}
