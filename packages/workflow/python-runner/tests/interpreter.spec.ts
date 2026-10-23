/**
 * Interpreter precedence, version validation, and probe parsing.
 *
 * Precedence and refusals are pinned with an injected probe so both platforms'
 * launchers and every rejection are exercised without an installed Python. One
 * real probe of the host interpreter proves the program itself.
 */

import { describe, expect, it } from 'vitest'
import { PythonRunnerError } from '../src/errors.ts'
import {
  MAX_SUPPORTED_MINOR,
  MIN_SUPPORTED_MINOR,
  assertSupportedInterpreter,
  candidateLabel,
  formatVersion,
  interpreterCandidates,
  interpreterFromPath,
  parseProbeOutput,
  probeInterpreter,
  resolveInterpreter,
} from '../src/interpreter.ts'
import type { InterpreterCandidate, InterpreterDependencies, ProbeResult } from '../src/interpreter.ts'
import { venvDirectory, venvPythonPath } from '../src/venv.ts'
import { hostPython } from './support/python.ts'

/** One probe report. */
function probe(overrides: Partial<ProbeResult> = {}): ProbeResult {
  return { executable: '/usr/bin/python3', major: 3, minor: 12, micro: 1, freeThreaded: false, ...overrides }
}

/** Dependencies whose probe answers from a table. */
function dependencies(overrides: Partial<InterpreterDependencies> = {}): InterpreterDependencies {
  return {
    platform: 'linux',
    exists: async () => true,
    probe: async () => probe(),
    ...overrides,
  }
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

describe('interpreterCandidates', () => {
  it('tries the Windows launcher before python', () => {
    expect(interpreterCandidates('win32').map(candidateLabel)).toEqual(['py -3', 'python'])
  })

  it('uses python3 elsewhere', () => {
    expect(interpreterCandidates('linux').map(candidateLabel)).toEqual(['python3'])
  })

  it('renders a candidate with its leading arguments', () => {
    expect(candidateLabel({ command: 'py', args: ['-3'] })).toBe('py -3')
  })
})

describe('parseProbeOutput', () => {
  it('reads the last report line', () => {
    expect(parseProbeOutput('3.12.1\t0\t/usr/bin/python3\n')).toEqual({ executable: '/usr/bin/python3', major: 3, minor: 12, micro: 1, freeThreaded: false })
  })

  it('flags a free-threaded build', () => {
    expect(parseProbeOutput('3.14.0\t1\tC:\\Python314t\\python.exe')?.freeThreaded).toBe(true)
  })

  it('rejects empty output', () => {
    expect(parseProbeOutput('  \n')).toBeUndefined()
  })

  it('rejects the wrong number of columns', () => {
    expect(parseProbeOutput('3.12.1\t0')).toBeUndefined()
  })

  it('rejects a malformed version', () => {
    expect(parseProbeOutput('3.12\t0\t/usr/bin/python3')).toBeUndefined()
  })

  it('rejects a malformed free-threaded flag', () => {
    expect(parseProbeOutput('3.12.1\tyes\t/usr/bin/python3')).toBeUndefined()
  })
})

describe('formatVersion', () => {
  it('renders all three components', () => {
    expect(formatVersion(probe({ major: 3, minor: 10, micro: 4 }))).toBe('3.10.4')
  })
})

describe('assertSupportedInterpreter', () => {
  it('accepts the oldest and newest supported versions', () => {
    expect(() => {
      assertSupportedInterpreter(probe({ minor: MIN_SUPPORTED_MINOR }), 'x')
    }).not.toThrow()
    expect(() => {
      assertSupportedInterpreter(probe({ minor: MAX_SUPPORTED_MINOR }), 'x')
    }).not.toThrow()
  })

  it('refuses a free-threaded build', () => {
    expect(() => {
      assertSupportedInterpreter(probe({ minor: 14, freeThreaded: true }), 'x')
    }).toThrow(/free-threaded/u)
  })

  it('refuses an unsupported version and a foreign major version', () => {
    expect(() => {
      assertSupportedInterpreter(probe({ minor: MIN_SUPPORTED_MINOR - 1 }), 'x')
    }).toThrow(/supports Python 3\.10-3\.14/u)
    expect(() => {
      assertSupportedInterpreter(probe({ minor: MAX_SUPPORTED_MINOR + 1 }), 'x')
    }).toThrow(/supports Python 3\.10-3\.14/u)
    expect(() => {
      assertSupportedInterpreter(probe({ major: 2, minor: 7 }), 'x')
    }).toThrow(/supports Python 3\.10-3\.14/u)
  })
})

describe('interpreterFromPath', () => {
  it('refuses a path that does not exist', async () => {
    expect(await refusal(async () => await interpreterFromPath('/missing', 'explicit', dependencies({ exists: async () => false })))).toBe('python/not-found')
  })

  it('refuses a path that reports nothing', async () => {
    expect(await refusal(async () => await interpreterFromPath('/silent', 'explicit', dependencies({ probe: async () => undefined })))).toBe('python/not-found')
  })

  it('returns the reported executable for a plain interpreter', async () => {
    await expect(interpreterFromPath('/usr/bin/python3', 'config', dependencies())).resolves.toEqual({
      path: '/usr/bin/python3',
      version: '3.12.1',
      source: 'config',
    })
  })

  it('records the virtual environment a path belongs to', async () => {
    await expect(interpreterFromPath('/p/.venv/bin/python', 'project-venv', dependencies(), '/p/.venv')).resolves.toEqual({
      path: '/usr/bin/python3',
      version: '3.12.1',
      source: 'project-venv',
      virtualEnv: '/p/.venv',
    })
  })
})

describe('resolveInterpreter', () => {
  it('prefers the explicit path', async () => {
    const spec = await resolveInterpreter({ interpreterPath: '/explicit/python', projectDir: '/p' }, dependencies())
    expect(spec).toMatchObject({ source: 'explicit', path: '/usr/bin/python3' })
  })

  it("prefers the project's existing environment", async () => {
    const pythonPath = venvPythonPath(venvDirectory('/p'), 'linux')
    const dependenciesWithVenv = dependencies({ exists: async path => path === pythonPath })
    await expect(resolveInterpreter({ projectDir: '/p' }, dependenciesWithVenv)).resolves.toMatchObject({
      source: 'project-venv',
      virtualEnv: venvDirectory('/p'),
    })
  })

  it('uses the configured path when the project has no environment', async () => {
    const venvPython = venvPythonPath(venvDirectory('/p'), 'linux')
    const spec = await resolveInterpreter({ projectDir: '/p' }, dependencies({ exists: async path => path !== venvPython, configuredInterpreterPath: '/configured/python' }))
    expect(spec.source).toBe('config')
  })

  it('skips a launcher that reports a free-threaded build', async () => {
    const spec = await resolveInterpreter({}, dependencies({
      platform: 'win32',
      probe: async candidate => (candidate.command === 'py' ? probe({ minor: 14, freeThreaded: true }) : probe()),
    }))
    expect(spec).toMatchObject({ source: 'probe', version: '3.12.1' })
  })

  it('reports the first structured refusal when every launcher is refused', async () => {
    expect(await refusal(async () => await resolveInterpreter({}, dependencies({ platform: 'win32', probe: async () => probe({ minor: 9 }) })))).toBe('python/unsupported-version')
    expect(await refusal(async () => await resolveInterpreter({}, dependencies({ platform: 'win32', probe: async () => probe({ freeThreaded: true }) })))).toBe('python/free-threaded')
  })

  it('probes the platform launchers when nothing is configured', async () => {
    const probed: InterpreterCandidate[] = []
    const spec = await resolveInterpreter({}, dependencies({
      platform: 'win32',
      probe: async (candidate) => {
        probed.push(candidate)
        return candidate.command === 'py' ? undefined : probe()
      },
    }))
    expect(spec.source).toBe('probe')
    expect(probed.map(candidateLabel)).toEqual(['py -3', 'python'])
  })

  it('refuses when no launcher answers', async () => {
    expect(await refusal(async () => await resolveInterpreter({}, dependencies({ probe: async () => undefined })))).toBe('python/not-found')
    expect(await refusal(async () => await resolveInterpreter({}, dependencies({ probe: async () => undefined })))).toBe('python/not-found')
  })

  it('names every launcher it tried', async () => {
    await expect(resolveInterpreter({}, dependencies({ probe: async () => undefined }))).rejects.toThrow('tried python3')
  })
})

describe.skipIf(hostPython === undefined)('probeInterpreter (real child process)', () => {
  it('reports the host interpreter facts', async () => {
    const result = await probeInterpreter({ command: hostPython!.executable, args: [] })
    expect(result?.executable).toBe(hostPython!.executable)
    expect(result?.major).toBe(3)
    expect(typeof result?.freeThreaded).toBe('boolean')
  })

  it('reports a missing launcher as unusable', async () => {
    await expect(probeInterpreter({ command: 'mwf-python-runner-missing-launcher', args: [] })).resolves.toBeUndefined()
  })
})
