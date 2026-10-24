/**
 * Public vocabulary of the workflow Python executor: the plugin configuration
 * and the failure codes one execution can report.
 *
 * Types only, per the package convention.
 *
 * @module @metaworkflow/workflow-python-executor/types
 */

import type { PythonRunnerErrorCode } from '@metaworkflow/workflow-python-runner'

/** Plugin configuration. */
export interface Config {
  /**
   * Wall-clock deadline of one node run, in milliseconds. Omitted leaves the
   * deadline to `@metaworkflow/workflow-python-runner`'s own configuration, so a
   * deployment sets it in one place.
   */
  readonly timeoutMs?: number
}

/**
 * Stable failure codes one execution reports through the scheduler's
 * `NodeFailure.code`.
 *
 * The codes name what the executor could not do — read the run's stored
 * definition, resolve the project working directory, or prepare the project
 * environment. A node's own failure travels with the runner's code
 * (`node/exception`, `node/invalid-return`, `node/timeout`, …), so a consumer
 * distinguishes an adapter problem from a node problem without parsing text.
 */
export type PythonExecutorErrorCode =
  /** The run's stored definition revision is missing, or its document does not parse as a definition. */
  | 'python/definition-unavailable'
  /** The stored revision declares no python node under the activation's id. */
  | 'python/node-unavailable'
  /** The project working directory cannot be opened. */
  | 'python/project-unavailable'
  /** An unexpected failure that carries no stable code of its own. */
  | 'python/executor-failed'
  /** A failure the Python runner reported for the node itself. */
  | PythonRunnerErrorCode
