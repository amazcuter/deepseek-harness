/**
 * Child-environment assembly: the inherited scrub, the UTF-8 triple, the
 * virtual-environment entries, and the caller's overrides.
 */

import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  PYTHON_ENVIRONMENT,
  prependSearchPath,
  pythonChildEnvironment,
  readEnvironmentEntry,
  removeEnvironmentEntry,
  setEnvironmentEntry,
  venvScriptsDirectory,
} from '../src/env.ts'

const restored: Array<[string, string | undefined]> = []

afterEach(() => {
  for (const [name, value] of restored.splice(0)) {
    if (value === undefined) Reflect.deleteProperty(process.env, name)
    else process.env[name] = value
  }
})

/** Set one parent variable and remember how to restore it. */
function setParent(name: string, value: string): void {
  restored.push([name, process.env[name]])
  process.env[name] = value
}

describe('venvScriptsDirectory', () => {
  it('uses Scripts on Windows and bin elsewhere', () => {
    expect(venvScriptsDirectory(join('/p', '.venv'), 'win32')).toBe(join('/p', '.venv', 'Scripts'))
    expect(venvScriptsDirectory(join('/p', '.venv'), 'linux')).toBe(join('/p', '.venv', 'bin'))
  })
})

describe('environment entry helpers', () => {
  it('replaces a differently-cased spelling instead of adding a second name', () => {
    const environment: Record<string, string> = { Path: 'inherited' }
    setEnvironmentEntry(environment, 'PATH', 'replaced')
    expect(environment).toEqual({ PATH: 'replaced' })
  })

  it('keeps the requested spelling when no variant exists', () => {
    const environment: Record<string, string> = {}
    setEnvironmentEntry(environment, 'PATH', 'only')
    expect(environment).toEqual({ PATH: 'only' })
  })

  it('removes a differently-cased spelling', () => {
    const environment: Record<string, string> = { Path: 'inherited', OTHER: 'kept' }
    removeEnvironmentEntry(environment, 'PATH')
    expect(environment).toEqual({ OTHER: 'kept' })
  })

  it('reads a differently-cased spelling', () => {
    expect(readEnvironmentEntry({ Path: 'inherited' }, 'PATH')).toBe('inherited')
    expect(readEnvironmentEntry({}, 'PATH')).toBeUndefined()
  })
})

describe('prependSearchPath', () => {
  it('becomes the whole search path when none exists', () => {
    const environment: Record<string, string> = {}
    prependSearchPath(environment, '/venv/bin', ':')
    expect(environment).toEqual({ PATH: '/venv/bin' })
  })

  it('becomes the whole search path when the existing one is empty', () => {
    const environment: Record<string, string> = { PATH: '' }
    prependSearchPath(environment, '/venv/bin', ';')
    expect(environment).toEqual({ PATH: '/venv/bin' })
  })

  it('leads an existing search path', () => {
    const environment: Record<string, string> = { PATH: '/usr/bin' }
    prependSearchPath(environment, '/venv/bin', ':')
    expect(environment).toEqual({ PATH: '/venv/bin:/usr/bin' })
  })
})

describe('pythonChildEnvironment', () => {
  it('always carries the UTF-8 stdio triple', () => {
    const environment = pythonChildEnvironment({})
    expect(environment).toMatchObject(PYTHON_ENVIRONMENT)
  })

  it('never forwards a credential-shaped parent name implicitly', () => {
    setParent('PYTHON_RUNNER_TEST_API_KEY', 'leaked')
    setParent('MWF_TEST_SERVICE_VALUE', 'harness')
    setParent('PYTHON_RUNNER_TEST_SAFE_VALUE', 'kept')
    const environment = pythonChildEnvironment({})
    expect(environment['PYTHON_RUNNER_TEST_API_KEY']).toBeUndefined()
    expect(environment['MWF_TEST_SERVICE_VALUE']).toBeUndefined()
    expect(environment['PYTHON_RUNNER_TEST_SAFE_VALUE']).toBe('kept')
  })

  it('puts a virtual environment on VIRTUAL_ENV and in front of PATH', () => {
    const environment = pythonChildEnvironment({ virtualEnv: join('/p', '.venv'), platform: 'linux' })
    expect(environment['VIRTUAL_ENV']).toBe(join('/p', '.venv'))
    const scripts = venvScriptsDirectory(join('/p', '.venv'), 'linux')
    expect(environment['PATH']?.startsWith(`${scripts}:`)).toBe(true)
  })

  it('uses the Windows separator and layout for a Windows child', () => {
    const environment = pythonChildEnvironment({ virtualEnv: join('C:', 'p', '.venv'), platform: 'win32' })
    const scripts = venvScriptsDirectory(join('C:', 'p', '.venv'), 'win32')
    expect(environment['PATH']?.startsWith(`${scripts};`)).toBe(true)
  })

  it('applies caller entries last and removes a name mapped to undefined', () => {
    const environment = pythonChildEnvironment({
      platform: 'linux',
      env: { PYTHONUTF8: '0', MWF_TEST_CALLER_VALUE: 'yes', MWF_TEST_REMOVED: undefined },
    })
    expect(environment['PYTHONUTF8']).toBe('0')
    expect(environment['MWF_TEST_CALLER_VALUE']).toBe('yes')
    expect(environment['MWF_TEST_REMOVED']).toBeUndefined()
  })

  it('defaults to the host platform', () => {
    const environment = pythonChildEnvironment({ virtualEnv: join('/p', '.venv') })
    const scripts = venvScriptsDirectory(join('/p', '.venv'), process.platform)
    expect(environment['PATH']?.startsWith(`${scripts}${process.platform === 'win32' ? ';' : ':'}`)).toBe(true)
  })
})
