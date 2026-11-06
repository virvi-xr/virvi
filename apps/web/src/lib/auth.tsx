'use client'
import { createContext, useContext, useState, useEffect, useCallback, ReactNode } from 'react'
import { API_URL } from './config'
import { readSession, readTrialSession, type ScenePass } from './session'
import { deviceId, renewedTrialBearer, stashTrialHandover, trialBearerStale, trialEndedOutcome } from './trial'
import { AUTH_KEY, readStoredAuth } from './auth-storage'
import { refreshStoredSession } from './session-refresh'

interface User {
  id: string
  displayName: string
  email: string | null
  role: string
  /** A signed-out visitor's trial of the Design Studio. */
  trial?: boolean
  expiresAt?: string
}

interface AuthState {
  user: User | null
  token: string | null
  loading: boolean
  scenePass: ScenePass | null
  /** Sign in / create an account / sign in with a wallet. From a trial the trial bearer goes along, so the trial's designs move into the account; `fromAction` is the blocked action. Each returns the new access token. */
  login: (email: string, password: string, fromAction?: string) => Promise<string>
  register: (email: string, password: string, displayName: string, fromAction?: string) => Promise<string>
  loginWithWallet: (fromAction?: string) => Promise<string>
  /** Starts a trial session (a signed-out visitor trying the Design Studio). */
  startTrial: (turnstileToken: string) => Promise<void>
  /** The URL for Google or Discord sign-in; from a trial it keeps the trial in this tab for the callback page to move in. */
  oauthUrl: (provider: 'google' | 'discord', fromAction?: string) => Promise<string>
  logout: () => void
  /** Swaps the stored refresh token for a new access token: the new token, or null (signed out when refused). */
  renew: () => Promise<string | null>
  updateUser: (updates: Partial<User>) => void
  /** A trial ended (converted elsewhere): adopt the account session stored by another tab and return its token, or sign out and return null. */
  swapToStoredAccount: (staleToken: string) => string | null
}

const postRefresh = (refreshToken: string) =>
  fetch(`${API_URL}/api/auth/refresh`, { method: 'POST', headers: { Authorization: `Bearer ${refreshToken}` } })

const AuthContext = createContext<AuthState | null>(null)

export interface Eip1193Provider {
  request: (args: { method: string; params?: unknown[] }) => Promise<unknown>
}

/** The browser wallet (MetaMask, Rabby, Coinbase Wallet…) if one is injected. */
export function getBrowserWallet(): Eip1193Provider | null {
  if (typeof window === 'undefined') return null
  return ((window as unknown as { ethereum?: Eip1193Provider }).ethereum) ?? null
}

function toHex(text: string): string {
  return '0x' + Array.from(new TextEncoder().encode(text), (b) => b.toString(16).padStart(2, '0')).join('')
}

async function errorMessage(res: Response, fallback: string): Promise<string> {
  try {
    const code = (await res.json()).error
    if (code === 'trial_expired') return 'Your trial session ran out. Reload the page and try again.'
    return code || fallback
  } catch {
    return fallback
  }
}

/**
 * Sign-In with Ethereum, first half: the server issues a one-time message and the browser
 * wallet signs it (no transaction, no gas). POST the result to /api/auth/wallet/verify — without
 * a session to sign in, with one to link the wallet to the signed-in account.
 */
