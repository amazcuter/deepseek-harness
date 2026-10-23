/**
 * Host-side Python function runner for workflow nodes (`ctx.mwfPythonRunner`).
 *
 * A workflow node is a Python function an AI wrote. This service owns the host
 * side of running it on native Windows, Linux, and macOS: which interpreter to
 * use, the project's `.venv`, binary-only dependency installation, and one
 * isolated run whose inputs arrive on stdin as JSON and whose value comes back
 * on a single sentinel line.
 *
 * The package does not schedule work and does not render anything; the workflow
 * scheduler and the GUI land in later stages. Failures are structured: an
 * environment problem rejects the call with a {@link PythonRunnerError} code,
 * while a node that raises, times out, or returns garbage resolves with
 * `ok: false` so one bad node never aborts a batch.
 *
 * @module @metaworkflow/workflow-python-runner
 */

import { spawn } from 'node:child_process'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { runCommand } from './command.ts'
import { pythonChildEnvironment } from './env.ts'
import { PythonRunnerError } from './errors.ts'
import { probeInterpreter, resolveInterpreter } from './interpreter.ts'
import type { InterpreterDependencies } from './interpreter.ts'
import { CappedStream, ResultLineScanner, runVerdict } from './output.ts'
import { realTerminateOptions, terminateProcessTree } from './terminate.ts'
import type { TerminateOptions } from './terminate.ts'
import type {
  InstallRequirementsResult,
  InterpreterSpec,
  ResolveInterpreterRequest,
  RunNodeRequest,
  RunNodeResult,
} from './types.ts'
import { assertNodeId, assertProjectPath, nodeDirectory, nodeFunctionName, wrapperSource, NODE_SOURCE_FILE_NAME, WRAPPER_FILE_NAME } from './wrapper.ts'
import { VenvManager, fileExists } from './venv.ts'

export type * from './types.ts'
export { PythonRunnerError, type PythonRunnerErrorCode } from './errors.ts'

/** Default wall-clock deadline of one node run. */
export const DEFAULT_NODE_TIMEOUT_MS = 120_000

/** Default cap for a run's stdout log. */
export const DEFAULT_MAX_STDOUT_BYTES = 64 * 1024

/** Default cap for a run's stderr log. */
export const DEFAULT_MAX_STDERR_BYTES = 64 * 1024

/** Default deadline for one virtual-environment or pip command. */
export const DEFAULT_INSTALL_TIMEOUT_MS = 300_000

/** Plugin configuration. */
export interface Config {
  /**
   * Interpreter path or launcher used when neither the caller nor an existing
   * project `.venv` supplies one. Omitted probes the platform launchers.
   */
  readonly interpreterPath?: string
  /** Default wall-clock deadline of one node run, in milliseconds. */
  readonly timeoutMs?: number
  /** Default cap for a run's stdout log, in bytes. */
  readonly maxStdoutBytes?: number
  /** Default cap for a run's stderr log, in bytes. */
  readonly maxStderrBytes?: number
  /** Deadline for one virtual-environment creation or pip installation, in milliseconds. */
  readonly installTimeoutMs?: number
}

/** Schemastery validator for {@link Config}. */
const ConfigSchema: z<Config> = z.object({
  interpreterPath: z.string(),
  timeoutMs: z.natural(),
  maxStdoutBytes: z.natural(),
  maxStderrBytes: z.natural(),
  installTimeoutMs: z.natural(),
})

/** Every setting a call reads, with the plugin defaults applied. */
interface RunnerSettings {
  readonly interpreterPath?: string
  readonly timeoutMs: number
  readonly maxStdoutBytes: number
  readonly maxStderrBytes: number
  readonly installTimeoutMs: number
}

/** One run's resolved limits. */
interface RunSettings {
  readonly timeoutMs: number
  readonly maxStdoutBytes: number
  readonly maxStderrBytes: number
}

/**
 * Apply the plugin defaults to one configuration.
 * @param config - validated plugin configuration.
 * @returns the settings every call reads.
 */
function resolveRunnerSettings(config: Config): RunnerSettings {
  return {
    ...(config.interpreterPath === undefined ? {} : { interpreterPath: config.interpreterPath }),
    timeoutMs: config.timeoutMs ?? DEFAULT_NODE_TIMEOUT_MS,
    maxStdoutBytes: config.maxStdoutBytes ?? DEFAULT_MAX_STDOUT_BYTES,
    maxStderrBytes: config.maxStderrBytes ?? DEFAULT_MAX_STDERR_BYTES,
    installTimeoutMs: config.installTimeoutMs ?? DEFAULT_INSTALL_TIMEOUT_MS,
  }
}

