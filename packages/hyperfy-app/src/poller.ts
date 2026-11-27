import { HYPERFY_APP_VERSION, HYPERFY_FEED, type HyperfyFeedResponse } from '@virvixr/shared'

/** Hyperfy's script fetch: resolves undefined (instead of rejecting) when the request fails. */
export type ScriptFetch = (
  url: string,
  init: object,
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> } | undefined>

export type ScriptSetTimeout = (fn: () => void, ms: number) => unknown

export interface FeedPollerOptions {
  feedUrl: string
  worldKey: string
  fetch: ScriptFetch
  setTimeout: ScriptSetTimeout
  onSnapshot: (r: HyperfyFeedResponse) => void
}

const isSnapshot = (v: unknown): v is HyperfyFeedResponse => {
  const o = v as Partial<HyperfyFeedResponse> | null
  return !!o && typeof o === 'object' && o.v === 1 && typeof o.version === 'string' && 'scene' in o
}

/**
 * Long-polls the Virvi scene feed. Each answer is a whole snapshot; onSnapshot fires only when its version
 * changes. Failures back off (doubling, retryMinMs to retryMaxMs) and keep the last snapshot, except a 404
 * (the scene is gone), which clears the world once.
 */
export class FeedPoller {
  private version = ''
  private delay = 0
  private running = false

  constructor(private readonly opts: FeedPollerOptions) {}

  start(): void {
    if (this.running) return
    this.running = true
    void this.poll()
  }

  stop(): void {
    this.running = false
  }

  private async poll(): Promise<void> {
    if (!this.running) return
    const { feedUrl, worldKey, fetch } = this.opts
    let res: Awaited<ReturnType<ScriptFetch>>
    let body: unknown
    try {
      res = await fetch(`${feedUrl}/api/hyperfy/feed?since=${encodeURIComponent(this.version)}`, {
        headers: {
          Authorization: `Bearer ${worldKey}`,
          'X-Virvi-App-Version': String(HYPERFY_FEED.version),
          // The app's release, so the dashboard can tell an older .hyp to download again (LIV-33)
          // (HUD_VERSION_HEADER, spelled out: the bundle's slice of @virvixr/shared leaves hud-protocol out)
          'x-virvi-hud-version': HYPERFY_APP_VERSION,
        },
      })
      if (res?.ok) body = await res.json()
    } catch {
      res = undefined
    }
    if (!this.running) return
    if (res?.ok && isSnapshot(body)) {
      this.delay = 0
      this.take(body)
    } else {
      if (res?.status === 404) this.take({ v: 1, version: '', scene: null })
      this.delay = Math.min(Math.max(this.delay * 2, HYPERFY_FEED.retryMinMs), HYPERFY_FEED.retryMaxMs)
    }
    this.opts.setTimeout(() => void this.poll(), this.delay)
  }

  private take(r: HyperfyFeedResponse): void {
    if (r.version === this.version) return
    this.version = r.version
    this.opts.onSnapshot(r)
  }
}
