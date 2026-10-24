/**
 * Value and record types of the workflow project store.
 *
 * @module @metaworkflow/workflow-project-store/types
 */

import type { Branded } from '@metaworkflow/brand'
import type { JsonValue } from '@metaworkflow/util-values'

/** Opaque identifier of one workflow project registered in the global registry. */
export type ProjectId = Branded<'ProjectId'>

/** Opaque identifier of one workflow run recorded in a project database. */
export type RunId = Branded<'RunId'>

/** Opaque identifier of one activation of one node in one run. */
export type ActivationId = Branded<'ActivationId'>

/** Opaque identifier of one attempt of one activation. */
export type AttemptId = Branded<'AttemptId'>

/** One workflow project as the global registry records it. */
export interface ProjectRecord {
  readonly id: ProjectId
  /**
   * Absolute working directory: the project's own code, artifacts, and
   * environments. It holds no store file, so it can be moved or deleted without
   * touching the project's durable records.
   */
  readonly path: string
  /**
   * Absolute path of the project database the store keeps for this project. It
   * lives in the store's own project directory, never in {@link path}; a
   * library written before the database moved out records the old location here
   * until the project is first opened.
   */
  readonly dbPath: string
  readonly title: string
  /** Epoch milliseconds at which the project was registered. */
  readonly createdAt: number
  /** Epoch milliseconds of the last registry change: title, definition revision, or removal. */
  readonly updatedAt: number
  /**
   * Latest definition revision this registry observed. It is a list hint kept
   * current by {@link WorkflowProjectStore.writeDefinition}; reading a
   * definition document stays authoritative.
   */
  readonly definitionRevision: number
}

/** Request to register one new project. */
export interface CreateProjectRequest {
  readonly title: string
  /**
   * Absolute or `~`-prefixed working directory. Omitted creates
   * `<home>/mwf/projects/<projectId>/workspace`. The project database is never
   * placed in it.
   */
  readonly path?: string
}

/** One immutable definition document revision. */
export interface DefinitionRecord {
  /** Monotonic revision, starting at 1 for the project's first definition. */
  readonly revision: number
  /** Definition document text exactly as the caller wrote it. */
  readonly document: string
  readonly createdAt: number
}

/**
 * Lifecycle status a run row carries; the workflow scheduler owns every
 * transition. `paused` holds a run whose scheduling stopped — by a human, by a
 * single step, or by the recovery pass that parks a run whose attempts were
 * interrupted.
 */
export type RunStatus = 'pending' | 'running' | 'paused' | 'succeeded' | 'failed' | 'canceled'

/** One workflow run row. */
export interface RunRecord {
  readonly runId: RunId
  /** Definition revision the run was started from. */
  readonly definitionRevision: number
  readonly status: RunStatus
  readonly createdAt: number
  readonly updatedAt: number
  /** Why the run reached its status, when the runner recorded a reason. */
  readonly reason: string | null
}

/**
 * One question a node asks the project coordinator: the model-authored question,
 * the optional answer choices it offers, and any structured detail that helps
 * the coordinator answer.
 */
export interface DecisionPayload {
  /** The question the node needs answered to continue. */
  readonly question: string
  /** Candidate answers the node proposed, in the order it offered them. */
  readonly options?: readonly string[]
  /** Structured context the node attached to its question. */
  readonly detail?: JsonValue
}

/** One decision request to record against the activation and attempt that asked. */
export interface DecisionRequestInput {
  /** Identity the asker minted; it is the idempotency key of the request row. */
  readonly requestId: string
  /** Activation whose attempt is waiting for the answer. */
  readonly activationId: ActivationId
  /** Attempt that asked. */
  readonly attemptId: AttemptId
  readonly payload: DecisionPayload
}

/** One recorded decision request and the answer it received. */
export interface DecisionRecord {
  readonly requestId: string
  /** Run the waiting activation belongs to. */
  readonly runId: RunId
  readonly activationId: ActivationId
  /** Definition node whose attempt asked, which names the work the answer resumes. */
  readonly nodeId: string
  readonly attemptId: AttemptId | null
  readonly payload: DecisionPayload
  /** The coordinator's answer, or `undefined` while the request is unanswered. */
  readonly response: JsonValue | undefined
  /** Epoch milliseconds of the request. */
  readonly createdAt: number
  /** Epoch milliseconds of the answer, or `null` while unanswered. */
  readonly answeredAt: number | null
}

/**
 * What one answer attempt did. The first answer is authoritative: a repeated
 * answer reports `already-answered` with the recorded one, and an unknown id
 * reports `unknown` instead of writing a row nothing asked for.
 */
export type DecisionAnswer =
  | {
    /** This call recorded the answer. */
    readonly kind: 'answered'
    readonly decision: DecisionRecord
  }
  | {
    /** An earlier answer is already recorded; this call changed nothing. */
    readonly kind: 'already-answered'
    readonly decision: DecisionRecord
  }
  | {
    /** No request with this id exists in the project. */
    readonly kind: 'unknown'
  }

/** One durable outbox record awaiting replay into a session log. */
export interface OutboxRecord {
  readonly attemptId: AttemptId
  /** Per-attempt event sequence; `(attemptId, eventSeq)` is the idempotency key. */
  readonly eventSeq: number
  /** Event payload text as the writer staged it. */
  readonly payload: string
  /** Epoch milliseconds of the acknowledgement, or `null` while unacknowledged. */
  readonly ackedAt: number | null
}

/** Options for {@link WorkflowProjectStore.removeProject}. */
export interface RemoveProjectOptions {
  /**
   * Delete the project directory tree after the registry row. Default `false`:
   * the caller gets the directory back, asks the human, and decides.
   */
  readonly deleteDirectory?: boolean
}
