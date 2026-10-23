/**
 * Interpreter resolution for the Python node runner.
 *
 * Four tiers decide which interpreter runs a node, in this order: the caller's
 * explicit path, the project's existing `.venv`, the plugin's configured
 * `interpreterPath`, and a platform probe of the launchers a host is expected
 * to have. Every tier is validated the same way — the interpreter must run,
 * report its version, and be a 3.10–3.14 build with the GIL — so a stale or
 * free-threaded interpreter fails here instead of inside a node run.
 *
 * @module @metaworkflow/workflow-python-runner/interpreter
 */

import { runCommand } from './command.ts'
import { pythonChildEnvironment } from './env.ts'
import { PythonRunnerError } from './errors.ts'
import type { InterpreterSource, InterpreterSpec, ResolveInterpreterRequest } from './types.ts'
import { venvDirectory, venvPythonPath } from './venv.ts'

/** Major version every accepted interpreter reports. */
export const PYTHON_MAJOR = 3

/** Oldest accepted minor version. */
export const MIN_SUPPORTED_MINOR = 10

/** Newest accepted minor version. */
export const MAX_SUPPORTED_MINOR = 14

/** Deadline for one interpreter probe. */
export const PROBE_TIMEOUT_MS = 15_000

/** One launcher the platform probe tries, in order. */
export interface InterpreterCandidate {
  /** Executable or launcher name passed to the spawn. */
  readonly command: string
  /** Leading arguments that select the interpreter, such as the Windows launcher's `-3`. */
  readonly args: readonly string[]
}

/**
 * Interpreter launchers this platform is expected to provide.
 * @param platform - platform whose launchers apply.
 * @returns the Windows launcher and `python`, or `python3` elsewhere.
 */
export function interpreterCandidates(platform: NodeJS.Platform): readonly InterpreterCandidate[] {
  return platform === 'win32'
    ? [{ command: 'py', args: ['-3'] }, { command: 'python', args: [] }]
    : [{ command: 'python3', args: [] }]
}

/**
 * Render one candidate for a diagnostic.
 * @param candidate - candidate to describe.
 * @returns the command with its leading arguments, space separated.
 */
export function candidateLabel(candidate: InterpreterCandidate): string {
  return [candidate.command, ...candidate.args].join(' ')
}

/** What one interpreter reported about itself. */
export interface ProbeResult {
  /** `sys.executable` of the probed process: the real interpreter behind any launcher. */
  readonly executable: string
  /** Major version. */
  readonly major: number
  /** Minor version. */
  readonly minor: number
  /** Micro version. */
  readonly micro: number
  /** Whether the build has the GIL disabled (free-threaded). */
  readonly freeThreaded: boolean
}

/**
 * Program the probe runs, written one field per tab-separated column.
 *
 * The version and the GIL flag come from the interpreter itself, and
 * `sys.executable` resolves a launcher such as `py -3` to the binary that every
 * later spawn uses.
 */
const PROBE_PROGRAM = [
  'import sys, sysconfig',
  'free = 1 if (bool(sysconfig.get_config_var("Py_GIL_DISABLED")) or "t" in getattr(sys, "abiflags", "")) else 0',
  'sys.stdout.write("%d.%d.%d\\t%d\\t%s\\n" % (sys.version_info[0], sys.version_info[1], sys.version_info[2], free, sys.executable))',
].join('\n')

/** Version shape the probe prints. */
const PROBE_VERSION_PATTERN = /^(\d+)\.(\d+)\.(\d+)$/u

/**
 * Parse one probe report.
 * @param stdout - everything the probe wrote to stdout; its last non-empty line is the report.
 * @returns the reported facts, or `undefined` when the output is not a well-formed report.
 */
export function parseProbeOutput(stdout: string): ProbeResult | undefined {
  const lines = stdout.split('\n').map(line => line.trim()).filter(line => line.length > 0)
  const line = lines.at(-1)
  if (line === undefined) return undefined
  const columns = line.split('\t')
  if (columns.length !== 3) return undefined
  // The column check above guarantees all three values.
  const [version, freeThreaded, executable] = columns as [string, string, string]
  const match = PROBE_VERSION_PATTERN.exec(version)
  if (match === null) return undefined
  if (freeThreaded !== '0' && freeThreaded !== '1') return undefined
  return {
    executable,
    major: Number(match[1]),
    minor: Number(match[2]),
    micro: Number(match[3]),
    freeThreaded: freeThreaded === '1',
  }
}

/**
 * Run one candidate and read its report.
 * @param candidate - launcher to run.
 * @returns the reported facts, or `undefined` when the launcher cannot run or says nothing usable.
 */
export async function probeInterpreter(candidate: InterpreterCandidate): Promise<ProbeResult | undefined> {
  const outcome = await runCommand(candidate.command, [...candidate.args, '-X', 'utf8', '-c', PROBE_PROGRAM], {
    env: pythonChildEnvironment({}),
    timeoutMs: PROBE_TIMEOUT_MS,
  })
  if (!outcome.ok) return undefined
  return parseProbeOutput(outcome.stdout)
}

/**
 * Render one reported version.
 * @param result - probe facts to render.
 * @returns `major.minor.micro`.
 */
export function formatVersion(result: ProbeResult): string {
  return `${String(result.major)}.${String(result.minor)}.${String(result.micro)}`
}

/**
 * Describe why the runner cannot drive one interpreter.
 * @param result - probe facts of the candidate.
 * @param label - how the candidate was addressed, for the diagnostic.
 * @returns the refusal, or `undefined` for an accepted interpreter.
 */
