/**
 * Project virtual environments and requirement installation.
 *
 * One project owns `<projectDir>/.venv`. Creation is idempotent and serialized
 * per project directory, so two concurrent callers cannot interleave two
 * `python -m venv` runs into the same directory. Every installation is
 * `--only-binary=:all:`: a host without a C toolchain cannot build an sdist,
 * and a half-built package would surface later as an unrelated import error.
 *
 * @module @metaworkflow/workflow-python-runner/venv
 */

import { mkdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { CommandOptions, CommandOutcome } from './command.ts'
import { pythonChildEnvironment } from './env.ts'
import { PythonRunnerError } from './errors.ts'
import type { InstallRequirementsResult, InterpreterSpec } from './types.ts'

/** Name of the virtual environment directory inside a project directory. */
export const VENV_DIRECTORY_NAME = '.venv'

/** Maximum characters of pip output quoted in one failure message. */
export const INSTALL_FAILURE_DETAIL_LIMIT = 2000

/** Dependencies of {@link VenvManager}, injectable for tests without a real interpreter. */
export interface VenvDependencies {
  /** Platform that decides the virtual-environment layout. */
  readonly platform: NodeJS.Platform
  /** Deadline for one virtual-environment or pip command. */
  readonly installTimeoutMs: number
  /** Whether a path names an existing file. */
  readonly fileExists: (path: string) => Promise<boolean>
  /** Run one helper command to completion. */
  readonly run: (command: string, args: readonly string[], options: CommandOptions) => Promise<CommandOutcome>
}

/**
 * Absolute virtual-environment directory of one project.
 * @param projectDir - project directory that owns the environment.
 * @returns `<projectDir>/.venv`.
 */
export function venvDirectory(projectDir: string): string {
  return join(projectDir, VENV_DIRECTORY_NAME)
}

/**
 * Absolute interpreter path inside one virtual environment.
 * @param directory - virtual-environment root.
 * @param platform - platform whose layout applies.
 * @returns `<directory>/Scripts/python.exe` on Windows and `<directory>/bin/python` elsewhere.
 */
export function venvPythonPath(directory: string, platform: NodeJS.Platform): string {
  return platform === 'win32' ? join(directory, 'Scripts', 'python.exe') : join(directory, 'bin', 'python')
}

/**
 * Whether one path names an existing file.
 *
 * A missing, dangling, or unreadable path is not a usable interpreter, so the
 * distinction between those cases would not change the caller's next step.
 * @param path - path to check.
 * @returns `true` when the path resolves to a regular file.
 */
export async function fileExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile()
  } catch {
    // Any stat failure means the path cannot supply an interpreter.
    return false
  }
}

/**
 * Read the diagnostic one failed helper command printed.
 *
 * pip and `venv` report through stderr; stdout stands in when they said nothing
 * there, because a build failure sometimes reaches stdout only.
 * @param outcome - exit facts of the failed command.
 * @returns the diagnostic text, trimmed; empty when the command printed nothing.
 */
export function commandDiagnostic(outcome: CommandOutcome): string {
  return (outcome.stderr.trim() === '' ? outcome.stdout : outcome.stderr).trim()
}

/**
 * Build the message that reports one failed installation.
 * @param requirements - requirement specifiers the caller asked for.
 * @param outcome - pip exit facts.
 * @returns a message naming the requirements and quoting pip's tail.
 */
export function installFailureMessage(requirements: readonly string[], outcome: CommandOutcome): string {
  const detail = commandDiagnostic(outcome)
  const tail = detail.length > INSTALL_FAILURE_DETAIL_LIMIT ? detail.slice(-INSTALL_FAILURE_DETAIL_LIMIT) : detail
  const quoted = tail === '' ? 'pip printed no diagnostic' : tail
  return `pip install --only-binary=:all: failed for ${requirements.join(', ')} (exit ${String(outcome.exitCode)}); this host never builds from source. ${quoted}`
}

