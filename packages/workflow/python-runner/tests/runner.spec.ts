/**
 * The service against a real interpreter: value transport, every structured
 * failure, log handling, deadlines that kill a whole process tree, aborts,
 * environment assembly, and one real project virtual environment.
 *
 * These suites spawn the host interpreter; a host without a supported one skips
 * them with a named reason instead of failing.
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import PythonRunner, { PythonRunnerError } from '../src/index.ts'
import type { Config as RunnerConfig, RunNodeResult } from '../src/index.ts'
import { isProcessAlive } from '../src/terminate.ts'
import { fileExists } from '../src/venv.ts'
import { nodeDirectory } from '../src/wrapper.ts'
import { hostPython, PYTHON_SKIP_REASON } from './support/python.ts'

const runners: PythonRunner[] = []
const directories: string[] = []
const restoredEnvironment: Array<[string, string | undefined]> = []

afterEach(async () => {
  for (const [name, value] of restoredEnvironment.splice(0)) {
    if (value === undefined) Reflect.deleteProperty(process.env, name)
    else process.env[name] = value
  }
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true })
  runners.length = 0
})

/** One fresh project directory. */
async function projectDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'mwf-python-runner-'))
  directories.push(directory)
  return directory
}

/** One service instance bound to its own Cordis context. */
function runner(config?: RunnerConfig): PythonRunner {
  const instance = config === undefined ? new PythonRunner(new Context()) : new PythonRunner(new Context(), config)
  runners.push(instance)
  return instance
}

/** Build one node module source from a function name and a body. */
function nodeSource(nodeId: string, lines: readonly string[]): string {
  return [...lines, ''].join('\n').replaceAll('{{fn}}', `nodemain_${nodeId.replaceAll(/[^A-Za-z0-9_]/gu, '_')}`)
}

/** Source that sleeps past any short deadline. */
function sleepSource(nodeId: string): string {
  return nodeSource(nodeId, ['import time', '', 'def {{fn}}(inputs):', '    time.sleep(60)', '    return "null"'])
}

/** Capture the code of one refusal. */
async function refusal(run: () => Promise<unknown>): Promise<string> {
  try {
    await run()
  } catch (error: unknown) {
    if (error instanceof PythonRunnerError) return error.code
    throw error
  }
  throw new Error('expected the call to refuse')
}

describe('runNode', () => {
  it('refuses a project path that a Windows working directory cannot hold', async () => {
    const projectDir = await projectDirectory()
    const long = join(projectDir, 'p'.repeat(220))
    expect(await refusal(async () => await runner().runNode({ projectDir: long, nodeId: 'n1', source: 'x = 1' }))).toBe('project/path-too-long')
  })

  it('refuses a node id that cannot name one directory', async () => {
    const projectDir = await projectDirectory()
    expect(await refusal(async () => await runner().runNode({ projectDir, nodeId: '../escape', source: 'x = 1' }))).toBe('node/invalid-id')
  })
})