/**
 * Combine one request's limits with the plugin defaults.
 * @param request - run request that may override each limit.
 * @param settings - plugin settings that supply the omitted limits.
 * @returns the limits this run uses.
 */
function resolveRunSettings(request: RunNodeRequest, settings: RunnerSettings): RunSettings {
  return {
    timeoutMs: request.timeoutMs ?? settings.timeoutMs,
    maxStdoutBytes: request.maxStdoutBytes ?? settings.maxStdoutBytes,
    maxStderrBytes: request.maxStderrBytes ?? settings.maxStderrBytes,
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    mwfPythonRunner: PythonRunner
  }
}

/**
 * Runs node functions on a host Python interpreter.
 *
 * One service instance owns the `.venv` serialization of every project it
 * touches and the termination bindings of the platform it runs on; it holds no
 * other state, so a disposed instance leaves nothing behind.
 */
export default class PythonRunner extends Service {
  static Config: z<Config> = ConfigSchema

  private readonly settings: RunnerSettings
  private readonly venvs: VenvManager
  private readonly terminateOptions: TerminateOptions

  /**
   * @param ctx - plugin context that owns the service lifetime.
   * @param config - validated plugin configuration.
   */
  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'mwfPythonRunner')
    this.settings = resolveRunnerSettings(config)
    this.venvs = new VenvManager({
      platform: process.platform,
      installTimeoutMs: this.settings.installTimeoutMs,
      fileExists,
      run: runCommand,
    })
    this.terminateOptions = realTerminateOptions()
  }

  /**
   * Resolve the interpreter one request runs with.
   *
   * The caller's explicit path wins, then an existing project `.venv`, then the
   * configured `interpreterPath`, then a probe of the platform launchers.
   * @param request - explicit path and project directory; both optional.
   * @returns the validated interpreter.
   * @throws {@link PythonRunnerError} `python/not-found`, `python/unsupported-version`, or `python/free-threaded`.
   */
  async resolveInterpreter(request: ResolveInterpreterRequest = {}): Promise<InterpreterSpec> {
    return await resolveInterpreter(request, this.interpreterDependencies())
  }

  /**
   * Ensure the project's `.venv` exists and return its interpreter.
   *
   * Concurrent calls for the same project serialize, so the second call
   * observes the first creation instead of starting another one.
   * @param projectDir - project directory that owns the environment.
   * @returns absolute path of the environment's interpreter.
   * @throws {@link PythonRunnerError} `project/path-too-long`, `venv/create-failed`, or an interpreter failure.
   */
  async ensureVenv(projectDir: string): Promise<string> {
    assertProjectPath(projectDir)
    return await this.venvs.ensure(projectDir, await this.baseInterpreter())
  }

  /**
   * Install requirements into the project's `.venv`, creating it when missing.
   *
   * Every installation is `--only-binary=:all:`, so a package that publishes no
   * wheel for this platform fails here with pip's own diagnostic instead of
   * failing later inside a node.
   * @param projectDir - project directory that owns the environment.
   * @param requirements - requirement specifiers; an empty list installs nothing.
   * @returns the pip exit facts, with `ok: false` and the pip tail on failure.
   * @throws {@link PythonRunnerError} `project/path-too-long`, `venv/create-failed`, or an interpreter failure.
   */
  async installRequirements(projectDir: string, requirements: readonly string[]): Promise<InstallRequirementsResult> {
    assertProjectPath(projectDir)
    return await this.venvs.install(projectDir, await this.baseInterpreter(), requirements)
  }

  /**
   * Run one node function and return its JSON value or its structured failure.
   *
   * The source is written to `nodes/<nodeId>/node_main.py` beside a generated
   * wrapper, which the resolved interpreter starts with `-X utf8` in the node's
   * own directory. Inputs arrive on stdin as UTF-8 JSON. On the deadline or an
   * abort the whole process tree is terminated.
   * @param request - project, node, source, inputs, limits, environment, and abort signal.
   * @returns the node's value or the failure, with captured logs and exit facts.
   * @throws {@link PythonRunnerError} `project/path-too-long`, `node/invalid-id`, or an interpreter failure;
   * an aborted run refuses with the signal's reason instead.
   */
  async runNode(request: RunNodeRequest): Promise<RunNodeResult> {
    request.signal?.throwIfAborted()
    assertProjectPath(request.projectDir)
    assertNodeId(request.nodeId)
    const settings = resolveRunSettings(request, this.settings)
    const directory = nodeDirectory(request.projectDir, request.nodeId)
    const wrapperPath = join(directory, WRAPPER_FILE_NAME)
    const spec = await this.resolveInterpreter({ projectDir: request.projectDir })
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, NODE_SOURCE_FILE_NAME), request.source, 'utf8')
    await writeFile(wrapperPath, wrapperSource(nodeFunctionName(request.nodeId)), 'utf8')
    const env = pythonChildEnvironment({
      ...(spec.virtualEnv === undefined ? {} : { virtualEnv: spec.virtualEnv }),
      ...(request.env === undefined ? {} : { env: request.env }),
    })
    const startedAt = Date.now()
    return await new Promise<RunNodeResult>((resolveResult, rejectResult) => {
      // The annotated target selects the spawn overload whose piped streams are non-null.
      const child: ChildProcessWithoutNullStreams = spawn(spec.path, ['-X', 'utf8', wrapperPath], {
        cwd: directory,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        // Off Windows the child leads its own group, so one signal reaches every descendant.
        detached: process.platform !== 'win32',
      })
      // A returned ChildProcess has started; a spawn failure arrives as an 'error' event.
      const pid = child.pid as number
      const stdoutLog = new CappedStream(settings.maxStdoutBytes, 'head')
      const stderrLog = new CappedStream(settings.maxStderrBytes, 'tail')
      const scanner = new ResultLineScanner(stdoutLog)
      let timedOut = false
      let aborted = false
      let abortReason: Error = new Error('node run aborted')

      const terminate = (): void => {
        // A termination failure is contained: 'close' still reports the run.
        /* v8 ignore next 1 -- a whole-tree kill failure is only observable as the run's own exit facts. */
        void terminateProcessTree(pid, this.terminateOptions).catch(() => undefined)
      }
      const release = (): void => {
        clearTimeout(timer)
        request.signal?.removeEventListener('abort', onAbort)
      }
      const timer = setTimeout(() => {
        timedOut = true
        terminate()
      }, settings.timeoutMs)
      const onAbort = (): void => {
        aborted = true
        const reason: unknown = request.signal?.reason
        abortReason = reason instanceof Error ? reason : new Error(`node run aborted: ${String(reason)}`)
        terminate()
      }
      request.signal?.addEventListener('abort', onAbort, { once: true })
      child.stdout.on('data', (chunk: Buffer) => {
        scanner.push(chunk)
      })
      child.stderr.on('data', (chunk: Buffer) => {
        stderrLog.push(chunk)
      })
      /* v8 ignore next 3 -- a node can exit before it reads its inputs; 'close' reports that outcome. */
      child.stdin.on('error', () => {
        return
      })
      /* v8 ignore start -- a resolved interpreter can disappear between resolution and spawn; no test can hold that window open. */
      child.on('error', (error: Error) => {
        release()
        rejectResult(new PythonRunnerError('python/not-found', `interpreter "${spec.path}" could not be started`, { cause: error }))
      })
      /* v8 ignore stop */
      child.on('close', (code: number | null) => {
        const scan = scanner.finish()
        release()
        if (aborted) {
          rejectResult(abortReason)
          return
        }
        const facts = {
          stdout: stdoutLog.text(),
          stderr: stderrLog.text(),
          exitCode: code,
          durationMs: Date.now() - startedAt,
          timedOut,
        }
        const verdict = runVerdict({ scan, exitCode: code, timedOut, nodeId: request.nodeId, timeoutMs: settings.timeoutMs })
        if (verdict.ok) resolveResult({ ok: true, value: verdict.value, ...facts })
        else resolveResult({ ok: false, error: { code: verdict.code, message: verdict.message }, ...facts })
      })
      child.stdin.end(JSON.stringify(request.inputs ?? null), 'utf8')
    })
  }

  /**
   * Interpreter tiers this service consults, bound to the host and its configuration.
   * @returns the dependencies of interpreter resolution.
   */
  private interpreterDependencies(): InterpreterDependencies {
    return {
      platform: process.platform,
      exists: fileExists,
      probe: probeInterpreter,
      ...(this.settings.interpreterPath === undefined ? {} : { configuredInterpreterPath: this.settings.interpreterPath }),
    }
  }

  /**
   * Interpreter that creates a project environment.
   *
   * A project `.venv` is never its own base: the `.venv` tier is skipped, so an
   * existing environment is reused instead of nested inside a new one.
   * @returns the configured interpreter, or the probed platform launcher.
   */
  private async baseInterpreter(): Promise<InterpreterSpec> {
    return await resolveInterpreter({}, this.interpreterDependencies())
  }
}
