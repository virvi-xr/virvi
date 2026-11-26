import type { IngestBatch, VirviPlatformAdapter } from '@virvixr/shared'

export interface TransportResult {
  status: number
  body?: unknown
}

export interface AnalyticsTransport {
  send(url: string, batch: IngestBatch): Promise<TransportResult>
  /** Any other analytics call (the visitor notice's GET and POST), signed the same way as `send`. */
  request?(url: string, init: { method: 'GET' | 'POST'; body?: string }): Promise<TransportResult>
}

/** Minimal fetch shape; @virvixr/core compiles without the DOM lib. */
export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string },
) => Promise<{ status: number; text(): Promise<string> }>

function parse(text: string): unknown {
  try {
    return text ? JSON.parse(text) : undefined
  } catch {
    return undefined
  }
}

/** Signed fetch when the adapter has it (DCL), plain fetch otherwise. Network failures report status 0. */
export function createTransport(
  adapter: { signedRequest?: VirviPlatformAdapter['signedRequest'] },
  fetchImpl: FetchLike | undefined = (globalThis as { fetch?: FetchLike }).fetch,
): AnalyticsTransport {
  const call = async (url: string, method: 'GET' | 'POST', body?: string): Promise<TransportResult> => {
    try {
      if (adapter.signedRequest) {
        // A GET has no body (the adapter sends none for an empty one)
        const res = await adapter.signedRequest(url, { method, body: body ?? '' })
        return { status: res.status, body: parse(res.body) }
      }
      if (!fetchImpl) return { status: 0 }
      const res = await fetchImpl(url, { method, headers: body === undefined ? {} : { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body }) })
      return { status: res.status, body: parse(await res.text()) }
    } catch {
      return { status: 0 }
    }
  }
  return {
    send: (url, batch) => call(url, 'POST', JSON.stringify(batch)),
    request: (url, init) => call(url, init.method, init.body),
  }
}