export async function signWalletChallenge(): Promise<{ address: string; nonce: string; signature: string }> {
  const wallet = getBrowserWallet()
  if (!wallet) throw new Error('No browser wallet found. Install MetaMask or another Ethereum wallet.')
  const accounts = (await wallet.request({ method: 'eth_requestAccounts' })) as string[]
  const address = accounts?.[0]
  if (!address) throw new Error('No wallet account selected')

  const challengeRes = await fetch(`${API_URL}/api/auth/wallet/challenge`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ address }),
  })
  if (!challengeRes.ok) throw new Error(await errorMessage(challengeRes, 'Could not start wallet sign-in'))
  const { nonce, message } = await challengeRes.json()

  const signature = (await wallet.request({ method: 'personal_sign', params: [toHex(message), address] })) as string
  return { address, nonce, signature }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null)
  const [token, setToken] = useState<string | null>(null)
  const [scenePass, setScenePass] = useState<ScenePass | null>(null)
  const [loading, setLoading] = useState(true)

  // Load from localStorage on mount
  useEffect(() => {
    const restore = async () => {
      const data = readStoredAuth(localStorage)
      if (!data) return
      let token = data.token
      // An access token that ran out is renewed with the stored refresh token before giving up on the session
      if (!readSession(token, Date.now()).ok && !readTrialSession(token, Date.now()) && data.refresh) {
        const r = await refreshStoredSession(localStorage, postRefresh)
        if ('token' in r) token = r.token
      }
      // Drop expired, kind-less (pre-scene-pass) and visitor sessions: the user signs in again once.
      const session = readSession(token, Date.now())
      const trial = !session.ok && readTrialSession(token, Date.now())
      if (trial) {
        setToken(token)
        setUser(readStoredAuth(localStorage)?.user as User)
      } else if (session.ok) {
        setToken(token)
        setUser(data.user as User)
        setScenePass(session.scenePass)
      } else {
        localStorage.removeItem(AUTH_KEY)
      }
    }
    restore().finally(() => setLoading(false))
  }, [])

  const adopt = (data: { accessToken: string; refreshToken?: string; user: User }) => {
    setToken(data.accessToken)
    setUser(data.user)
    setScenePass(null)
    localStorage.setItem(AUTH_KEY, JSON.stringify({ token: data.accessToken, refresh: data.refreshToken, user: data.user }))
    return data.accessToken
  }

  /**
   * A sign-up/sign-in POST. From a trial the trial bearer goes along so the trial moves into the account: a token that ran
   * out (or is about to) is renewed first, and a `401 trial_expired` renews and sends once more.
   */
  const post = async (path: string, body: object) => {
    const send = (bearer: string | null) =>
      fetch(`${API_URL}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}) },
        body: JSON.stringify(body),
      })
    let bearer = token && user?.trial ? token : null
    // A refused renewal means the trial is over (signed out): carry on as a plain sign-up. An unreachable server throws.
    const renewed = async () => renewedTrialBearer(await renew(), !!readStoredAuth(localStorage))
    if (bearer && trialBearerStale(bearer, Date.now())) bearer = await renewed()
    let res = await send(bearer)
    if (res.status === 401 && bearer && (await res.clone().json().catch(() => null))?.error === 'trial_expired') {
      const fresh = await renewed()
      if (fresh) res = await send(fresh)
    }
    return res
  }

  const login = async (email: string, password: string, fromAction?: string) => {
    const res = await post('/api/auth/login', { email, password, ...(fromAction ? { fromAction } : {}) })
    if (!res.ok) throw new Error(await errorMessage(res, 'Login failed'))
    return adopt(await res.json())
  }

  const register = async (email: string, password: string, displayName: string, fromAction?: string) => {
    const res = await post('/api/auth/register', { email, password, displayName, ...(fromAction ? { fromAction } : {}) })
    if (!res.ok) throw new Error(await errorMessage(res, 'Registration failed'))
    return adopt(await res.json())
  }

  const loginWithWallet = async (fromAction?: string) => {
    const proof = await signWalletChallenge()
    const res = await post('/api/auth/wallet/verify', { ...proof, ...(fromAction ? { fromAction } : {}) })
    if (!res.ok) throw new Error(await errorMessage(res, 'Wallet sign-in failed'))
    return adopt(await res.json())
  }

  const startTrial = async (turnstileToken: string) => {
    const res = await fetch(`${API_URL}/api/auth/trial`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ turnstileToken, deviceId: deviceId() }),
    })
    if (!res.ok) throw new Error(await errorMessage(res, 'Could not start a trial'))
    adopt(await res.json())
  }

  const oauthUrl = async (provider: 'google' | 'discord', fromAction?: string) => {
    // From a trial, this tab keeps the trial's token; the callback page moves it in when the sign-in brings `state` back
    let state: string | null = null
    try { state = stashTrialHandover(sessionStorage, user?.trial ? readStoredAuth(localStorage) : null, fromAction, Date.now()) } catch {}
    return `${API_URL}/api/auth/${provider}${state ? `?state=${state}` : ''}`
  }

  const logout = useCallback(() => {
    setToken(null)
    setUser(null)
    setScenePass(null)
    localStorage.removeItem(AUTH_KEY)
  }, [])

  const renew = useCallback(async () => {
    const r = await refreshStoredSession(localStorage, postRefresh)
    if ('token' in r) {
      setToken(r.token)
      // Another tab may have turned the trial into an account: follow the stored session's user
      const stored = readStoredAuth(localStorage)?.user as User | undefined
      if (stored) setUser(stored)
      return r.token
    }
    if ('refused' in r) logout()
    return null
  }, [logout])

  const swapToStoredAccount = useCallback((staleToken: string) => {
    const stored = readStoredAuth(localStorage)
    if (stored && trialEndedOutcome(stored, staleToken) === 'swap') {
      setToken(stored.token)
      setUser(stored.user as User)
      setScenePass(null)
      return stored.token
    }
    logout()
    return null
  }, [logout])

  const updateUser = useCallback((updates: Partial<User>) => {
    setUser(prev => {
      if (!prev) return prev
      const updated = { ...prev, ...updates }
      // Sync to localStorage
      const stored = localStorage.getItem(AUTH_KEY)
      if (stored) {
        try {
          const data = JSON.parse(stored)
          data.user = updated
          localStorage.setItem(AUTH_KEY, JSON.stringify(data))
        } catch {}
      }
      return updated
    })
  }, [])

  return (
    <AuthContext.Provider value={{ user, token, loading, scenePass, login, register, loginWithWallet, startTrial, oauthUrl, logout, renew, updateUser, swapToStoredAccount }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be inside AuthProvider')
  return ctx
}
