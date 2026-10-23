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
  /** A database could not be opened, switched to WAL, or moved to its recorded location. */
  | 'open-failed'
  /** No registry row matches the project id. */
  | 'project-not-found'
  /** The project's working directory is gone or is no longer a directory. */
  | 'project-directory-missing'
  /** Another registry row already claims the requested project directory. */
  | 'project-path-in-use'
  /** An older project database could not be moved out of the working directory; the recorded location is unchanged. */
  | 'relocation-failed'
  /** The durable layout version is neither absent, current, nor reachable through a declared upgrade. */
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
