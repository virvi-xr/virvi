'use client'
import { useSearchParams } from 'next/navigation'
import { useState, Suspense } from 'react'

function ResetPasswordForm() {
  const searchParams = useSearchParams()
  const token = searchParams.get('token')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState(false)
  const [loading, setLoading] = useState(false)

  if (!token) {
    return (
      <main className="flex min-h-screen items-center justify-center">
        <div className="w-full max-w-md rounded-xl bg-gray-900 p-8 text-center">
          <h1 className="mb-4 text-xl font-semibold text-white">Reset your password</h1>
          <p className="mb-4 text-red-400">Invalid or missing reset token.</p>
          <a href="/signin/" className="text-blue-400 underline underline-offset-2 hover:text-blue-300">Back to login</a>
        </div>
      </main>
    )
  }

  if (success) {
    return (
      <main className="flex min-h-screen items-center justify-center">
        <div className="w-full max-w-md rounded-xl bg-gray-900 p-8 text-center">
          <h1 className="mb-4 text-xl font-semibold text-white">Password reset successful</h1>
          <p className="mb-6 text-gray-400">Your password has been updated. You can now log in with your new password.</p>
          <a
            href="/signin/"
            className="inline-block rounded-lg bg-blue-600 px-6 py-2 text-white hover:bg-blue-700"
          >
            Go to login
          </a>
        </div>
      </main>
    )
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)

    if (password.length < 8) {
      setError('Password must be at least 8 characters.')
      return
    }

    if (password !== confirmPassword) {
      setError('Passwords do not match.')
      return
    }

    setLoading(true)
    try {
      const res = await fetch('/api/auth/reset-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, newPassword: password }),
      })

      if (!res.ok) {
        const data = await res.json()
        setError(data.error || 'Failed to reset password.')
        return
      }

      setSuccess(true)
    } catch {
      setError('Network error. Please try again.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center">
      <div className="w-full max-w-md rounded-xl bg-gray-900 p-8">
        <h1 className="mb-6 text-center text-xl font-semibold text-white">Reset your password</h1>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label htmlFor="password" className="mb-1 block text-sm text-gray-400">
              New password
            </label>
            <input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              minLength={8}
              className="w-full rounded-lg border border-gray-700 bg-gray-800 px-4 py-2 text-white focus:border-blue-500 focus:outline-none"
            />
          </div>
          <div>
            <label htmlFor="confirmPassword" className="mb-1 block text-sm text-gray-400">
              Confirm password
            </label>
            <input
              id="confirmPassword"
              type="password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              required
              minLength={8}
              className="w-full rounded-lg border border-gray-700 bg-gray-800 px-4 py-2 text-white focus:border-blue-500 focus:outline-none"
            />
          </div>
          {error && <p className="text-sm text-red-400">{error}</p>}
          <button
            type="submit"
            disabled={loading}
            className="w-full rounded-lg bg-blue-600 px-4 py-2 font-medium text-white hover:bg-blue-700 disabled:opacity-50"
          >
            {loading ? 'Resetting...' : 'Reset Password'}
          </button>
        </form>
      </div>
    </main>
  )
}

export default function ResetPasswordPage() {
  return (
    <Suspense
      fallback={
        <main className="flex min-h-screen items-center justify-center">
          <p className="text-gray-400">Loading...</p>
        </main>
      }
    >
      <ResetPasswordForm />
    </Suspense>
  )
}
