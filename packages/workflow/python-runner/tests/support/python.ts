/**
 * Real-interpreter detection shared by the suites that spawn Python.
 *
 * Detection is synchronous so a suite can decide between `describe` and
 * `describe.skipIf` at collection time, the way the pwsh suites probe their
 * shell. It picks the same interpreter the runner's probe tier picks: a
 * launcher that reports a GIL build, because this host can register a
 * free-threaded build as its default `py -3`. Hosts without a supported
 * interpreter skip those suites instead of failing: the runner's contract is
 * proven against a real child process, and a host that has none cannot prove
 * anything about it.
 */

import { spawnSync } from 'node:child_process'
import { interpreterCandidates } from '../../src/interpreter.ts'

/** One launcher that a suite can drive on this host. */
export interface HostPython {
  /** Launcher name, such as `py` or `python3`. */
  readonly command: string
  /** Leading launcher arguments, such as the Windows launcher's `-3`. */
  readonly args: readonly string[]
  /** Absolute path the launcher reported for itself. */
  readonly executable: string
}

/**
 * Program that prints the interpreter's own path on a supported, GIL-enabled build.
 *
 * It answers nothing for a free-threaded or out-of-range build, so detection
 * and the runner agree on which interpreter a suite exercises.
 */
const DETECT_PROGRAM = 'import sys, sysconfig\nif not sysconfig.get_config_var("Py_GIL_DISABLED") and sys.version_info[:2] >= (3, 10):\n    sys.stdout.write(sys.executable + "\\n")\n'

/**
 * Find one interpreter this host can run.
 * @returns the launcher and its executable, or `undefined` when no candidate qualifies.
 */
function detectHostPython(): HostPython | undefined {
  for (const candidate of interpreterCandidates(process.platform)) {
    const result = spawnSync(candidate.command, [...candidate.args, '-X', 'utf8', '-c', DETECT_PROGRAM], {
      encoding: 'utf8',
      timeout: 15_000,
    })
    if (result.status !== 0) continue
    const executable = result.stdout.trim().split('\n').at(-1)
    if (executable !== undefined && executable.length > 0) return { ...candidate, executable }
  }
  return undefined
}

/**
 * Interpreter the real-process suites run against.
 *
 * `undefined` on a host without a supported Python 3 launcher; every suite that
 * spawns Python then skips with a named reason instead of failing.
 */
export const hostPython = detectHostPython()

/** Why a Python-spawning suite is skipped on this host. */
export const PYTHON_SKIP_REASON = 'no supported GIL-enabled Python 3 launcher (py -3, python, or python3) resolves on this host, so real-child-process behavior cannot be exercised'
