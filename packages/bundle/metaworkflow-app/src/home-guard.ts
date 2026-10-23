/**
 * Home isolation guard for the MetaWorkFlow profile. The profile owns its
 * projects, Sessions, and settings, so startup refuses to run on the shared
 * Harness home (`~/.mwf`) or the pre-rename home (`~/.dsh`): either would mix
 * this product's data with another surface's. Any other explicit
 * `MWF_HOME` is accepted.
 * @module @metaworkflow/app/home-guard
 */

import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { MWF_HOME_ENV, resolveMwfHome } from '@metaworkflow/home-paths'

/** Why the resolved home cannot be used by this profile. */
export type HomeIsolationFailure =
  | {
    /** `MWF_HOME` was unset or blank, so the default home would apply. */
    readonly kind: 'unset'
    /** The home the launch resolved to. */
    readonly resolved: string
  }
  | {
    /** `MWF_HOME` resolves to one of the shared Harness homes. */
    readonly kind: 'shared'
    /** The shared home the launch resolved to. */
    readonly resolved: string
  }

/** Result of checking this profile's home isolation. */
export type HomeIsolation =
  | { readonly ok: true; readonly home: string }
  | { readonly ok: false; readonly failure: HomeIsolationFailure }

/** Directory names under the user's home that belong to the shared Harness. */
const SHARED_HOME_DIRECTORIES = ['.mwf', '.dsh'] as const

/** Depth from a package entry (`src/` or `lib/`) to the checkout root. */
const CHECKOUT_DEPTH = '../../../../'

/**
 * Compare two filesystem paths, folding case so a near-duplicate spelling of a
 * shared home is refused as well; refusing startup is the safe outcome.
 * @param left - first path.
 * @param right - second path.
 * @returns whether both name the same directory for this guard's purpose.
 */
function samePath(left: string, right: string): boolean {
  const a = resolve(left)
  const b = resolve(right)
  return a === b || a.toLowerCase() === b.toLowerCase()
}

/**
 * Check whether this launch uses a home of its own.
 * @param env - environment mapping that supplies `MWF_HOME`.
 * @param home - the user's home directory, which owns the shared homes.
 * @returns the accepted home, or the reason startup must refuse.
 */
export function checkHomeIsolation(
  env: Record<string, string | undefined> = process.env,
  home: string = homedir(),
): HomeIsolation {
  const configured = env[MWF_HOME_ENV]
  const resolved = resolveMwfHome(undefined, env)
  if (configured === undefined || configured.trim() === '') {
    return { ok: false, failure: { kind: 'unset', resolved } }
  }
  if (SHARED_HOME_DIRECTORIES.some(name => samePath(resolved, join(home, name)))) {
    return { ok: false, failure: { kind: 'shared', resolved } }
  }
  return { ok: true, home: resolved }
}

/**
 * Locate the checkout that owns this package, so the printed fix command names
 * a real path. The entry sits one level under the package root in both the
 * source and the built tree.
 * @param candidates - directories to inspect, most specific first.
 * @returns the first candidate containing a pnpm workspace manifest, or undefined.
 */
export function checkoutRoot(
  candidates: readonly string[] = [fileURLToPath(new URL(CHECKOUT_DEPTH, import.meta.url)), process.cwd()],
): string | undefined {
  return candidates.find(candidate => existsSync(join(candidate, 'pnpm-workspace.yaml')))
}

/** Directory this profile owns inside a checkout. */
const ISOLATED_HOME_DIRECTORY = '.mwf-home'

/**
 * Compute the home the printed fix command should set.
 * @param checkout - the checkout that owns this package; undefined prints the
 * documented `<repo>` placeholder instead of a machine-specific path.
 * @returns the absolute repository-local home, or the placeholder form.
 */
export function fixTarget(checkout: string | undefined): string {
  return join(checkout ?? '<repo>', ISOLATED_HOME_DIRECTORY)
}

/**
 * Render the startup refusal, including the command that fixes it.
 * @param failure - the rejected home from {@link checkHomeIsolation}.
 * @param checkout - the checkout that owns this package; omitted resolves it.
 * @returns the multi-line diagnostic startup prints.
 */
export function homeIsolationMessage(failure: HomeIsolationFailure, checkout: string | undefined = checkoutRoot()): string {
  const reason = failure.kind === 'unset'
    ? `${MWF_HOME_ENV} is unset, so this launch would use the shared Harness home ${failure.resolved}`
    : `${MWF_HOME_ENV} resolves to ${failure.resolved}, a shared Harness home`
  const target = fixTarget(checkout)
  return [
    `metaworkflow-app: refusing to start: ${reason}.`,
    'The metaworkflow profile keeps its projects, Sessions, and settings in its own home so it never reads or writes another product\'s data.',
    'Set the home for this terminal before launching (PowerShell):',
    `  $env:${MWF_HOME_ENV} = "${target}"`,
    'Then run the same command again.',
  ].join('\n')
}

/**
 * Refuse startup unless the launch uses a home of its own.
 * @param env - environment mapping that supplies `MWF_HOME`.
 * @param home - the user's home directory, which owns the shared homes.
 * @throws {Error} with the actionable fix command when the home is unset or shared.
 */
export function assertIsolatedHome(
  env: Record<string, string | undefined> = process.env,
  home: string = homedir(),
): void {
  const isolation = checkHomeIsolation(env, home)
  if (!isolation.ok) throw new Error(homeIsolationMessage(isolation.failure))
}
