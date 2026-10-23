/**
 * Whole-tree termination on both platforms, plus the host bindings that a real
 * run uses. The platform branch is exercised by injecting the platform, so both
 * mechanisms are pinned on either host.
 */

import { describe, expect, it } from 'vitest'
import {
  TERMINATE_RETRY_DELAY_MS,
  isMissingProcess,
  isProcessAlive,
  realTerminateOptions,
  signalProcessGroup,
  taskkillProcessTree,
  terminateProcessTree,
} from '../src/terminate.ts'
import type { TerminateOptions } from '../src/terminate.ts'

/** A pid no host allocates, so every real termination call is harmless. */
const MISSING_PID = 2 ** 31 - 1

/** Options whose every host effect is recorded instead of performed. */
function recordingOptions(overrides: Partial<TerminateOptions>): { options: TerminateOptions; calls: string[] } {
  const calls: string[] = []
  const options: TerminateOptions = {
    platform: 'linux',
    retryDelayMs: 0,
    signalProcessGroup: (pid: number) => {
      calls.push(`signal:${String(pid)}`)
    },
    taskkill: async (pid: number) => {
      calls.push(`taskkill:${String(pid)}`)
    },
    isAlive: () => false,
    delay: async () => {
      calls.push('delay')
    },
    ...overrides,
  }
  return { options, calls }
}

/** Build one `process.kill` failure with a specific code. */
function killFailure(code: string): Error {
  return Object.assign(new Error(`kill ${code}`), { code })
}

describe('terminateProcessTree', () => {
  it('terminates the tree through taskkill on Windows', async () => {
    const { options, calls } = recordingOptions({ platform: 'win32' })
    await terminateProcessTree(42, options)
    expect(calls).toEqual(['taskkill:42', 'delay'])
  })

  it('retries once through taskkill when the tree is still alive', async () => {
    const { options, calls } = recordingOptions({ platform: 'win32', isAlive: () => true })
    await terminateProcessTree(42, options)
    expect(calls).toEqual(['taskkill:42', 'delay', 'taskkill:42'])
  })

  it('signals the process group on POSIX', async () => {
    const { options, calls } = recordingOptions({})
    await terminateProcessTree(42, options)
    expect(calls).toEqual(['signal:42', 'delay'])
  })

  it('signals the process group again when it is still alive', async () => {
    const { options, calls } = recordingOptions({ isAlive: () => true })
    await terminateProcessTree(42, options)
    expect(calls).toEqual(['signal:42', 'delay', 'signal:42'])
  })

  it('treats an already-departed group as terminated', async () => {
    const { options } = recordingOptions({
      signalProcessGroup: () => {
        throw killFailure('ESRCH')
      },
    })
    await expect(terminateProcessTree(42, options)).resolves.toBeUndefined()
  })

  it('surfaces any other signalling failure', async () => {
    const { options } = recordingOptions({
      signalProcessGroup: () => {
        throw killFailure('EPERM')
      },
    })
    await expect(terminateProcessTree(42, options)).rejects.toThrow('kill EPERM')
  })
})

describe('isMissingProcess', () => {
  it('recognizes the codes a departed target reports', () => {
    expect(isMissingProcess(killFailure('ESRCH'))).toBe(true)
    expect(isMissingProcess(killFailure('EINVAL'))).toBe(true)
  })

  it('does not hide a real failure', () => {
    expect(isMissingProcess(killFailure('EPERM'))).toBe(false)
    expect(isMissingProcess('not an error')).toBe(false)
  })
})

describe('host bindings', () => {
  it('reports the host platform and the documented retry delay', () => {
    expect(realTerminateOptions().platform).toBe(process.platform)
    expect(realTerminateOptions('linux').platform).toBe('linux')
    expect(TERMINATE_RETRY_DELAY_MS).toBe(2000)
  })

  it('rejects a group that does not exist', () => {
    expect(() => {
      signalProcessGroup(MISSING_PID)
    }).toThrow()
  })

  it('completes a taskkill for a pid that is gone', async () => {
    await expect(taskkillProcessTree(MISSING_PID)).resolves.toBeUndefined()
  })

  it('distinguishes a live pid from a departed one', () => {
    expect(isProcessAlive(process.pid)).toBe(true)
    expect(isProcessAlive(MISSING_PID)).toBe(false)
  })

  it('exposes every effect a real run needs', async () => {
    const options = realTerminateOptions()
    await options.delay(0)
    expect(() => {
      options.signalProcessGroup(MISSING_PID)
    }).toThrow()
    await expect(options.taskkill(MISSING_PID)).resolves.toBeUndefined()
    expect(options.isAlive(process.pid)).toBe(true)
    expect(options.retryDelayMs).toBe(TERMINATE_RETRY_DELAY_MS)
  })
})