export function interpreterRefusal(result: ProbeResult, label: string): PythonRunnerError | undefined {
  if (result.freeThreaded) {
    return new PythonRunnerError('python/free-threaded', `interpreter '${label}' is a free-threaded build (${formatVersion(result)}); node functions require the GIL because the wrapper's result protocol and most binary wheels assume it`)
  }
  if (result.major !== PYTHON_MAJOR || result.minor < MIN_SUPPORTED_MINOR || result.minor > MAX_SUPPORTED_MINOR) {
    return new PythonRunnerError('python/unsupported-version', `interpreter '${label}' reports ${formatVersion(result)}; the runner supports Python ${String(PYTHON_MAJOR)}.${String(MIN_SUPPORTED_MINOR)}-${String(PYTHON_MAJOR)}.${String(MAX_SUPPORTED_MINOR)}`)
  }
  return undefined
}

/**
 * Refuse an interpreter the runner cannot drive.
 * @param result - probe facts of the candidate.
 * @param label - how the candidate was addressed, for the diagnostic.
 * @returns nothing.
 * @throws {@link PythonRunnerError} `python/free-threaded` for a build without the GIL, and
 * `python/unsupported-version` outside 3.10–3.14.
 */
export function assertSupportedInterpreter(result: ProbeResult, label: string): void {
  const refusal = interpreterRefusal(result, label)
  if (refusal !== undefined) throw refusal
}

/** Sources {@link resolveInterpreter} consults, injectable for tests. */
export interface InterpreterDependencies {
  /** Platform whose launchers and virtual-environment layout apply. */
  readonly platform: NodeJS.Platform
  /** The plugin's configured interpreter path, when one is configured. */
  readonly configuredInterpreterPath?: string
  /** Whether a path names an existing file. */
  readonly exists: (path: string) => Promise<boolean>
  /** Run one launcher and report what it says about itself. */
  readonly probe: (candidate: InterpreterCandidate) => Promise<ProbeResult | undefined>
}

/**
 * Validate one named interpreter path.
 * @param path - interpreter or launcher to validate.
 * @param source - precedence tier that named it.
 * @param dependencies - existence check and probe.
 * @param virtualEnv - virtual environment root when the path belongs to one.
 * @returns the validated interpreter.
 * @throws {@link PythonRunnerError} `python/not-found` when the path is missing or silent, and the
 * version refusals of {@link assertSupportedInterpreter}.
 */
export async function interpreterFromPath(
  path: string,
  source: InterpreterSource,
  dependencies: InterpreterDependencies,
  virtualEnv?: string,
): Promise<InterpreterSpec> {
  if (!(await dependencies.exists(path))) {
    throw new PythonRunnerError('python/not-found', `interpreter '${path}' does not exist`)
  }
  const result = await dependencies.probe({ command: path, args: [] })
  if (result === undefined) {
    throw new PythonRunnerError('python/not-found', `interpreter '${path}' did not report its version`)
  }
  assertSupportedInterpreter(result, path)
  return { path: result.executable, version: formatVersion(result), source, ...(virtualEnv === undefined ? {} : { virtualEnv }) }
}

/**
 * Resolve the interpreter for one request through every precedence tier.
 *
 * A named tier — explicit, project environment, configured path — is
 * authoritative: when it is unusable the call refuses instead of silently
 * running on another interpreter. The probe tier instead walks its launchers,
 * because a host can register a free-threaded build as the default `py -3` and
 * still hold a supported `python`; the first launcher that qualifies wins, and
 * the first structured refusal is reported when none does.
 * @param request - explicit path and project directory from the caller.
 * @param dependencies - platform, configured path, existence check, and probe.
 * @returns the validated interpreter.
 * @throws {@link PythonRunnerError} `python/not-found` when no tier yields a usable interpreter, and
 * the version refusals of {@link assertSupportedInterpreter}.
 */
export async function resolveInterpreter(
  request: ResolveInterpreterRequest,
  dependencies: InterpreterDependencies,
): Promise<InterpreterSpec> {
  if (request.interpreterPath !== undefined) {
    return await interpreterFromPath(request.interpreterPath, 'explicit', dependencies)
  }
  if (request.projectDir !== undefined) {
    const directory = venvDirectory(request.projectDir)
    const pythonPath = venvPythonPath(directory, dependencies.platform)
    if (await dependencies.exists(pythonPath)) {
      return await interpreterFromPath(pythonPath, 'project-venv', dependencies, directory)
    }
  }
  if (dependencies.configuredInterpreterPath !== undefined) {
    return await interpreterFromPath(dependencies.configuredInterpreterPath, 'config', dependencies)
  }
  const tried: string[] = []
  const refused: PythonRunnerError[] = []
  for (const candidate of interpreterCandidates(dependencies.platform)) {
    const label = candidateLabel(candidate)
    tried.push(label)
    const result = await dependencies.probe(candidate)
    if (result === undefined) continue
    const refusal = interpreterRefusal(result, label)
    if (refusal !== undefined) {
      refused.push(refusal)
      continue
    }
    return { path: result.executable, version: formatVersion(result), source: 'probe' }
  }
  const [firstRefusal] = refused
  if (firstRefusal !== undefined) throw firstRefusal
  throw new PythonRunnerError('python/not-found', `no Python ${String(PYTHON_MAJOR)}.${String(MIN_SUPPORTED_MINOR)}-${String(PYTHON_MAJOR)}.${String(MAX_SUPPORTED_MINOR)} interpreter found; tried ${tried.join(', ')}`)
}
