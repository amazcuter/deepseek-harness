/**
 * Public vocabulary of the workflow coordinator: the card the coordinator's
 * tools report, the shape one pending decision takes, and the host events a UI
 * subscribes to.
 *
 * Types only, per the package convention.
 *
 * @module @metaworkflow/workflow-coordinator/types
 */

import type { JsonValue } from '@metaworkflow/util-values'
import type { ActivationId, ProjectId, RunId } from '@metaworkflow/workflow-project-store'

/** One decision request the coordinator has not answered yet. */
export interface PendingDecision {
  /** Identity the coordinator answers with. */
  readonly requestId: string
  readonly runId: RunId
  /** Definition node whose attempt is waiting. */
  readonly nodeId: string
  /** The question the node asked. */
  readonly question: string
  /** Candidate answers the node proposed, when it proposed any. */
  readonly options?: readonly string[]
  /** Structured context the node attached, when it attached any. */
  readonly detail?: JsonValue
  /** Epoch milliseconds of the request. */
  readonly createdAt: number
}

/** One run's summary as the coordinator's state tool reports it. */
export interface CoordinatorRunSummary {
  readonly runId: RunId
  readonly status: string
  /** Why the run reached its status, when the scheduler recorded a reason. */
  readonly reason: string | null
}

/** One activation's summary as the coordinator's state tool reports it. */
export interface CoordinatorActivationSummary {
  readonly activationId: ActivationId
  readonly nodeId: string
  readonly status: string
  /** Attempts recorded for this activation. */
  readonly attempts: number
}

/** Everything the coordinator's state tool reports about one project. */
export interface CoordinatorProjectState {
  readonly projectId: ProjectId
  readonly title: string
  /** Absolute project working directory. */
  readonly path: string
  /** Runs in the order the store lists them, newest first. */
  readonly runs: CoordinatorRunSummary[]
  /** Activations of the newest run, or none when the project has no run yet. */
  readonly activations: CoordinatorActivationSummary[]
}

/**
 * One answer the coordinator recorded, announced as a host event so a UI can
 * drop the waiting card without polling the store.
 */
export interface DecisionAnsweredInfo {
  readonly projectId: ProjectId
  readonly runId: RunId
  readonly activationId: ActivationId
  /** The decision that was answered. */
  readonly requestId: string
  /** The answer as the coordinator supplied it. */
  readonly answer: JsonValue
  /** Run status once the resumed activation settled or the call returned. */
  readonly runStatus: string
}
