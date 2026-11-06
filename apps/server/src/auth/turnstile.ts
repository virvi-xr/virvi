import { config } from '../config.js'

const VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify'

let fetchImpl: typeof fetch | null = null
/** Tests inject a stub so Cloudflare is never called; pass null to restore the real fetch. */
export function setTurnstileFetch(f: typeof fetch | null) {
  fetchImpl = f
}

/** True when new trials can be started: TRIALS_ENABLED, and a secret is set or we are not in cloud mode (check skipped). */
export function trialsAvailable(): boolean {
  return config.trialsEnabled && (!!config.turnstileSecretKey || config.mode !== 'cloud')
}

/** Cloudflare Turnstile siteverify. With no secret (non-cloud modes) the check is skipped and passes. */
export async function verifyTurnstile(token: string | undefined, ip: string): Promise<boolean> {
  if (!config.turnstileSecretKey) return config.mode !== 'cloud'
  if (!token) return false
  try {
    const res = await (fetchImpl ?? fetch)(VERIFY_URL, {
      method: 'POST',
      body: new URLSearchParams({ secret: config.turnstileSecretKey, response: token, remoteip: ip }),
    })
    if (!res.ok) return false
    const data = (await res.json()) as { success?: boolean }
    return data.success === true
  } catch {
    return false
  }
}
