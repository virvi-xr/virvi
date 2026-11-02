import { randomBytes } from 'node:crypto'

export class FlyError extends Error {
  status: number
  body: string
  constructor(message: string, status: number, body: string) {
    super(message)
    this.name = 'FlyError'
    this.status = status
    this.body = body
  }
}

/** `autostart` defaults to true; it is turned off for ended worlds so a visit can't wake them. */
export type WorldMachineSpec = { image: string; env: Record<string, string>; autostart?: boolean }

/** Name prefix of runJob machines, so the sweep can recognise and reap ones left behind. */
export const JOB_MACHINE_PREFIX = 'db-job-'

/** A one-shot machine: runs `cmd` in `image` and stops. */
export type JobSpec = { image: string; env: Record<string, string>; cmd: string[] }

/** A Design Studio worker: one per design, no services (it only calls out), never restarted by Fly. */
export type WorkerMachineSpec = { name: string; image: string; env: Record<string, string> }

/** A scene import's build box (apps/scene-builder): no services (it only calls out), never restarted, gone once it exits. */
export type BuildMachineSpec = { name: string; image: string; env: Record<string, string>; cpus: number; memoryMb: number }

type FlyOpts = { token: string; org: string; fetch?: typeof fetch; baseUrl?: string; timeoutMs?: number }

const REGION = 'iad'
const REQUEST_TIMEOUT_MS = 30_000
/** Fly's machine wait endpoint accepts at most 60 s per call. */
const MAX_WAIT_S = 60

function jobBody(j: JobSpec) {
  return {
    name: `${JOB_MACHINE_PREFIX}${randomBytes(6).toString('hex')}`,
    region: REGION,
    config: {
      image: j.image,
      env: j.env,
      init: { cmd: j.cmd },
      guest: { cpu_kind: 'shared', cpus: 1, memory_mb: 256 },
      restart: { policy: 'no' },
      auto_destroy: false,
    },
  }
}

/** The exit code from the newest `exit` event; machine events are loosely shaped, so anything odd is undefined. */
function exitCodeOf(events: unknown): number | undefined {
  if (!Array.isArray(events)) return undefined
  let best: { code: number; ts: number } | undefined
  for (const [i, e] of events.entries()) {
    if (!e || typeof e !== 'object' || (e as { type?: unknown }).type !== 'exit') continue
    const code = (e as { request?: { exit_event?: { exit_code?: unknown } } }).request?.exit_event?.exit_code
    if (typeof code !== 'number' || !Number.isInteger(code)) continue
    const raw = (e as { timestamp?: unknown }).timestamp
    // Fly lists events newest first; without timestamps, the earlier entry wins.
    const ts = typeof raw === 'number' ? raw : -i
    if (!best || ts > best.ts) best = { code, ts }
  }
  return best?.code
}

function machineBody(m: WorldMachineSpec) {
  return {
    region: REGION,
    config: {
      image: m.image,
      env: m.env,
      guest: { cpu_kind: 'shared', cpus: 1, memory_mb: 1024 },
      services: [{
        protocol: 'tcp',
        internal_port: 3000,
        autostop: 'stop',
        autostart: m.autostart ?? true,
        min_machines_running: 0,
        ports: [{ port: 80, handlers: ['http'] }, { port: 443, handlers: ['tls', 'http'] }],
      }],
    },
  }
}

function workerBody(m: WorkerMachineSpec) {
  return {
    name: m.name,
    region: REGION,
    config: {
      image: m.image,
      env: m.env,
      guest: { cpu_kind: 'performance', cpus: 4, memory_mb: 8192 },
      restart: { policy: 'no' },
      auto_destroy: false,
    },
  }
}

function buildBody(m: BuildMachineSpec) {
  return {
    name: m.name,
    region: REGION,
    config: {
      image: m.image,
      env: m.env,
      guest: { cpu_kind: 'performance', cpus: m.cpus, memory_mb: m.memoryMb },
      restart: { policy: 'no' },
      auto_destroy: true,
    },
  }
}

