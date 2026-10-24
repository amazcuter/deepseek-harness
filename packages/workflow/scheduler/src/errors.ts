/**
 * Typed failures of the workflow scheduler.
 *
 * @module @metaworkflow/workflow-scheduler/errors
 */

/**
 * Stable failure codes. Callers switch on these; messages stay free-form and
 * actionable.
 */
export type WorkflowSchedulerErrorCode =
  /** The store was closed, so no further scheduling work is accepted. */
  | 'scheduler/closed'
  /** The addressed activation does not belong to the addressed run. */
  | 'scheduler/activation-not-found'
  /** A single step named an activation whose join does not fire yet. */
  | 'scheduler/activation-not-ready'
  /** A retry named an activation that has not failed, is still queued, or already succeeded. */
  | 'scheduler/activation-not-retryable'
  /** A resume named an activation that is not waiting for a decision. */
  | 'scheduler/activation-not-resumable'
  /** The stored revision is absent, so the run's graph cannot be read. */
  | 'scheduler/definition-unavailable'
  /** The stored revision no longer validates as an executable definition. */
  | 'scheduler/definition-invalid'
  /** Another executor already runs this node kind in this context. */
  | 'scheduler/duplicate-executor'
  /** The addressed run does not exist in this project. */
  | 'scheduler/run-not-found'
  /** The requested transition is not legal for the run's current status. */
  | 'scheduler/run-state-invalid'

/** Typed failure from the workflow scheduler. */
export class WorkflowSchedulerError extends Error {
  override readonly name: string = 'WorkflowSchedulerError'

  /** The stable code callers switch on. */
  readonly code: WorkflowSchedulerErrorCode

  /**
   * @param code - stable failure code.
   * @param message - actionable description naming the run, activation, or node.
   * @param options - standard `Error` options such as `cause`.
   */
  constructor(code: WorkflowSchedulerErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.code = code
  }
}
