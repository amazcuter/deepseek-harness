/**
 * Helper commands: capture, exit facts, deadline, and byte caps.
 *
 * The real-process cases run against the host interpreter; hosts without one
 * skip them, while the spawn-failure case runs everywhere.
 */

import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { COMMAND_OUTPUT_LIMIT_BYTES, runCommand } from '../src/command.ts'
import { pythonChildEnvironment } from '../src/env.ts'
import { hostPython } from './support/python.ts'

/** Environment a real helper command runs in. */
function environment(): Record<string, string> {
  return pythonChildEnvironment({})
}

describe('runCommand', () => {
  it('reports a spawn failure instead of rejecting', async () => {
    const outcome = await runCommand('mwf-python-runner-missing-command', [], { env: environment(), timeoutMs: 15_000 })
    expect(outcome.ok).toBe(false)
    expect(outcome.exitCode).toBeNull()
    expect(outcome.failure).toContain('ENOENT')
    expect(outcome.stderr).toContain('ENOENT')
  })

  it.skipIf(hostPython === undefined)('captures stdout of a clean run', async () => {
    const outcome = await runCommand(hostPython!.executable, ['-X', 'utf8', '-c', 'print("hi")'], { env: environment(), timeoutMs: 15_000 })
    expect(outcome.ok).toBe(true)
    expect(outcome.exitCode).toBe(0)
    // Windows Python writes CRLF on stdio, so exact line endings are not the contract.
    expect(outcome.stdout.trim()).toBe('hi')
    expect(outcome.stderr).toBe('')
  })

  it.skipIf(hostPython === undefined)('reports a nonzero exit with its stderr', async () => {
    const outcome = await runCommand(hostPython!.executable, ['-X', 'utf8', '-c', 'import sys; sys.stderr.write("bad\\n"); sys.exit(3)'], {
      env: environment(),
      timeoutMs: 15_000,
    })
    expect(outcome.ok).toBe(false)
    expect(outcome.exitCode).toBe(3)
    expect(outcome.stderr.trim()).toBe('bad')
  })

  it.skipIf(hostPython === undefined)('runs in the requested working directory', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'mwf-python-runner-cwd-'))
    try {
      const outcome = await runCommand(hostPython!.executable, ['-X', 'utf8', '-c', 'import os; print(os.getcwd())'], {
        env: environment(),
        cwd: directory,
        timeoutMs: 15_000,
      })
      expect(outcome.stdout.trim().toLowerCase()).toBe(realpathSync(directory).toLowerCase())
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it.skipIf(hostPython === undefined)('kills a command that exceeds its deadline', async () => {
    const outcome = await runCommand(hostPython!.executable, ['-X', 'utf8', '-c', 'import time; time.sleep(30)'], { env: environment(), timeoutMs: 200 })
    expect(outcome.ok).toBe(false)
    expect(outcome.failure).toContain('exceeded 200 ms')
  })

  it.skipIf(hostPython === undefined)('caps stdout at the documented limit', async () => {
    const outcome = await runCommand(hostPython!.executable, ['-X', 'utf8', '-c', 'print("x" * 200000)'], { env: environment(), timeoutMs: 15_000 })
    expect(outcome.ok).toBe(true)
    expect(outcome.stdout).toContain('bytes truncated')
    expect(Buffer.byteLength(outcome.stdout, 'utf8')).toBeLessThan(COMMAND_OUTPUT_LIMIT_BYTES + 200)
  })
})
