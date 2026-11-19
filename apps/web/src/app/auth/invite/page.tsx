'use client'
import { useSearchParams } from 'next/navigation'
import { useEffect, useState, Suspense } from 'react'

function InviteHandler() {
  const searchParams = useSearchParams()
  const token = searchParams.get('token')
  const [status, setStatus] = useState<'loading' | 'accepted' | 'login-required' | 'error'>('loading')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!token) {
      setStatus('error')
      setError('Invalid or missing invite token.')
      return
    }

    // Store the invite token so it can be accepted after login/register
    localStorage.setItem('virvi_pending_invite', token)

    // Check if user is logged in
    const authRaw = localStorage.getItem('virvi_auth')
    if (!authRaw) {
      setStatus('login-required')
      return
    }

    let auth: { token?: string }
    try {
      auth = JSON.parse(authRaw)
    } catch {
      setStatus('login-required')
      return
    }

    if (!auth.token) {
      setStatus('login-required')
      return
    }

    // User is logged in, auto-accept the invite
    fetch('/api/orgs/accept-invite', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${auth.token}`,
      },
      body: JSON.stringify({ token }),
    })
      .then(async (res) => {
        if (res.ok) {
          localStorage.removeItem('virvi_pending_invite')
          setStatus('accepted')
        } else {
          const data = await res.json()
          setError(data.error || 'Failed to accept invite.')
          setStatus('error')
        }
      })
      .catch(() => {
        setError('Network error. Please try again.')
        setStatus('error')
      })
  }, [token])

  if (status === 'loading') {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <p className="text-gray-400">Accepting invite...</p>
      </div>
    )
  }

  if (status === 'accepted') {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="w-full max-w-md rounded-xl bg-gray-900 p-8 text-center">
          <h2 className="mb-4 text-xl font-semibold text-white">Invite accepted</h2>
          <p className="mb-6 text-gray-400">You have been added to the organization.</p>
          <a
            href="/scenes"
            className="inline-block rounded-lg bg-blue-600 px-6 py-2 text-white hover:bg-blue-700"
          >
            Go to dashboard
          </a>
        </div>
      </div>
    )
  }

  if (status === 'login-required') {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="w-full max-w-md rounded-xl bg-gray-900 p-8 text-center">
          <h2 className="mb-4 text-xl font-semibold text-white">You have been invited</h2>
          <p className="mb-6 text-gray-400">
            Log in or create an account to accept this invite. The invite will be applied automatically after you sign in.
          </p>
          <a
            href="/signin/"
            className="inline-block rounded-lg bg-blue-600 px-6 py-2 text-white hover:bg-blue-700"
          >
            Go to login
          </a>
        </div>
      </div>
    )
  }

  return (
    <div className="flex min-h-screen items-center justify-center">
      <div className="w-full max-w-md rounded-xl bg-gray-900 p-8 text-center">
        <p className="mb-4 text-red-400">{error || 'Something went wrong.'}</p>
        <a href="/signin/" className="text-blue-400 underline underline-offset-2 hover:text-blue-300">Back to login</a>
      </div>
    </div>
  )
}

export default function InvitePage() {
  return (
    <Suspense
      fallback={
        <div className="flex min-h-screen items-center justify-center">
          <p className="text-gray-400">Loading...</p>
        </div>
      }
    >
      <InviteHandler />
    </Suspense>
  )
}
