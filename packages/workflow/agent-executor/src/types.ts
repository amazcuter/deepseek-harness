/**
 * Public vocabulary of the workflow agent executor: the plugin configuration,
 * the failure codes one execution can report, and the session record that ties
 * one live child Agent to the attempt running it.
 *
 * Types only, per the package convention.
 *
 * @module @metaworkflow/workflow-agent-executor/types
 */

import type { SessionId } from '@metaworkflow/session'
import type { AttemptId, ProjectId, RunId } from '@metaworkflow/workflow-project-store'

/** Plugin configuration. */
export interface Config {
  /**
   * Wall-clock deadline of one node turn, in milliseconds. Omitted uses the
   * executor's default of ten minutes; an exceeded deadline cancels the child
   * Agent's turn and reports a retryable `agent/timeout` failure.
   */
  readonly turnTimeoutMs?: number
}

/**
 * Stable failure codes one execution reports through the scheduler's
 * `NodeFailure.code`.
 *
 * The codes name what the executor could not do — read the run's stored
 * definition, resolve the project working directory, build the child Agent's
 * composition, or wait for a completion. A retried activation reports the same
 * codes, so a consumer distinguishes an adapter problem from a missing
 * completion without parsing text.
 */
export type AgentExecutorErrorCode =
  /** The recorded run the activation belongs to is gone or belongs to another revision. */
  | 'agent/run-unavailable'
  /** The activation names a definition revision the run no longer executes. */
  | 'agent/stale-activation'
  /** The run's stored definition revision is missing, or its document does not parse as a definition. */
  | 'agent/definition-unavailable'
  /** The stored revision declares no agent node under the activation's id. */
  | 'agent/node-unavailable'
  /** The project working directory cannot be opened. */
  | 'agent/project-unavailable'
  /** The child Agent could not be created or resumed: the session store is unavailable, or a retained session is gone. */
  | 'agent/session-unavailable'
  /** The child Agent's composition could not be built, for example because a configured tool is unknown. */
  | 'agent/composition-failed'
  /** The child Agent's turn was aborted by a cancellation outside this executor. */
  | 'agent/canceled'
  /** The child Agent's turn ended in a failure the loop reported. */
  | 'agent/turn-failed'
  /** The turn exceeded {@link Config.turnTimeoutMs}. */
  | 'agent/timeout'
  /** The turn ended without the completion tool recording a value. */
  | 'agent/completion-missing'
  /** An unexpected failure that carries no stable code of its own. */
  | 'agent/executor-failed'

/**
 * One live child Agent and the attempt running it.
 *
 * The executor registers a record when it starts an attempt and removes it when
 * the attempt settles, so `ctx.mwfNodeSessions` answers "which attempt drives
 * this session" while the attempt runs. The durable mapping that lets a
 * `retained` node resume the same session survives in the project store.
 */
export interface NodeSessionRecord {
  /** The child Agent's session, also its Agent identity. */
  readonly sessionId: SessionId
  /** Project that owns the run. */
  readonly projectId: ProjectId
  /** Run the attempt belongs to. */
  readonly runId: RunId
  /** Attempt this session is running for. */
  readonly attemptId: AttemptId
  /** Definition node the attempt executes. */
  readonly nodeId: string
  /** Definition revision the attempt executes. */
  readonly revision: number
}
