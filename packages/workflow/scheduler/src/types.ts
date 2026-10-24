/**
 * Public vocabulary of the workflow scheduler: the requests a caller sends,
 * the views it reads back, the executor seam, and the diagnostics one call
 * reports.
 *
 * Types only, per the package convention. Every value here describes scheduling
 * over durable rows; none of it becomes a Session event.
 *
 * @module @metaworkflow/workflow-scheduler/types
 */

import type { JsonValue } from '@metaworkflow/util-values'
import type { WorkflowNode } from '@metaworkflow/workflow-definition'
import type { ActivationId, AttemptId, ProjectId, RunId, RunStatus } from '@metaworkflow/workflow-project-store'

/** The caller-supplied parameters one run started with. */
export type RunParams = Readonly<Record<string, JsonValue>>

/** The named inputs one node execution receives. */
export type NodeInputs = Readonly<Record<string, JsonValue>>

/** Lifecycle of one activation; the scheduler owns every transition. */
export type ActivationStatus = 'pending' | 'running' | 'waiting' | 'succeeded' | 'failed' | 'canceled'

/** Lifecycle of one attempt; a retried activation records a new attempt. */
export type AttemptStatus = 'running' | 'waiting' | 'succeeded' | 'failed' | 'interrupted' | 'canceled'

/** One activated incoming edge of an activation, frozen at routing time. */
export interface IncomingActivation {
  /** Id of the node whose successful result activated this incoming edge. */
  readonly nodeId: string
  /** Iteration that node ran in, so an older round never satisfies a newer join. */
  readonly iteration: number
}

/** One node execution as its executor sees it. */
export interface NodeActivation {
  readonly runId: RunId
  readonly activationId: ActivationId
  /** The definition node being executed, including its kind-specific config. */
  readonly node: WorkflowNode
  /** Project that owns the run, its definition revisions, and its working directory. */
  readonly projectId: ProjectId
  /** Stored definition revision the run executes; the node above belongs to it. */
  readonly definitionRevision: number
  /** Loop iteration this activation belongs to; `0` before any loop re-entry. */
  readonly iteration: number
  /** 1-based attempt number of this execution. */
  readonly attemptNo: number
  /** Recorded attempt row this execution runs under; an executor keys idempotent work on it. */
  readonly attemptId: AttemptId
  /** Run-scoped parameters supplied when the run started. */
  readonly params: RunParams
  /**
   * The coordinator's answer that resumed this activation, when
   * `resumeActivation` supplied one. It is the activating attempt's next input:
   * an executor injects it into the work it continues, never into the values
   * the activation's own bindings assembled.
   */
  readonly decision?: JsonValue
}

/** One file an execution published for later activations of the same run. */
export interface NodeArtifact {
  /** Artifact name an `artifact` input binding reads. */
  readonly name: string
  /** Path relative to the producing node's working directory. */
  readonly path: string
  /** Content digest recorded with the artifact, when the producer computed one. */
  readonly sha256?: string
}

/** Structured failure of one node execution. */
export interface NodeFailure {
  /** Stable code the producer defines; schedulers record it verbatim. */
  readonly code: string
  /** Actionable description of what failed. */
  readonly message: string
}

/** What one node execution reported. */
export type NodeResult =
  | {
    /** The node produced a JSON value the scheduler may route on. */
    readonly status: 'succeeded'
    /** The node's JSON result. */
    readonly value: JsonValue
    /** Files this execution published under stable names. */
    readonly artifacts?: readonly NodeArtifact[]
  }
  | {
    /** The node failed. */
    readonly status: 'failed'
    readonly error: NodeFailure
    /** Whether another attempt of the same activation may succeed. */
    readonly retryable: boolean
  }
  | {
    /** The node suspended itself while it awaits one external decision. */
    readonly status: 'waiting'
    /**
     * The decision request the node is waiting on. The scheduler records the
     * activation and attempt as waiting, releases the execution slot, and
     * commits no result, so a `resumeActivation` call can wake it.
     */
    readonly requestId: string
  }

/**
 * Executes one node kind.
 *
 * The scheduler owns scheduling, retries, concurrency, and persistence; an
 * executor only runs the node it was given and reports what happened. It must
 * observe `signal` and settle, because a paused or canceled run aborts the
 * signal and the scheduler then treats a late result as stale.
 */
export interface NodeExecutor {
  /** Node kind this executor runs; one executor per kind per context. */
  readonly kind: WorkflowNode['kind']
  /**
   * Run one node execution.
   * @param activation - the node, its iteration, attempt number, and run parameters.
   * @param inputs - the assembled input values, keyed by binding name.
   * @param signal - aborted when the run is paused or canceled.
   * @returns the node's outcome; the scheduler commits it and decides what runs next.
   */
  execute(activation: NodeActivation, inputs: NodeInputs, signal: AbortSignal): Promise<NodeResult>
}

/** One run as a caller reads it back. */
export interface RunView {
  readonly runId: RunId
  /** Definition revision the run was created from. */
  readonly definitionRevision: number
  readonly status: RunStatus
  /** Parameters supplied when the run started. */
  readonly params: RunParams
  readonly createdAt: number
  readonly updatedAt: number
  /** Why the run reached its status, when the scheduler recorded a reason. */
  readonly reason: string | null
}

