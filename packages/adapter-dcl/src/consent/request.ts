/**
 * How the visitor notice talks to the server (GDPR notice). A wallet's decision may only be read or recorded with a
 * signed request: the server refuses an unsigned one for a wallet-shaped id. So for a wallet the call is signed or not
 * made at all. If signing fails, it reports status 0 (no decision yet: the collector keeps buffering and the notice
 * shows), and it never falls back to an unsigned fetch as the wallet. A guest id goes through the analytics transport.
 */
import type { ConsentRequest } from '@virvixr/core'

export const isWalletShaped = (id: string) => /^0x[0-9a-f]{40}$/i.test(id)

type SignedOnly = (url: string, init: { method: string; body: string }) => Promise<{ status: number; body: string }>

const parse = (text: string): unknown => {
  try { return text ? JSON.parse(text) : undefined } catch { return undefined }
}

export function consentRequestFor(visitorId: string, signedOnly: SignedOnly, transport: ConsentRequest): ConsentRequest {
  if (!isWalletShaped(visitorId)) return transport
  return async (url, init) => {
    try {
      const res = await signedOnly(url, { method: init.method, body: init.body ?? '' })
      return { status: res.status, body: parse(res.body) }
    } catch {
      return { status: 0 }
    }
  }
}
