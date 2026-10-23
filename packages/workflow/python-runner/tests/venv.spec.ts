/**
 * Virtual-environment layout and requirement installation.
 *
 * Branches are pinned with injected dependencies, so both platforms' layouts
 * and every failure path are exercised without a real interpreter. The host
 * filesystem cases prove the existence check; the real `.venv` creation runs in
 * the service suite, which needs an interpreter anyway.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { CommandOptions, CommandOutcome } from '../src/command.ts'
import { PythonRunnerError } from '../src/errors.ts'
import type { InterpreterSpec } from '../src/types.ts'
import {
  INSTALL_FAILURE_DETAIL_LIMIT,
  VENV_DIRECTORY_NAME,
  VenvManager,
  fileExists,
  installFailureMessage,
  venvDirectory,
  venvPythonPath,
} from '../src/venv.ts'
import type { VenvDependencies } from '../src/venv.ts'

const BASE: InterpreterSpec = { path: '/usr/bin/python3', version: '3.12.1', source: 'explicit' }

const directories: string[] = []

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

/** One outcome a fake helper command reports. */
function outcome(overrides: Partial<CommandOutcome> = {}): CommandOutcome {
  return { ok: true, exitCode: 0, stdout: '', stderr: '', ...overrides }
}

interface FakeState {
  pythonExists: boolean
  readonly runs: Array<{ command: string; args: readonly string[]; options: CommandOptions }>
}

/**
 * Manager whose interpreter existence and helper commands are controlled by the test.
 * @param run - outcome producer for one helper command.
 * @returns the manager and the observable state.
 */
function fakeManager(
  run: (command: string, args: readonly string[], options: CommandOptions, state: FakeState) => CommandOutcome,
): { manager: VenvManager; state: FakeState } {
  const state: FakeState = { pythonExists: false, runs: [] }
  const dependencies: VenvDependencies = {
    platform: 'linux',
    installTimeoutMs: 1234,
    fileExists: async () => state.pythonExists,
    run: async (command, args, options) => {
      state.runs.push({ command, args, options })
      return run(command, args, options, state)
    },
  }
  return { manager: new VenvManager(dependencies), state }
}

describe('layout', () => {
  it('names the environment directory and its interpreter on both platforms', () => {
    expect(venvDirectory('/project')).toBe(join('/project', VENV_DIRECTORY_NAME))
    expect(venvPythonPath('/project/.venv', 'linux')).toBe(join('/project/.venv', 'bin', 'python'))
    expect(venvPythonPath('/project/.venv', 'win32')).toBe(join('/project/.venv', 'Scripts', 'python.exe'))
  })
})

describe('fileExists', () => {
  it('accepts a file and rejects a missing path or a directory', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'mwf-python-runner-fs-'))
    directories.push(directory)
    const file = join(directory, 'python')
    writeFileSync(file, '')
    expect(await fileExists(file)).toBe(true)
    expect(await fileExists(join(directory, 'absent'))).toBe(false)
    mkdirSync(join(directory, 'folder'))
    expect(await fileExists(join(directory, 'folder'))).toBe(false)
  })
})

describe('installFailureMessage', () => {
  it("quotes pip's stderr", () => {
    const message = installFailureMessage(['pandas==2.0'], outcome({ ok: false, exitCode: 1, stderr: 'No matching distribution' }))
    expect(message).toContain('pandas==2.0')
    expect(message).toContain('exit 1')
    expect(message).toContain('No matching distribution')
  })

  it('falls back to stdout when stderr is silent', () => {
    expect(installFailureMessage(['x'], outcome({ ok: false, exitCode: 2, stdout: 'from stdout' }))).toContain('from stdout')
  })

  it('keeps only the tail of a long diagnostic', () => {
    const detail = `${'a'.repeat(INSTALL_FAILURE_DETAIL_LIMIT)}TAIL`
    const message = installFailureMessage(['x'], outcome({ ok: false, stderr: detail }))
    expect(message).toContain('TAIL')
    expect(message).not.toContain(`a${'a'.repeat(INSTALL_FAILURE_DETAIL_LIMIT)}`)
  })

  it('says so when pip printed nothing', () => {
    expect(installFailureMessage(['x'], outcome({ ok: false, exitCode: null }))).toContain('pip printed no diagnostic')
  })
})

