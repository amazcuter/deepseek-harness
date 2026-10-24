/**
 * The live session registry: which attempt each running child Agent belongs to.
 *
 * `ctx.mwfNodeSessions` answers one question for the lifetime of an attempt —
 * "whose work is this session?" — so the completion tool, the executor's
 * teardown, and a caller inspecting a live Agent map a `SessionId` back to the
 * project, run, attempt, node, and revision it serves. Records appear when an
 * attempt starts and disappear when it settles, so the registry never grows
 * with workflow history; the durable retained-session mapping lives in the
 * project store instead.
 *
 * @module @metaworkflow/workflow-agent-executor/node-sessions
 */

import { Context, Service } from '@deepseek-ai/cordis'
import type { SessionId } from '@metaworkflow/session'
import type { NodeSessionRecord } from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    mwfNodeSessions: NodeSessionRegistry
  }
}

/** One record per live child Agent of the workflow agent executor. */
export class NodeSessionRegistry extends Service {
  private readonly records = new Map<SessionId, NodeSessionRecord>()

  /**
   * @param ctx - plugin context that owns the service; disposing it drops every record.
   */
  constructor(ctx: Context) {
    super(ctx, 'mwfNodeSessions')
  }

  /**
   * Record the attempt one session runs for.
   *
   * A retained node resumes the same session for a later attempt, so binding an
   * existing session replaces its record: the newest attempt is the one that
   * drives it now.
   * @param record - the session and the attempt running it.
   * @returns nothing.
   */
  bind(record: NodeSessionRecord): void {
    this.records.set(record.sessionId, record)
  }

  /**
   * The record of one session.
   * @param sessionId - child Agent's session identity.
   * @returns the attempt the session serves, or `undefined` when no attempt owns it.
   */
  lookup(sessionId: SessionId): NodeSessionRecord | undefined {
    return this.records.get(sessionId)
  }

  /**
   * Drop the record of one settled attempt.
   * @param sessionId - child Agent's session identity.
   * @returns nothing; an absent record is not an error.
   */
  forget(sessionId: SessionId): void {
    this.records.delete(sessionId)
  }
}