describe.skipIf(hostPython === undefined)(`runNode (${PYTHON_SKIP_REASON})`, () => {
  it('returns a value with Chinese text and an emoji', async () => {
    const projectDir = await projectDirectory()
    const source = nodeSource('ok', [
      'import json',
      '',
      'def {{fn}}(inputs):',
      '    print("日志 🎉")',
      '    return json.dumps({"echo": inputs["name"], "text": "中文 🎉"}, ensure_ascii=False)',
    ])
    const result = await runner().runNode({ projectDir, nodeId: 'ok', source, inputs: { name: '王小明' } })
    expect(result.ok).toBe(true)
    expect(result.value).toEqual({ echo: '王小明', text: '中文 🎉' })
    expect(result.stdout.trim()).toBe('日志 🎉')
    expect(result.exitCode).toBe(0)
    expect(result.timedOut).toBe(false)
    expect(result.error).toBeUndefined()
    expect(result.durationMs).toBeGreaterThanOrEqual(0)
  }, 60_000)

  it('sends null inputs when the request has none', async () => {
    const projectDir = await projectDirectory()
    const source = nodeSource('none', ['import json', '', 'def {{fn}}(inputs):', '    return json.dumps(inputs)'])
    const result = await runner().runNode({ projectDir, nodeId: 'none', source })
    expect(result.value).toBeNull()
  }, 60_000)

  it('reports a raised exception with its traceback', async () => {
    const projectDir = await projectDirectory()
    const source = nodeSource('boom', ['def {{fn}}(inputs):', '    raise RuntimeError("kaboom")'])
    const result = await runner().runNode({ projectDir, nodeId: 'boom', source })
    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe('node/exception')
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain('RuntimeError: kaboom')
  }, 60_000)

  it('reports an import failure as an exception', async () => {
    const projectDir = await projectDirectory()
    const result = await runner().runNode({ projectDir, nodeId: 'broken', source: 'def nodemain_broken(:\n' })
    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe('node/exception')
    expect(result.stderr).toContain('SyntaxError')
  }, 60_000)

  it('reports a return value that is not JSON text', async () => {
    const projectDir = await projectDirectory()
    const source = nodeSource('bad', ['def {{fn}}(inputs):', '    return "not json"'])
    const result = await runner().runNode({ projectDir, nodeId: 'bad', source })
    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe('node/invalid-return')
    expect(result.exitCode).toBe(2)
    expect(result.stderr).toContain('not JSON')
  }, 60_000)

  it('reports a return value that is not text', async () => {
    const projectDir = await projectDirectory()
    const source = nodeSource('number', ['def {{fn}}(inputs):', '    return 1'])
    const result = await runner().runNode({ projectDir, nodeId: 'number', source })
    expect(result.error?.code).toBe('node/invalid-return')
    expect(result.exitCode).toBe(2)
    expect(result.stderr).toContain('must return a str')
  }, 60_000)

  it('keeps node logs separate from the result line', async () => {
    const projectDir = await projectDirectory()
    const source = nodeSource('logs', [
      'import json',
      '',
      'def {{fn}}(inputs):',
      '    print("before")',
      '    print("__MWF_RESULT__ looks like a result")',
      '    print("after")',
      '    return json.dumps({"ok": True})',
    ])
    const result = await runner().runNode({ projectDir, nodeId: 'logs', source })
    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe('node/invalid-return')
    expect(result.error?.message).toContain('2 result lines')
  }, 60_000)

  it('captures ordinary logs without leaking the result line', async () => {
    const projectDir = await projectDirectory()
    const source = nodeSource('quiet', [
      'import json',
      '',
      'def {{fn}}(inputs):',
      '    print("only a log")',
      '    return json.dumps({"ok": True})',
    ])
    const result = await runner().runNode({ projectDir, nodeId: 'quiet', source })
    expect(result.ok).toBe(true)
    expect(result.stdout).toBe('only a log\n')
  }, 60_000)

  it('reports a node that exits without printing a result', async () => {
    const projectDir = await projectDirectory()
    const source = nodeSource('exit', ['import os', '', 'def {{fn}}(inputs):', '    os._exit(0)', '    return "null"'])
    const result = await runner().runNode({ projectDir, nodeId: 'exit', source })
    expect(result.error?.code).toBe('node/invalid-return')
    expect(result.error?.message).toContain('without printing a result')
  }, 60_000)

  it('caps stdout and keeps the value intact', async () => {
    const projectDir = await projectDirectory()
    const source = nodeSource('flood', [
      'import json',
      '',
      'def {{fn}}(inputs):',
      '    print("x" * 5000)',
      '    return json.dumps({"ok": True})',
    ])
    const result = await runner().runNode({ projectDir, nodeId: 'flood', source, maxStdoutBytes: 1024 })
    expect(result.ok).toBe(true)
    expect(result.stdout).toContain('truncated from the end')
    expect(result.value).toEqual({ ok: true })
  }, 60_000)

  it('keeps the tail of stderr', async () => {
    const projectDir = await projectDirectory()
    const source = nodeSource('noisy', [
      'import sys',
      '',
      'def {{fn}}(inputs):',
      '    sys.stderr.write("FIRST-MARK" + "a" * 5000 + "LAST-MARK\\n")',
      '    raise RuntimeError("after the noise")',
    ])
    const result = await runner().runNode({ projectDir, nodeId: 'noisy', source, maxStderrBytes: 1024 })
    expect(result.stderr).toContain('LAST-MARK')
    expect(result.stderr).not.toContain('FIRST-MARK')
    expect(result.stderr).toContain('truncated from the start')
  }, 60_000)

  it('kills the node and its child when the deadline expires', async () => {
    const projectDir = await projectDirectory()
    const source = nodeSource('tree', [
      'import subprocess',
      'import sys',
      'import time',
      '',
      'def {{fn}}(inputs):',
      '    child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(120)"])',
      '    with open("wrapped.pid", "w") as handle:',
      '        handle.write(str(child.pid))',
      '    time.sleep(120)',
      '    return "null"',
    ])
    const result = await runner().runNode({ projectDir, nodeId: 'tree', source, timeoutMs: 3000 })
    expect(result.ok).toBe(false)
    expect(result.timedOut).toBe(true)
    expect(result.error?.code).toBe('node/timeout')
    const grandchild = Number((await readFile(join(nodeDirectory(projectDir, 'tree'), 'wrapped.pid'), 'utf8')).trim())
    expect(grandchild).toBeGreaterThan(0)
    await expect.poll(() => isProcessAlive(grandchild), { timeout: 15_000, interval: 100 }).toBe(false)
  }, 120_000)

  it('terminates the tree when the caller aborts', async () => {
    const projectDir = await projectDirectory()
    const controller = new AbortController()
    const pending = runner().runNode({
      projectDir,
      nodeId: 'aborted',
      source: sleepSource('aborted'),
      timeoutMs: 60_000,
      signal: controller.signal,
    })
    setTimeout(() => {
      controller.abort()
    }, 300)
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  }, 120_000)

  it('wraps an abort reason that is not an error', async () => {
    const projectDir = await projectDirectory()
    const controller = new AbortController()
    const pending = runner().runNode({
      projectDir,
      nodeId: 'aborted-value',
      source: sleepSource('aborted_value'),
      timeoutMs: 60_000,
      signal: controller.signal,
    })
    setTimeout(() => {
      controller.abort('stop now')
    }, 300)
    await expect(pending).rejects.toThrow('node run aborted: stop now')
  }, 120_000)

  it('refuses an already-aborted run without starting a process', async () => {
    const projectDir = await projectDirectory()
    const controller = new AbortController()
    controller.abort()
    await expect(runner().runNode({
      projectDir,
      nodeId: 'pre-aborted',
      source: sleepSource('pre_aborted'),
      signal: controller.signal,
    })).rejects.toMatchObject({ name: 'AbortError' })
    expect(await fileExists(nodeDirectory(projectDir, 'pre-aborted'))).toBe(false)
  }, 60_000)

  it('forwards caller environment entries and nothing credential-shaped', async () => {
    const projectDir = await projectDirectory()
    restoredEnvironment.push(['MWF_RUNNER_TEST_TOKEN', process.env['MWF_RUNNER_TEST_TOKEN']])
    restoredEnvironment.push(['RUNNER_TEST_API_KEY', process.env['RUNNER_TEST_API_KEY']])
    process.env['MWF_RUNNER_TEST_TOKEN'] = 'harness-secret'
    process.env['RUNNER_TEST_API_KEY'] = 'parent-secret'
    const source = nodeSource('env', [
      'import json',
      'import os',
      '',
      'def {{fn}}(inputs):',
      '    return json.dumps({',
      '        "value": os.environ.get("RUNNER_TEST_VALUE", ""),',
      '        "token": os.environ.get("MWF_RUNNER_TEST_TOKEN", ""),',
      '        "key": os.environ.get("RUNNER_TEST_API_KEY", ""),',
      '    })',
    ])
    const result = await runner().runNode({ projectDir, nodeId: 'env', source, env: { RUNNER_TEST_VALUE: 'set' } })
    expect(result.value).toEqual({ value: 'set', token: '', key: '' })
  }, 60_000)
})

