/**
 * One helper command with captured, capped output.
 *
 * Interpreter probing, `.venv` creation, and `pip install` all run through
 * here, so each of them inherits the same byte caps and the same "a killed
 * command is a failed command" rule.
 *
 * @module @metaworkflow/workflow-python-runner/command
 */

import { spawn } from 'node:child_process'
import type { ChildProcessByStdio } from 'node:child_process'
import type { Readable } from 'node:stream'
import { CappedStream } from './output.ts'

/** Byte cap for each captured stream of one helper command. */
export const COMMAND_OUTPUT_LIMIT_BYTES = 64 * 1024

/** How one helper command runs. */
export interface CommandOptions {
  /** Complete child environment; the caller assembles it. */
  readonly env: Readonly<Record<string, string>>
  /** Working directory; omitted inherits the host process directory. */
  readonly cwd?: string
  /** Deadline after which the command is killed and reported as failed. */
  readonly timeoutMs: number
}

/** What one helper command produced. */
export interface CommandOutcome {
  /** Whether the command started and exited zero within its deadline. */
  readonly ok: boolean
  /** Exit code, or `null` when the command never started or was killed on timeout. */
  readonly exitCode: number | null
  /** Captured stdout, head-capped at {@link COMMAND_OUTPUT_LIMIT_BYTES}. */
  readonly stdout: string
  /** Captured stderr, tail-capped at {@link COMMAND_OUTPUT_LIMIT_BYTES}. */
  readonly stderr: string
  /** Spawn or deadline failure, absent for a clean run. */
  readonly failure?: string
}

/**
 * Run one helper command to completion.
 * @param command - executable path or bare PATH name.
 * @param args - arguments, passed without a shell.
 * @param options - environment, working directory, and deadline.
 * @returns the exit facts and captured output; a spawn failure resolves rather than rejects.
 */
export async function runCommand(command: string, args: readonly string[], options: CommandOptions): Promise<CommandOutcome> {
  // The annotated target selects the spawn overload whose piped streams are non-null.
  const child: ChildProcessByStdio<null, Readable, Readable> = spawn(command, [...args], {
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    env: options.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  const stdout = new CappedStream(COMMAND_OUTPUT_LIMIT_BYTES, 'head')
  const stderr = new CappedStream(COMMAND_OUTPUT_LIMIT_BYTES, 'tail')
  return await new Promise<CommandOutcome>((resolve) => {
    let settled = false
    let timedOut = false
    const finish = (outcome: CommandOutcome): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(outcome)
    }
    const timer = setTimeout(() => {
      timedOut = true
      child.kill()
    }, options.timeoutMs)
    child.stdout.on('data', (chunk: Buffer) => {
      stdout.push(chunk)
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr.push(chunk)
    })
    child.on('error', (error: Error) => {
      finish({ ok: false, exitCode: null, stdout: '', stderr: error.message, failure: error.message })
    })
    child.on('close', (code: number | null) => {
      finish({
        ok: !timedOut && code === 0,
        exitCode: code,
        stdout: stdout.text(),
        stderr: stderr.text(),
        ...(timedOut ? { failure: `command exceeded ${options.timeoutMs} ms` } : {}),
      })
    })
  })
}
