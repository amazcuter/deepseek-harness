/** Filesystem ownership for the Electron-managed desktop installation. */

import { join } from 'node:path'
import { resolveMwfHome } from '@metaworkflow/home-paths'

/** Stable desktop installation paths under the shared Harness home. */
export interface DesktopPaths {
  readonly profile: string
  readonly lock: string
}

/**
 * Resolve every Electron-owned path without changing the shared data roots.
 * @param mwfHome - Harness home shared with npm-installed mwf.
 * @returns immutable desktop path set.
 */
export function resolveDesktopPaths(mwfHome: string = resolveMwfHome()): DesktopPaths {
  return {
    profile: join(mwfHome, 'profiles', 'desktop'),
    lock: join(mwfHome, 'profiles', 'desktop', 'lock'),
  }
}