describe('resolveInterpreter', () => {
  it('resolves the host interpreter through the probe tier', async () => {
    const spec = await runner().resolveInterpreter()
    expect(spec.source).toBe('probe')
    expect(spec.version).toMatch(/^3\.(?:1[0-4])\./u)
  }, 60_000)

  it('honors an explicit path', async () => {
    const spec = await runner().resolveInterpreter({ interpreterPath: hostPython!.executable })
    expect(spec).toMatchObject({ source: 'explicit', path: hostPython!.executable })
  }, 60_000)

  it('falls back to the configured path', async () => {
    const spec = await runner({ interpreterPath: hostPython!.executable }).resolveInterpreter()
    expect(spec.source).toBe('config')
  }, 60_000)

  it('refuses a path that does not exist', async () => {
    expect(await refusal(async () => await runner().resolveInterpreter({ interpreterPath: join(await projectDirectory(), 'absent-python') }))).toBe('python/not-found')
  }, 60_000)
})

describe.skipIf(hostPython === undefined)('project environments', () => {
  it('creates one environment, reuses it, and runs nodes from it', async () => {
    const projectDir = await projectDirectory()
    const service = runner()
    const pythonPath = await service.ensureVenv(projectDir)
    expect(pythonPath).toBe(join(projectDir, '.venv', process.platform === 'win32' ? join('Scripts', 'python.exe') : join('bin', 'python')))
    expect(await fileExists(pythonPath)).toBe(true)
    await expect(service.ensureVenv(projectDir)).resolves.toBe(pythonPath)
    const source = nodeSource('venv', ['import json', '', 'def {{fn}}(inputs):', '    return json.dumps({"python": __import__("sys").version_info[1]})'])
    const result: RunNodeResult = await service.runNode({ projectDir, nodeId: 'venv', source })
    expect(result.ok).toBe(true)
    expect((result.value as { python: number }).python).toBeGreaterThanOrEqual(10)
  }, 180_000)

  it('installs nothing for an empty requirement list', async () => {
    const projectDir = await projectDirectory()
    await expect(runner().installRequirements(projectDir, [])).resolves.toMatchObject({ ok: true, exitCode: 0, stdout: '' })
  }, 60_000)

  it('reports a requirement that publishes no binary wheel', async () => {
    const projectDir = await projectDirectory()
    const result = await runner().installRequirements(projectDir, ['mwf-python-runner-missing-wheel-9f8e7d'])
    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe('install/failed')
    expect(result.error?.message).toContain('--only-binary=:all:')
  }, 180_000)

  it('refuses an over-long project path before touching the environment', async () => {
    const projectDir = await projectDirectory()
    expect(await refusal(async () => await runner().ensureVenv(join(projectDir, 'p'.repeat(220))))).toBe('project/path-too-long')
  })
})
