'use client'
import { useEffect, useState } from 'react'
import { useParams } from 'next/navigation'
import Link from 'next/link'
import { useApi } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { openSignUp } from '@/lib/trial'
import { PageHeader, PrimaryButton, Skeleton } from '@/components/ui'
import { acceptRefusal, inviteStatusCopy, inviteTokenFromPath, peopleRefusal, roleLabel, type InviteLinkView } from '@/lib/studio-people'

const BROKEN = 'This invite link doesn’t work. Check it, or ask the owner for a new one.'

/**
 * An invite's link (LIV-159), from the email or copied by the owner. Signed out, the dashboard sends the visitor to
 * sign up (or in) and back here; a trial is asked to create an account first (trials can't join designs); signed in,
 * it shows the design, who invited them and the role, with Accept.
 */
export default function InvitePage() {
  const params = useParams()
  const { user } = useAuth()
  const api = useApi()
  const [token, setToken] = useState<string | null | undefined>(undefined)
  const [view, setView] = useState<InviteLinkView | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [refused, setRefused] = useState<{ text: string; openDesign: boolean } | null>(null)
  const [busy, setBusy] = useState(false)
  const trial = !!user?.trial

  useEffect(() => {
    setToken(inviteTokenFromPath(window.location.pathname, params.token as string | undefined))
  }, [params.token])

  useEffect(() => {
    if (token === undefined || !user || trial) return
    if (token === null) { setProblem(BROKEN); return }
    let cancelled = false
    setProblem(null)
    api.getStudioInviteLink(token)
      .then((v) => { if (!cancelled) setView(v) })
      .catch((err) => { if (!cancelled) setProblem((err as { status?: number }).status === 404 ? BROKEN : peopleRefusal(err as never)) })
    return () => { cancelled = true }
    // useApi() returns new functions every render; read again only when the token or the account changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, user?.id, trial])

  const accept = async () => {
    if (!token) return
    setBusy(true)
    setRefused(null)
    try {
      const r = await api.acceptStudioInviteLink(token)
      window.location.assign(`/studio/${r.designId}/`)
    } catch (err) {
      setRefused(acceptRefusal(err as never))
      setBusy(false)
    }
  }

  const closed = view ? inviteStatusCopy(view.status) : null
  return (
    <div className="mx-auto max-w-xl">
      <PageHeader crumbs={[{ label: 'Design Studio', href: '/studio' }, 'Invite']} title={view && !closed ? view.designName : 'Invite to a design'} />
      {trial ? (
        <div className="space-y-3 rounded-lg border border-gray-800 bg-gray-900 p-4 text-sm">
          <p className="text-gray-200">Create a free account to join this design. Your trial designs and scenes come with you.</p>
          <PrimaryButton type="button" onClick={() => { openSignUp({ action: 'studio_invite', ctx: {} }).catch(() => {}) }}>Create account</PrimaryButton>
        </div>
      ) : problem && !view ? (
        <Plain text={problem} />
      ) : !view ? (
        <Skeleton rows={1} />
      ) : closed ? (
        <Plain text={closed} />
      ) : (
        <div className="space-y-4 rounded-lg border border-gray-800 bg-gray-900 p-4 text-sm">
          <p className="text-gray-200">
            {view.inviterName?.trim() ? `${view.inviterName.trim()} invited you` : 'You’re invited'} to <span className="font-medium text-white">{view.designName}</span> as a {roleLabel(view.role).toLowerCase()}.
          </p>
          <p className="text-gray-400">
            {view.role === 'viewer'
              ? 'You can see the design as it changes and download what’s finalized.'
              : 'You can send prompts with your own allowance, finalize pieces and download them.'}
          </p>
          {refused && (
            <p className="text-amber-300" role="alert">
              {refused.text}{' '}
              {refused.openDesign && <a href={`/studio/${view.designId}/`} className="text-blue-300 underline">Open the design</a>}
            </p>
          )}
          <PrimaryButton type="button" disabled={busy} onClick={accept}>{busy ? 'Joining…' : 'Accept'}</PrimaryButton>
        </div>
      )}
    </div>
  )
}

function Plain({ text }: { text: string }) {
  return (
    <p className="text-sm text-gray-400">
      {text} <Link href="/studio" className="text-blue-300 underline">Go to the Design Studio</Link>
    </p>
  )
}
