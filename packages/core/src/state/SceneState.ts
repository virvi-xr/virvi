/**
 * Scene state (LIV-158): the scene's small shared key-value store, kept by the server. Every copy of the scene gets it
 * on join and hears each change. Who may write is the scene's setting: editors only (default), or every visitor.
 *
 *   virvi.state.get('round')             // the current value, or undefined
 *   await virvi.state.set('round', 2)    // resolves once the server has saved it; rejects with the reason
 *   virvi.state.on('round', (v) => …)    // a key's changes ('*' for every key); returns an unsubscribe
 */
export type StateListener = (value: unknown, key: string, deleted: boolean) => void

interface Hooks {
  send(type: string, message: unknown): boolean
  registerSystem(fn: (dt: number) => void): void
  unregisterSystem(fn: (dt: number) => void): void
  now?: () => number
}

export class SceneStateError extends Error {
  constructor(public code: string, message?: string) {
    super(message || code)
    this.name = 'SceneStateError'
  }
}

export class SceneState {
  static TIMEOUT_MS = 5000
  private values = new Map<string, unknown>()
  private listeners = new Map<string, Set<StateListener>>()
  private pending = new Map<string, { resolve: () => void; reject: (e: Error) => void; deadline: number }>()
  private timeoutSystem: ((dt: number) => void) | null = null
  private nextRef = 1
  private _ready = false

  constructor(private hooks: Hooks) {}

  /** True once the scene's state has arrived from the server. */
  get ready(): boolean { return this._ready }

  get(key: string): unknown {
    return this.values.get(key)
  }

  has(key: string): boolean {
    return this.values.has(key)
  }

  /** Every key and value, as a plain object. */
  all(): Record<string, unknown> {
    return Object.fromEntries(this.values)
  }

  /** Listen to one key's changes, or every key's with '*'. Fires when the state first arrives too. */
  on(key: string, listener: StateListener): () => void {
    if (!this.listeners.has(key)) this.listeners.set(key, new Set())
    this.listeners.get(key)!.add(listener)
    return () => { this.listeners.get(key)?.delete(listener) }
  }

  set(key: string, value: unknown): Promise<void> {
    return this.request('scene_state_set', { key, value })
  }

  delete(key: string): Promise<void> {
    return this.request('scene_state_delete', { key })
  }

  // ── From the room ──
  handleInit(message: unknown): void {
    const state = (message as { state?: Record<string, unknown> } | null)?.state ?? {}
    const before = new Map(this.values)
    this.values = new Map(Object.entries(state))
    this._ready = true
    for (const [k, v] of this.values) if (!before.has(k) || JSON.stringify(before.get(k)) !== JSON.stringify(v)) this.emit(k, v, false)
    for (const k of before.keys()) if (!this.values.has(k)) this.emit(k, undefined, true)
  }

  handleChange(message: unknown): void {
    const m = message as { key?: unknown; value?: unknown; deleted?: unknown } | null
    if (!m || typeof m.key !== 'string') return
    if (m.deleted) {
      if (!this.values.has(m.key)) return
      this.values.delete(m.key)
      this.emit(m.key, undefined, true)
      return
    }
    this.values.set(m.key, m.value)
    this.emit(m.key, m.value, false)
  }

  handleAck(message: unknown): void {
    const m = message as { ref?: unknown; ok?: unknown; error?: string; message?: string } | null
    if (!m || typeof m.ref !== 'string') return
    const entry = this.pending.get(m.ref)
    if (!entry) return
    if (m.ok) entry.resolve()
    else entry.reject(new SceneStateError(m.error || 'state_refused', m.message))
  }

  /** The room went away: what's waiting can't be answered. */
  failAll(code: string): void {
    for (const entry of [...this.pending.values()]) entry.reject(new SceneStateError(code))
  }

  private emit(key: string, value: unknown, deleted: boolean): void {
    for (const k of [key, '*']) {
      for (const l of [...(this.listeners.get(k) ?? [])]) {
        try { l(value, key, deleted) } catch { /* scene code */ }
      }
    }
  }

  private request(type: string, body: { key: string; value?: unknown }): Promise<void> {
    return new Promise((resolve, reject) => {
      const ref = `s${this.nextRef++}`
      const now = this.hooks.now ?? Date.now
      const done = () => {
        this.pending.delete(ref)
        if (this.pending.size === 0 && this.timeoutSystem) {
          this.hooks.unregisterSystem(this.timeoutSystem)
          this.timeoutSystem = null
        }
      }
      this.pending.set(ref, {
        resolve: () => { done(); resolve() },
        reject: (e) => { done(); reject(e) },
        deadline: now() + SceneState.TIMEOUT_MS,
      })
      if (!this.hooks.send(type, { ref, ...body })) {
        this.pending.get(ref)!.reject(new SceneStateError('not_connected', 'Not connected to the scene'))
        return
      }
      if (!this.timeoutSystem) {
        this.timeoutSystem = () => {
          const t = now()
          for (const entry of [...this.pending.values()]) if (t >= entry.deadline) entry.reject(new SceneStateError('state_timeout', 'The server did not answer'))
        }
        this.hooks.registerSystem(this.timeoutSystem)
      }
    })
  }
}