export class FlyApi {
  private token: string
  private org: string
  private fetchFn: typeof fetch
  private baseUrl: string
  private timeoutMs: number

  constructor(opts: FlyOpts) {
    this.token = opts.token
    this.org = opts.org
    this.fetchFn = opts.fetch ?? fetch
    this.baseUrl = (opts.baseUrl ?? 'https://api.machines.dev/v1').replace(/\/+$/, '')
    this.timeoutMs = opts.timeoutMs ?? REQUEST_TIMEOUT_MS
  }

  private scrub(s: string): string {
    return this.token ? s.split(this.token).join('[redacted]') : s
  }

  private async request(
    method: string,
    path: string,
    body?: unknown,
    okStatuses: number[] = [],
    timeoutMs = this.timeoutMs,
  ): Promise<{ status: number; text: string }> {
    let res: Response
    try {
      res = await this.fetchFn(`${this.baseUrl}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.token}`,
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch (e) {
      if ((e as Error)?.name === 'TimeoutError') {
        throw new FlyError(`Fly ${method} ${path} timed out after ${timeoutMs / 1000} s`, 0, '')
      }
      const msg = this.scrub(e instanceof Error ? e.message : String(e))
      throw new FlyError(`Fly ${method} ${path} failed: ${msg}`, 0, '')
    }
    const text = this.scrub(await res.text().catch(() => ''))
    if (res.ok || okStatuses.includes(res.status)) return { status: res.status, text }
    let detail = text.slice(0, 500)
    try {
      const j = JSON.parse(text)
      if (typeof j?.error === 'string') detail = j.error
    } catch { /* non-JSON body */ }
    throw new FlyError(`Fly ${method} ${path} returned ${res.status}: ${detail}`, res.status, text)
  }

  private async json<T>(method: string, path: string, body?: unknown): Promise<T> {
    const { status, text } = await this.request(method, path, body)
    try {
      return JSON.parse(text) as T
    } catch {
      throw new FlyError(`Fly ${method} ${path} returned ${status} with a body that is not JSON`, status, text.slice(0, 500))
    }
  }

  async createApp(name: string): Promise<void> {
    await this.request('POST', '/apps', { app_name: name, org_slug: this.org })
  }

  async deleteApp(name: string): Promise<void> {
    await this.request('DELETE', `/apps/${encodeURIComponent(name)}`, undefined, [404])
  }

  async allocatePublicIps(app: string): Promise<void> {
    for (const type of ['shared_v4', 'v6']) {
      await this.request('POST', `/apps/${encodeURIComponent(app)}/ip_assignments`, { type })
    }
  }

  /** One private IPv6 (Flycast) address, which the worlds router proxies large requests to. */
  async allocatePrivateIp(app: string): Promise<void> {
    await this.request('POST', `/apps/${encodeURIComponent(app)}/ip_assignments`, { type: 'private_v6' })
  }

  async createMachine(app: string, m: WorldMachineSpec): Promise<{ id: string }> {
    const r = await this.json<{ id: string }>('POST', `/apps/${encodeURIComponent(app)}/machines`, machineBody(m))
    return { id: r.id }
  }

  async createWorkerMachine(app: string, m: WorkerMachineSpec): Promise<{ id: string }> {
    const r = await this.json<{ id: string }>('POST', `/apps/${encodeURIComponent(app)}/machines`, workerBody(m))
    return { id: r.id }
  }

  async createBuildMachine(app: string, m: BuildMachineSpec): Promise<{ id: string }> {
    const r = await this.json<{ id: string }>('POST', `/apps/${encodeURIComponent(app)}/machines`, buildBody(m))
    return { id: r.id }
  }

  /** The machine's state (started, stopped, ...), or null when it no longer exists. */
  async getMachineState(app: string, id: string): Promise<string | null> {
    const { status, text } = await this.request('GET', `/apps/${encodeURIComponent(app)}/machines/${encodeURIComponent(id)}`, undefined, [404])
    if (status === 404) return null
    try {
      const state = (JSON.parse(text) as { state?: unknown }).state
      if (typeof state === 'string') return state
    } catch { /* fall through */ }
    throw new FlyError(`Fly GET machine ${id} returned ${status} without a state`, status, text.slice(0, 500))
  }

  /** The machine's state and the image it runs, or null when it no longer exists. */
  async getMachine(app: string, id: string): Promise<{ state: string; image: string | null } | null> {
    const { status, text } = await this.request('GET', `/apps/${encodeURIComponent(app)}/machines/${encodeURIComponent(id)}`, undefined, [404])
    if (status === 404) return null
    try {
      const m = JSON.parse(text) as { state?: unknown; config?: { image?: unknown } }
      if (typeof m.state === 'string') return { state: m.state, image: typeof m.config?.image === 'string' ? m.config.image : null }
    } catch { /* fall through */ }
    throw new FlyError(`Fly GET machine ${id} returned ${status} without a state`, status, text.slice(0, 500))
  }

  async updateMachine(app: string, id: string, m: WorldMachineSpec): Promise<void> {
    await this.request('POST', `/apps/${encodeURIComponent(app)}/machines/${encodeURIComponent(id)}`, machineBody(m))
  }

  async listMachines(app: string): Promise<{ id: string; state: string; name?: string; createdAt?: string }[]> {
    const r = await this.json<{ id: string; state: string; name?: string; created_at?: string }[]>('GET', `/apps/${encodeURIComponent(app)}/machines`)
    return r.map((x) => ({ id: x.id, state: x.state, name: x.name, createdAt: x.created_at }))
  }

  /** Force-deletes a machine (stopping it if needed); one already gone counts as done. */
  async deleteMachine(app: string, id: string): Promise<void> {
    await this.request('DELETE', `/apps/${encodeURIComponent(app)}/machines/${encodeURIComponent(id)}?force=true`, undefined, [404])
  }

  async getMachineEnv(app: string, id: string): Promise<Record<string, string>> {
    const r = await this.json<{ config?: { env?: Record<string, string> } }>('GET', `/apps/${encodeURIComponent(app)}/machines/${encodeURIComponent(id)}`)
    return r.config?.env ?? {}
  }

  async stopMachine(app: string, id: string): Promise<void> {
    await this.request('POST', `/apps/${encodeURIComponent(app)}/machines/${encodeURIComponent(id)}/stop`)
  }

  async startMachine(app: string, id: string): Promise<void> {
    await this.request('POST', `/apps/${encodeURIComponent(app)}/machines/${encodeURIComponent(id)}/start`)
  }

  /**
   * Runs a one-shot machine (no services, never restarted) and returns its exit code once it stops. The machine is
   * deleted afterwards whatever happened; a failed delete doesn't change the result, and the sweep reaps the machine.
   */
  async runJob(app: string, spec: JobSpec, timeoutMs = 120_000): Promise<{ exitCode: number }> {
    const base = `/apps/${encodeURIComponent(app)}/machines`
    const { id } = await this.json<{ id: string }>('POST', base, jobBody(spec))
    const machine = `${base}/${encodeURIComponent(id)}`
    try {
      const deadline = Date.now() + timeoutMs
      for (;;) {
        const left = deadline - Date.now()
        if (left <= 0) throw new FlyError(`Fly job machine ${id} in ${app} did not finish within ${timeoutMs / 1000} s`, 0, '')
        const secs = Math.min(MAX_WAIT_S, Math.ceil(left / 1000))
        // Fly answers 408 when the wait times out with the machine still running.
        const r = await this.request('GET', `${machine}/wait?state=stopped&timeout=${secs}`, undefined, [408], secs * 1000 + this.timeoutMs)
        if (r.status !== 408) break
      }
      const m = await this.json<{ events?: unknown }>('GET', machine)
      const exitCode = exitCodeOf(m.events)
      if (exitCode === undefined) throw new FlyError(`Fly job machine ${id} in ${app} stopped without an exit code`, 0, '')
      return { exitCode }
    } finally {
      await this.deleteMachine(app, id).catch(() => {})
    }
  }
}