describe('VenvManager.ensure', () => {
  it('reuses an existing environment', async () => {
    const { manager, state } = fakeManager(() => outcome())
    state.pythonExists = true
    await expect(manager.ensure('/project', BASE)).resolves.toBe(venvPythonPath(venvDirectory('/project'), 'linux'))
    expect(state.runs).toEqual([])
  })

  it('creates the environment with the base interpreter', async () => {
    const { manager, state } = fakeManager((_command, _args, _options, current) => {
      current.pythonExists = true
      return outcome()
    })
    await expect(manager.ensure('/project', BASE)).resolves.toBe(venvPythonPath(venvDirectory('/project'), 'linux'))
    expect(state.runs).toHaveLength(1)
    expect(state.runs[0]?.command).toBe(BASE.path)
    expect(state.runs[0]?.args).toEqual(['-m', 'venv', venvDirectory('/project')])
    expect(state.runs[0]?.options.timeoutMs).toBe(1234)
  })

  it('creates one environment for concurrent callers', async () => {
    const { manager, state } = fakeManager((_command, _args, _options, current) => {
      current.pythonExists = true
      return outcome()
    })
    const [first, second] = await Promise.all([manager.ensure('/project', BASE), manager.ensure('/project', BASE)])
    expect(first).toBe(second)
    expect(state.runs).toHaveLength(1)
  })

  it('reports a failed creation with the quoted diagnostic', async () => {
    const { manager } = fakeManager(() => outcome({ ok: false, exitCode: 1, stderr: 'ensurepip is missing' }))
    await expect(manager.ensure('/project', BASE)).rejects.toThrow('ensurepip is missing')
    await expect(manager.ensure('/project', BASE)).rejects.toMatchObject({ code: 'venv/create-failed' })
  })

  it('reports a creation that produced no interpreter', async () => {
    const { manager } = fakeManager(() => outcome())
    await expect(manager.ensure('/project', BASE)).rejects.toThrow('no interpreter exists')
  })

  it('keeps the queue usable after a failure', async () => {
    let attempt = 0
    const { manager, state } = fakeManager((_command, _args, _options, current) => {
      attempt += 1
      if (attempt === 1) return outcome({ ok: false, exitCode: 1, stderr: 'first attempt failed' })
      current.pythonExists = true
      return outcome()
    })
    await expect(manager.ensure('/project', BASE)).rejects.toBeInstanceOf(PythonRunnerError)
    await expect(manager.ensure('/project', BASE)).resolves.toBe(venvPythonPath(venvDirectory('/project'), 'linux'))
    expect(state.runs).toHaveLength(2)
  })
})

describe('VenvManager.install', () => {
  it('installs nothing for an empty requirement list', async () => {
    const { manager, state } = fakeManager(() => outcome())
    await expect(manager.install('/project', BASE, [])).resolves.toMatchObject({ ok: true, exitCode: 0 })
    expect(state.runs).toEqual([])
  })

  it('installs binaries into the environment', async () => {
    const { manager, state } = fakeManager((_command, _args, _options, current) => {
      current.pythonExists = true
      return outcome({ stdout: 'installed' })
    })
    const result = await manager.install('/project', BASE, ['pandas==2.0'])
    expect(result).toMatchObject({ ok: true, stdout: 'installed' })
    const pip = state.runs.at(-1)
    expect(pip?.command).toBe(venvPythonPath(venvDirectory('/project'), 'linux'))
    expect(pip?.args).toEqual(['-m', 'pip', 'install', '--only-binary=:all:', 'pandas==2.0'])
    expect(pip?.options.env['VIRTUAL_ENV']).toBe(venvDirectory('/project'))
  })

  it('reports a refused wheel as a structured failure', async () => {
    const { manager } = fakeManager((_command, args, _options, current) => {
      if (args[0] === '-m' && args[1] === 'venv') {
        current.pythonExists = true
        return outcome()
      }
      return outcome({ ok: false, exitCode: 1, stderr: 'No matching distribution found' })
    })
    const result = await manager.install('/project', BASE, ['not-a-real-package'])
    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe('install/failed')
    expect(result.error?.message).toContain('No matching distribution found')
    expect(result.exitCode).toBe(1)
  })
})
