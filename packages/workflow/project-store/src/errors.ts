/**
 * Typed failures of the workflow project store.
 *
 * @module @metaworkflow/workflow-project-store/errors
 */

/**
 * Stable failure codes. Callers switch on these; messages stay free-form and
 * actionable.
 */
export type WorkflowProjectStoreErrorCode =
  /** The store was closed; no further work is accepted. */
  | 'closed'
  /** The file belongs to another application or holds unrecognized tables. */
  | 'foreign-database'
  /** A project id is not a canonical identifier (path traversal, garbage). */
  | 'invalid-project-id'
  /** A stored row carries a value outside its declared vocabulary. */
  | 'invalid-record'
  /** A request value violates the store's input rules. */
  | 'invalid-request'
  /** A database could not be opened or switched to WAL. */
  | 'open-failed'
  /** No registry row matches the project id. */
  | 'project-not-found'
  /** Another registry row already claims the requested project directory. */
  | 'project-path-in-use'
  /** The durable layout version is neither absent nor current. */
  | 'version-mismatch'
  /** The outbox names an attempt the project database does not hold. */
  | 'unknown-attempt'

/** Typed failure from the workflow project store. */
export class WorkflowProjectStoreError extends Error {
  override readonly name: string = 'WorkflowProjectStoreError'

  /** The stable code callers switch on. */
  readonly code: WorkflowProjectStoreErrorCode

  /**
   * @param code - stable failure code.
   * @param message - actionable description naming the path, project, or value.
   * @param options - standard `Error` options such as `cause`.
   */
  constructor(code: WorkflowProjectStoreErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.code = code
  }
}
