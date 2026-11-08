import { config } from '../config.js'

/**
 * An issue's workflow state type (triage, backlog, unstarted, started, completed, canceled) and when it was completed
 * or canceled (a Duplicate is canceled too).
 */
export interface LinearIssueState { id: string; stateType: string; completedAt: string | null; canceledAt?: string | null }

/**
 * A failed Linear call. `transient` ("stop and back off"): a rate limit, a 5xx, the network, or the key being refused
 * (401, 403, AUTHENTICATION_ERROR: nothing can succeed until it is fixed); the jobs then back off (linearPaused).
 */
export class LinearError extends Error {
  constructor(message: string, public status: number | null, public transient: boolean) { super(message) }
}

/** Whether an error from a Linear call means "try later": a transient LinearError, or the network / a timeout. */
export function isTransientLinearError(err: unknown): boolean {
  if (err instanceof LinearError) return err.transient || err.status === 401 || err.status === 403
  const name = (err as { name?: string } | null)?.name
  return name === 'TypeError' || name === 'AbortError' || name === 'TimeoutError'
}

// Backoff after a transient failure: 5 minutes, doubling to an hour, per instance. A good pass clears it.
const BACKOFF_MS = 5 * 60_000
const MAX_BACKOFF_MS = 60 * 60_000
let pausedUntil = 0
let level = 0
export const linearPaused = (now = Date.now()) => now < pausedUntil
export function noteLinearTransient(now = Date.now()): void {
  pausedUntil = now + Math.min(MAX_BACKOFF_MS, BACKOFF_MS * 2 ** level)
  level = Math.min(level + 1, 6)
}
export function noteLinearOk(): void { level = 0; pausedUntil = 0 }
export const resetLinearBackoff = noteLinearOk

/** What error filing needs from Linear (LIV-66). Tests set a fake with setLinearClient; nothing in tests calls Linear. */
export interface LinearClient {
  createIssue(input: { title: string; description: string }): Promise<{ id: string; identifier: string; url: string }>
  createComment(issueId: string, body: string): Promise<void>
  /** The states of these issues (at most 50 a call); issues Linear no longer has are left out. */
  issueStates(ids: string[]): Promise<LinearIssueState[]>
}

const ENDPOINT = 'https://api.linear.app/graphql'

export function httpLinearClient(opts: {
  apiKey: string; teamId: string; stateId?: string | null; labelIds?: string[]; templateId?: string | null; fetch?: typeof fetch
}): LinearClient {
  const doFetch = opts.fetch ?? fetch
  async function gql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    let res: Response
    try {
      res = await doFetch(ENDPOINT, {
        method: 'POST',
        // A personal API key goes as it is; an OAuth token would be "Bearer …"
        headers: { 'content-type': 'application/json', authorization: opts.apiKey },
        body: JSON.stringify({ query, variables }),
        signal: AbortSignal.timeout(15_000),
      })
    } catch (err) {
      throw new LinearError(`Linear unreachable: ${err instanceof Error ? err.message : err}`, null, true)
    }
    const body = await res.json().catch(() => ({})) as { data?: T; errors?: Array<{ message?: string; extensions?: { code?: string } }> }
    if (!res.ok || body.errors?.length || !body.data) {
      const codes = (body.errors ?? []).map((e) => e.extensions?.code)
      const limited = res.status === 429 || res.status >= 500 || res.status === 401 || res.status === 403
        || codes.includes('RATELIMITED') || codes.includes('AUTHENTICATION_ERROR') || codes.includes('FORBIDDEN')
      throw new LinearError(`Linear ${res.status}: ${body.errors?.[0]?.message ?? 'no data'}`, res.status, !!limited)
    }
    return body.data
  }
  return {
    async createIssue({ title, description }) {
      const input: Record<string, unknown> = { teamId: opts.teamId, title, description }
      if (opts.stateId) input.stateId = opts.stateId
      if (opts.labelIds?.length) input.labelIds = opts.labelIds
      if (opts.templateId) input.templateId = opts.templateId
      const data = await gql<{ issueCreate: { success: boolean; issue: { id: string; identifier: string; url: string } | null } }>(
        'mutation($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { id identifier url } } }', { input })
      if (!data.issueCreate.success || !data.issueCreate.issue) throw new Error('Linear did not create the issue')
      return data.issueCreate.issue
    },
    async createComment(issueId, body) {
      const data = await gql<{ commentCreate: { success: boolean } }>(
        'mutation($input: CommentCreateInput!) { commentCreate(input: $input) { success } }', { input: { issueId, body } })
      if (!data.commentCreate.success) throw new Error('Linear did not add the comment')
    },
    async issueStates(ids) {
      if (!ids.length) return []
      const data = await gql<{ issues: { nodes: Array<{ id: string; completedAt: string | null; canceledAt?: string | null; state: { type: string } | null }> } }>(
        'query($ids: [ID!]) { issues(filter: { id: { in: $ids } }, first: 50) { nodes { id completedAt canceledAt state { type } } } }', { ids: ids.slice(0, 50) })
      return data.issues.nodes.map((n) => ({ id: n.id, stateType: n.state?.type ?? 'unknown', completedAt: n.completedAt ?? null, canceledAt: n.canceledAt ?? null }))
    },
  }
}

let override: LinearClient | null | undefined

/** Test hook: a fake client (or null for none); undefined goes back to the environment. */
export function setLinearClient(c: LinearClient | null | undefined): void {
  override = c
}

/** Filing is on only when LINEAR_API_KEY and LINEAR_TEAM_ID are both set. */
export const linearConfigured = () => override !== undefined ? override !== null : !!(config.linearApiKey && config.linearTeamId)

export function getLinearClient(): LinearClient | null {
  if (override !== undefined) return override
  if (!config.linearApiKey || !config.linearTeamId) return null
  return httpLinearClient({
    apiKey: config.linearApiKey, teamId: config.linearTeamId, stateId: config.linearTriageStateId,
    labelIds: config.linearLabelIds, templateId: config.linearTemplateId,
  })
}