/** Creates and installs into project virtual environments. */
export class VenvManager {
  private readonly dependencies: VenvDependencies
  private readonly tails = new Map<string, Promise<void>>()

  /**
   * @param dependencies - platform, deadlines, and the helper-command runner.
   */
  constructor(dependencies: VenvDependencies) {
    this.dependencies = dependencies
  }

  /**
   * Ensure one project's virtual environment exists.
   *
   * Concurrent callers for the same project directory run in submission
   * order, so the second call observes the first creation instead of starting
   * another one.
   * @param projectDir - project directory that owns the environment.
   * @param base - interpreter that creates the environment.
   * @returns the virtual environment's interpreter path.
   * @throws {@link PythonRunnerError} `venv/create-failed` when the environment cannot be created.
   */
  async ensure(projectDir: string, base: InterpreterSpec): Promise<string> {
    const directory = venvDirectory(projectDir)
    const pythonPath = venvPythonPath(directory, this.dependencies.platform)
    if (await this.dependencies.fileExists(pythonPath)) return pythonPath
    return await this.serialize(directory, async () => {
      if (await this.dependencies.fileExists(pythonPath)) return pythonPath
      await mkdir(projectDir, { recursive: true })
      const outcome = await this.dependencies.run(base.path, ['-m', 'venv', directory], {
        env: pythonChildEnvironment({ platform: this.dependencies.platform }),
        timeoutMs: this.dependencies.installTimeoutMs,
      })
      if (!outcome.ok) {
        throw new PythonRunnerError('venv/create-failed', `python -m venv failed for "${directory}" (exit ${String(outcome.exitCode)}). ${commandDiagnostic(outcome)}`)
      }
      if (!(await this.dependencies.fileExists(pythonPath))) {
        throw new PythonRunnerError('venv/create-failed', `python -m venv reported success for "${directory}" but no interpreter exists at "${pythonPath}"`)
      }
      return pythonPath
    })
  }

  /**
   * Install requirements into one project's virtual environment.
   * @param projectDir - project directory that owns the environment.
   * @param base - interpreter that creates the environment when it is missing.
   * @param requirements - requirement specifiers; an empty list installs nothing.
   * @returns the pip exit facts; a failed installation resolves with `ok: false`.
   * @throws {@link PythonRunnerError} `venv/create-failed` when the environment cannot be created.
   */
  async install(projectDir: string, base: InterpreterSpec, requirements: readonly string[]): Promise<InstallRequirementsResult> {
    const startedAt = Date.now()
    if (requirements.length === 0) {
      return { ok: true, stdout: '', stderr: '', exitCode: 0, durationMs: Date.now() - startedAt }
    }
    const pythonPath = await this.ensure(projectDir, base)
    const outcome = await this.dependencies.run(
      pythonPath,
      ['-m', 'pip', 'install', '--only-binary=:all:', ...requirements],
      {
        env: pythonChildEnvironment({ platform: this.dependencies.platform, virtualEnv: venvDirectory(projectDir) }),
        timeoutMs: this.dependencies.installTimeoutMs,
      },
    )
    const durationMs = Date.now() - startedAt
    if (outcome.ok) {
      return { ok: true, stdout: outcome.stdout, stderr: outcome.stderr, exitCode: outcome.exitCode, durationMs }
    }
    return {
      ok: false,
      error: { code: 'install/failed', message: installFailureMessage(requirements, outcome) },
      stdout: outcome.stdout,
      stderr: outcome.stderr,
      exitCode: outcome.exitCode,
      durationMs,
    }
  }

  /**
   * Queue one operation behind every earlier operation for the same directory.
   * @param key - virtual-environment directory that serializes its callers.
   * @param operation - body to run once every earlier operation settled.
   * @returns the operation's own result or rejection.
   */
  private async serialize<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const tail = (this.tails.get(key) ?? Promise.resolve()).then(operation, operation)
    const settled = tail.then(() => undefined, () => undefined)
    this.tails.set(key, settled)
    return await tail
  }
}
