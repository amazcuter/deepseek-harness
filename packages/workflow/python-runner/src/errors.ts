/**
 * Typed failures of the Python node runner.
 *
 * @module @metaworkflow/workflow-python-runner/errors
 */

/**
 * Stable failure codes. Callers switch on these; messages stay free-form and
 * name the path, version, node, or process that failed.
 *
 * Environment failures (`python/*`, `venv/*`, `install/*`, `project/*`) reject
 * the service call. Node failures (`node/*`) arrive as data on a resolved
 * result so one failed node never aborts a batch of runs.
 */
export type PythonRunnerErrorCode =
  /** No usable interpreter was found through any precedence tier. */
  | 'python/not-found'
  /** The interpreter runs a version outside the supported 3.10–3.14 range. */
  | 'python/unsupported-version'
  /** The interpreter is a free-threaded build, whose ABI the runner refuses. */
  | 'python/free-threaded'
  /** `.venv` creation, or the interpreter inside it, failed. */
  | 'venv/create-failed'
  /** `pip install` failed; the environment is unchanged by that package. */
  | 'install/failed'
  /** The node printed no result, a wrong result type, or more than one result line. */
  | 'node/invalid-return'
  /** The node raised, exited nonzero, or failed to import. */
  | 'node/exception'
  /** The node exceeded its deadline and its process tree was terminated. */
  | 'node/timeout'
  /** The node's own result exceeded the accepted result-line size. */
  | 'node/output-too-large'
  /** The node id is not usable as one directory name and Python function name. */
  | 'node/invalid-id'
  /** The project directory is too long for a Windows process working directory. */
  | 'project/path-too-long'

/** Typed failure from the Python node runner. */
export class PythonRunnerError extends Error {
  override readonly name: string = 'PythonRunnerError'

  /** The stable code callers switch on. */
  readonly code: PythonRunnerErrorCode

  /**
   * @param code - stable failure code.
   * @param message - actionable description naming the path, version, or node.
   * @param options - standard `Error` options, including the underlying `cause`.
   */
  constructor(code: PythonRunnerErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.code = code
  }
}
