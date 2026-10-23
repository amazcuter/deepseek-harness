/**
 * Termination of one node's whole process tree.
 *
 * A node function may spawn a subprocess itself, and `child.kill()` reaches
 * only the process the runner started: the grandchild survives, keeps the pipe
 * open, and holds a port or a file lock. Each platform therefore gets the
 * mechanism it owns — `taskkill /T /F` on Windows, a signal to the process
 * group the runner created on POSIX — and one retry after 2 seconds for a tree
 * that is still alive.
 *
 * @module @metaworkflow/workflow-python-runner/terminate
 */

import { spawn } from 'node:child_process'

/** Wait before the second termination attempt. */
export const TERMINATE_RETRY_DELAY_MS = 2000

/** Everything {@link terminateProcessTree} needs from the host. */
export interface TerminateOptions {
  /** Platform that selects the termination mechanism. */
  readonly platform: NodeJS.Platform
  /** Wait before the second attempt. */
  readonly retryDelayMs: number
  /** Signal the process group led by this pid (POSIX). */
  readonly signalProcessGroup: (pid: number) => void
  /** Terminate this pid and every descendant (Windows). */
  readonly taskkill: (pid: number) => Promise<void>
  /** Whether the process still exists. */
  readonly isAlive: (pid: number) => boolean
  /** Wait for the given time. */
  readonly delay: (milliseconds: number) => Promise<void>
}

/**
 * Whether a `process.kill` failure means the target no longer exists.
 *
 * POSIX reports `ESRCH` for a departed process group; Windows reports `EINVAL`
 * for the negative pid that names a group, which is also what a departed group
 * looks like there because the platform has no such identifier.
 * @param error - value thrown by `process.kill`.
 * @returns `true` when no process was reachable.
 */
export function isMissingProcess(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code
  return code === 'ESRCH' || code === 'EINVAL'
}

/**
 * Signal the process group led by one pid.
 * @param pid - leader pid of the group the runner created.
 * @param signal - signal to deliver.
 * @returns nothing.
 */
export function signalProcessGroup(pid: number, signal: NodeJS.Signals = 'SIGKILL'): void {
  process.kill(-pid, signal)
}

/**
 * Terminate one process and every descendant through `taskkill`.
 * @param pid - pid of the process to terminate.
 * @returns resolution once `taskkill` exited, whatever its status: a pid that is already
 * gone is a completed termination, and both paths that can reach here treat it the same way.
 */
export async function taskkillProcessTree(pid: number): Promise<void> {
  const child = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
  await new Promise<void>((resolve) => {
    // A missing `taskkill` reports through 'error' and a completed one through
    // 'close'; both mean the termination attempt is over.
    const done = (): void => {
      resolve()
    }
    child.on('error', done)
    child.on('close', done)
  })
}

/**
 * Whether one process still exists.
 * @param pid - pid to check.
 * @returns `true` when the pid is signalable.
 */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    // A pid that cannot be signalled names no live process.
    return false
  }
}

/**
 * Host bindings of {@link terminateProcessTree}.
 * @param platform - platform that selects the mechanism; defaults to `process.platform`.
 * @returns the termination options for a real node run.
 */
export function realTerminateOptions(platform: NodeJS.Platform = process.platform): TerminateOptions {
  return {
    platform,
    retryDelayMs: TERMINATE_RETRY_DELAY_MS,
    signalProcessGroup: (pid: number) => {
      signalProcessGroup(pid)
    },
    taskkill: taskkillProcessTree,
    isAlive: isProcessAlive,
    delay: async (milliseconds: number) => {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, milliseconds)
      })
    },
  }
}

/**
 * Terminate one node's whole process tree, retrying once after the delay.
 * @param pid - pid the runner spawned.
 * @param options - platform bindings.
 * @returns resolution once the tree is gone or the single retry was issued.
 */
export async function terminateProcessTree(pid: number, options: TerminateOptions): Promise<void> {
  const terminate = async (): Promise<void> => {
    if (options.platform === 'win32') {
      await options.taskkill(pid)
      return
    }
    try {
      options.signalProcessGroup(pid)
    } catch (error) {
      if (!isMissingProcess(error)) throw error
    }
  }
  await terminate()
  await options.delay(options.retryDelayMs)
  if (!options.isAlive(pid)) return
  await terminate()
}
