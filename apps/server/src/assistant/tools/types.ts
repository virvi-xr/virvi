// Virvi Assistant (LIV-155): a tool wraps one existing route (a few reads wrap two or three) and runs it in-process
// as the signed-in user, so the route's own authorization always decides.
import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { z } from 'zod'
import type { AssistantEffect } from '@virvixr/shared'
import type { AuthUser } from '../../middleware/auth.js'

export interface ToolCtx {
  app: FastifyInstance
  request: FastifyRequest
  user: AuthUser
  self: { email: string | null; wallets: string[] }
}

export interface Call {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  url: string
  body?: unknown
}

/**
 * The undo a write's `before` captures. A Call when the previous values say it all (PUT the old name back). For a
 * create, whose undo needs the new row's id, a function the runner calls with the write's response; it may return
 * null when there is nothing to undo (adding a file that was already in the library). Null: the write can't be undone.
 */
export type UndoSpec = Call | ((res: unknown) => Call | null) | null

export interface Before {
  undo: UndoSpec
  /** The fields the write set, taken from its response; Undo compares the current state against them first. */
  after: (res: unknown) => unknown
  /**
   * The same fields as they are now, shaped like `after`: Undo re-runs `before` and refuses when these no longer
   * match what the write left. Absent for creates, whose new row `before` can't address.
   */
  current?: unknown
  /** The organization the write's scene belongs to (every action row names it); null when the scene has none. */
  orgName: string | null
}

export interface ToolDef<A> {
  name: string
  description: string
  input: z.ZodType<A>
  effect: AssistantEffect
  /** Response keys dropped before the model sees it, on top of redact()'s own. */
  redactKeys?: string[]
  /**
   * The route to run. A read may return several calls (get_plan, get_scene_publishing): all must succeed, and
   * `summarize` gets their responses as an array, in order.
   */
  call(args: A, ctx: ToolCtx): Promise<Call | Call[]> | Call | Call[]
  /** Read the current values before a write; returns the undo call and the org label. Required for every write. */
  before?(args: A, ctx: ToolCtx): Promise<Before>
  /** e.g. 'Rename scene to "Test Lounge"': server-side text for action rows and plan steps. */
  label(args: A): string
  /** The trimmed object the model sees, before redact(). */
  summarize(res: unknown, args: A): unknown
  /** Only for search_help and open_page, which run here instead of a route. */
  local?(args: A, ctx: ToolCtx): Promise<unknown>
}

/** A refusal from `before` or `local`, reported like a route's own (status and message). */
export class ToolError extends Error {
  constructor(public status: number, message: string) {
    super(message)
  }
}
