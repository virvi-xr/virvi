import { config } from '../config.js'

/** What error filing needs from Linear (LIV-66). Tests set a fake with setLinearClient; nothing in tests calls Linear. */
export interface LinearClient {
  createIssue(input: { title: string; description: string }): Promise<{ id: string; identifier: string; url: string }>
  createComment(issueId: string, body: string): Promise<void>
}

const ENDPOINT = 'https://api.linear.app/graphql'

export function httpLinearClient(opts: {
  apiKey: string; teamId: string; stateId?: string | null; labelIds?: string[]; templateId?: string | null; fetch?: typeof fetch
}): LinearClient {
  const doFetch = opts.fetch ?? fetch
  async function gql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    const res = await doFetch(ENDPOINT, {
      method: 'POST',
      // A personal API key goes as it is; an OAuth token would be "Bearer …"
      headers: { 'content-type': 'application/json', authorization: opts.apiKey },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(15_000),
    })
    const body = await res.json().catch(() => ({})) as { data?: T; errors?: Array<{ message?: string }> }
    if (!res.ok || body.errors?.length || !body.data) throw new Error(`Linear ${res.status}: ${body.errors?.[0]?.message ?? 'no data'}`)
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
