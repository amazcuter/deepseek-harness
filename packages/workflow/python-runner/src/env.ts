/**
 * Child environments for interpreter probing, virtual-environment commands,
 * and node runs.
 *
 * Two layers are fixed here and no caller can skip them: the harness scrub
 * inherited from `@metaworkflow/subprocess` (credential-shaped and `MWF_*`
 * names never reach a child implicitly), and the UTF-8 stdio triple without
 * which a Windows Python child writes GBK and raises on emoji. The caller's
 * explicit entries merge last, so a deliberate override wins.
 *
 * @module @metaworkflow/workflow-python-runner/env
 */

import { join } from 'node:path'
import { scrubbedParentEnv } from '@metaworkflow/subprocess'

/**
 * Environment entries every Python child receives.
 *
 * `PYTHONUTF8` and `PYTHONIOENCODING` fix stdio and the filesystem encoding;
 * `PYTHONUNBUFFERED` keeps a killed process's last log lines.
 */
export const PYTHON_ENVIRONMENT: Readonly<Record<string, string>> = {
  PYTHONUTF8: '1',
  PYTHONIOENCODING: 'utf-8',
  PYTHONUNBUFFERED: '1',
}

/** How one child environment is assembled. */
export interface ChildEnvironmentOptions {
  /** Virtual environment root whose `bin`/`Scripts` directory leads `PATH` and fills `VIRTUAL_ENV`. */
  readonly virtualEnv?: string
  /** Caller entries merged last; `undefined` removes a name. */
  readonly env?: Readonly<Record<string, string | undefined>>
  /** Platform that decides the directory layout and `PATH` separator. */
  readonly platform?: NodeJS.Platform
}

/**
 * Directory inside a virtual environment that holds its executables.
 * @param venvDir - virtual environment root.
 * @param platform - platform whose layout applies.
 * @returns `<venvDir>/Scripts` on Windows and `<venvDir>/bin` elsewhere.
 */
export function venvScriptsDirectory(venvDir: string, platform: NodeJS.Platform): string {
  return join(venvDir, platform === 'win32' ? 'Scripts' : 'bin')
}

/**
 * Environment name that already carries a value, matched case-insensitively.
 * @param environment - environment object to search.
 * @param name - requested spelling.
 * @returns the existing spelling, or `name` itself.
 */
function existingName(environment: Readonly<Record<string, string>>, name: string): string {
  const upper = name.toUpperCase()
  return Object.keys(environment).find(key => key.toUpperCase() === upper) ?? name
}

/**
 * Set one environment entry, replacing a differently-cased spelling of the same name.
 *
 * Windows treats environment names case-insensitively, so writing `PATH` next
 * to an inherited `Path` would otherwise leave one of the two meaningless.
 * @param environment - environment object to update in place.
 * @param name - entry name to set.
 * @param value - entry value.
 * @returns nothing.
 */
export function setEnvironmentEntry(environment: Record<string, string>, name: string, value: string): void {
  Reflect.deleteProperty(environment, existingName(environment, name))
  environment[name] = value
}

/**
 * Remove one environment entry, including a differently-cased spelling.
 * @param environment - environment object to update in place.
 * @param name - entry name to remove.
 * @returns nothing.
 */
export function removeEnvironmentEntry(environment: Record<string, string>, name: string): void {
  Reflect.deleteProperty(environment, existingName(environment, name))
}

/**
 * Read one environment entry, including a differently-cased spelling.
 * @param environment - environment object to search.
 * @param name - entry name to read.
 * @returns the value, or `undefined` when the name is absent.
 */
export function readEnvironmentEntry(environment: Readonly<Record<string, string>>, name: string): string | undefined {
  return environment[existingName(environment, name)]
}

/**
 * Put one directory in front of the search path.
 * @param environment - environment object to update in place.
 * @param directory - absolute directory to prepend.
 * @param separator - `;` on Windows, `:` elsewhere.
 * @returns nothing.
 */
export function prependSearchPath(environment: Record<string, string>, directory: string, separator: string): void {
  const current = readEnvironmentEntry(environment, 'PATH')
  setEnvironmentEntry(environment, 'PATH', current === undefined || current === '' ? directory : `${directory}${separator}${current}`)
}

/**
 * Assemble the complete environment of one Python child.
 * @param options - virtual environment, caller overrides, and platform.
 * @returns a fresh environment object safe to hand to a spawn.
 */
export function pythonChildEnvironment(options: ChildEnvironmentOptions): Record<string, string> {
  const platform = options.platform ?? process.platform
  const environment = scrubbedParentEnv()
  for (const [name, value] of Object.entries(PYTHON_ENVIRONMENT)) setEnvironmentEntry(environment, name, value)
  if (options.virtualEnv !== undefined) {
    setEnvironmentEntry(environment, 'VIRTUAL_ENV', options.virtualEnv)
    prependSearchPath(environment, venvScriptsDirectory(options.virtualEnv, platform), platform === 'win32' ? ';' : ':')
  }
  for (const [name, value] of Object.entries(options.env ?? {})) {
    if (value === undefined) removeEnvironmentEntry(environment, name)
    else setEnvironmentEntry(environment, name, value)
  }
  return environment
}
