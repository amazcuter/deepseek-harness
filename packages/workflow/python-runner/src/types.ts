/**
 * Public request and result types of the host-side Python node runner.
 *
 * @module @metaworkflow/workflow-python-runner/types
 */

import type { PythonRunnerErrorCode } from './errors.ts'

/** Precedence tier that produced one interpreter. */
export type InterpreterSource =
  /** `ResolveInterpreterRequest.interpreterPath` from the caller. */
  | 'explicit'
  /** The project's own `.venv`. */
  | 'project-venv'
  /** The plugin's configured `interpreterPath`. */
  | 'config'
  /** A platform probe of `py -3` / `python` (Windows) or `python3` (POSIX). */
  | 'probe'

/** One validated interpreter that the runner spawns. */
export interface InterpreterSpec {
  /** Absolute path to the interpreter executable; `sys.executable` of the probed process. */
  readonly path: string
  /** Version the interpreter reports, as `major.minor.micro`. */
  readonly version: string
  /** Precedence tier that produced this interpreter. */
  readonly source: InterpreterSource
  /** Root of the virtual environment that owns the interpreter, when one does. */
  readonly virtualEnv?: string
}

/** Interpreter selection request. */
export interface ResolveInterpreterRequest {
  /** Explicit interpreter path or launcher; wins over every other tier. */
  readonly interpreterPath?: string
  /** Project directory whose `.venv` is preferred when it already has an interpreter. */
  readonly projectDir?: string
}

/** One failed step, as data rather than a thrown error. */
export interface NodeRunFailure {
  /** Stable code consumers switch on. */
  readonly code: PythonRunnerErrorCode
  /** Actionable description naming the failure. */
  readonly message: string
}

/** Request for one node function run. */
export interface RunNodeRequest {
  /** Project directory that owns `nodes/<nodeId>/`. */
  readonly projectDir: string
  /** Node id, used for the node directory name and the Python entry function name. */
  readonly nodeId: string
  /** Complete Python module source written to `nodes/<nodeId>/node_main.py`. */
  readonly source: string
  /** JSON-serializable inputs handed to the node on stdin; omitted sends `null`. */
  readonly inputs?: unknown
  /** Wall-clock deadline; omitted uses the configured default. */
  readonly timeoutMs?: number
  /**
   * Extra environment entries merged after the runner's own environment, so a
   * later entry also overrides `PYTHONUTF8`, `VIRTUAL_ENV`, or `PATH`. A name
   * mapped to `undefined` is removed from the child environment.
   */
  readonly env?: Readonly<Record<string, string | undefined>>
  /** Cap for the captured stdout log; omitted uses the configured default. */
  readonly maxStdoutBytes?: number
  /** Cap for the captured stderr log, which keeps its tail; omitted uses the configured default. */
  readonly maxStderrBytes?: number
  /** Cancels the run and terminates its process tree. */
  readonly signal?: AbortSignal
}

/** Outcome of one node function run. */
export interface RunNodeResult {
  /** Whether the node returned a JSON value within its deadline. */
  readonly ok: boolean
  /** Parsed JSON value the node returned as a JSON string; present only when `ok`. */
  readonly value?: unknown
  /** Why the run failed; present only when `ok` is `false`. */
  readonly error?: NodeRunFailure
  /** Captured stdout, head-capped at the run's limit and without the result line. */
  readonly stdout: string
  /** Captured stderr, tail-capped at the run's limit. */
  readonly stderr: string
  /** Exit code, or `null` when the process never started or was killed by a signal. */
  readonly exitCode: number | null
  /** Wall-clock duration of the run in milliseconds. */
  readonly durationMs: number
  /** Whether the deadline expired and the runner terminated the process tree. */
  readonly timedOut: boolean
}

/** Outcome of one requirements installation. */
export interface InstallRequirementsResult {
  /** Whether every requirement installed from a published binary wheel. */
  readonly ok: boolean
  /** Why the installation failed; present only when `ok` is `false`. */
  readonly error?: NodeRunFailure
  /** Captured pip stdout, head-capped. */
  readonly stdout: string
  /** Captured pip stderr, tail-capped. */
  readonly stderr: string
  /** Exit code, or `null` when the process never started or was terminated. */
  readonly exitCode: number | null
  /** Wall-clock duration of the installation in milliseconds. */
  readonly durationMs: number
}