/** One activation as a caller reads it back. */
export interface ActivationView {
  readonly activationId: ActivationId
  readonly runId: RunId
  readonly nodeId: string
  readonly iteration: number
  readonly status: ActivationStatus
  /** Incoming activations this one joins, frozen when routing created or extended it. */
  readonly incoming: readonly IncomingActivation[]
  readonly createdAt: number
  readonly updatedAt: number
}

/** One attempt as a caller reads it back. */
export interface AttemptView {
  readonly attemptId: AttemptId
  readonly activationId: ActivationId
  /** 1-based attempt number within the activation. */
  readonly attemptNo: number
  readonly status: AttemptStatus
  readonly startedAt: number
  /** When the attempt reached a terminal status; `null` while it runs. */
  readonly endedAt: number | null
  /** The failure an executor reported, when the attempt failed. */
  readonly error: NodeFailure | null
}

/** One artifact an activation published. */
export interface ArtifactView {
  readonly activationId: ActivationId
  readonly name: string
  /** Monotonic version within the activation. */
  readonly version: number
  readonly path: string
  readonly sha256: string | null
}

/** Stable diagnostic codes one scheduler call reports. */
export type SchedulerDiagnosticCode =
  /** An input binding could not be resolved, so the activation failed. */
  | 'scheduler/input-missing'
  /** A loop edge would have re-entered its target beyond `maxIterations`. */
  | 'scheduler/loop-exhausted'
  /** A result arrived after its attempt stopped being the current running attempt. */
  | 'scheduler/stale-result'
  /** The node kind a ready activation needs has no registered executor. */
  | 'scheduler/executor-missing'
  /** An executor rejected instead of reporting a structured failure. */
  | 'scheduler/executor-error'
  /** An executor reported a failure that exhausted the attempt budget. */
  | 'scheduler/node-failed'
  /** More than one exclusive outgoing edge matched the result. */
  | 'routing/ambiguous'
  /** No exclusive outgoing edge matched and the node declares no fallback. */
  | 'routing/no-match'

/** One recorded reason why a call took the decision it did. */
export interface SchedulerDiagnostic {
  readonly code: SchedulerDiagnosticCode
  /** Actionable description naming the node, activation, or attempt. */
  readonly message: string
  /** Node the diagnosis concerns. */
  readonly nodeId?: string
  readonly activationId?: ActivationId
  readonly attemptId?: AttemptId
}

/** One run the scheduler drives. */
export interface RunRequest {
  readonly projectId: ProjectId
  readonly runId: RunId
}

/** One named activation of one run. */
export interface ActivationRequest extends RunRequest {
  readonly activationId: ActivationId
}

/**
 * Request to wake one waiting activation with the answer it asked for.
 *
 * The answer becomes the activation's next input: the scheduler keeps it beside
 * the activation's rows until the resumed attempt commits, so a restart between
 * the answer and the execution still hands the same answer to the node.
 */
export interface ResumeActivationRequest extends ActivationRequest {
  /**
   * The coordinator's answer, as lossless JSON. Omitted wakes the activation
   * without an answer, which is what a retry of a waiting node needs when the
   * decision was already folded into the node's own conversation.
   */
  readonly decision?: JsonValue
}

/** Request to start one run from a stored definition revision. */
export interface CreateRunRequest {
  readonly projectId: ProjectId
  /** Stored definition revision the run executes. */
  readonly definitionRevision: number
  /** Run-scoped parameters an input binding may read by key. */
  readonly params?: RunParams
}

/** Identity of the run a call created. */
export interface CreateRunResult {
  readonly runId: RunId
}

/** Request to reconcile every run of one project after a restart. */
export interface ReconcileRequest {
  readonly projectId: ProjectId
}

/** One attempt the recovery pass found in flight. */
export interface InterruptedAttempt {
  readonly runId: RunId
  readonly activationId: ActivationId
  readonly attemptId: AttemptId
  readonly nodeId: string
  readonly iteration: number
}

/** One activation the recovery pass found waiting for a decision. */
export interface WaitingActivation {
  readonly runId: RunId
  readonly activationId: ActivationId
  /** Attempt that asked and is still the waiting one. */
  readonly attemptId: AttemptId
  readonly nodeId: string
  readonly iteration: number
}

/** What the recovery pass changed. */
export interface ReconcileResult {
  /** Attempts that were running when the previous backend stopped. */
  readonly interrupted: readonly InterruptedAttempt[]
  /** Runs the pass parked in `paused`. */
  readonly paused: readonly RunId[]
  /**
   * Activations still waiting for a decision. They keep their state and their
   * slot is not reclaimed as an interrupted attempt: answering one is what
   * resumes it, whatever the previous backend stopped doing.
   */
  readonly waiting: readonly WaitingActivation[]
}

/** What one scheduling call did. */
export interface TickResult {
  readonly runId: RunId
  /** Run status when the call returned. */
  readonly status: RunStatus
  /** Attempts this call started, retries included. */
  readonly dispatched: number
  /** Attempts this call committed a terminal outcome for. */
  readonly completed: number
  /** Every decision this call took that a caller may need to report. */
  readonly diagnostics: readonly SchedulerDiagnostic[]
}

/** Identity of the attempt a retry created. */
export interface RetryResult {
  readonly attemptId: AttemptId
}
