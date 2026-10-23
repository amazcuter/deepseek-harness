/**
 * The MetaWorkFlow profile's home-isolation guard: the shared Harness homes are
 * refused, an explicit home is accepted, and the refusal prints the command
 * that fixes it.
 */

import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  assertIsolatedHome, checkHomeIsolation, checkoutRoot, fixTarget, homeIsolationMessage,
} from '../src/home-guard.ts'

/** Temporary fixture roots, removed after each test. */
const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** One temporary directory that outlives the test body. */
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mwf-home-guard-'))
  tempDirs.push(dir)
  return dir
}

/** A user home directory; the shared homes are matched by path, not by existence. */
function userHome(): string {
  return tempDir()
}

describe('checkHomeIsolation', () => {
  it('refuses an unset MWF_HOME and reports the shared home it would use', () => {
    const home = userHome()
    expect(checkHomeIsolation({}, home)).toEqual({
      ok: false,
      failure: { kind: 'unset', resolved: join(homedir(), '.mwf') },
    })
  })

  it('refuses a blank MWF_HOME instead of resolving it against the working directory', () => {
    const home = userHome()
    expect(checkHomeIsolation({ MWF_HOME: '   ' }, home)).toEqual({
      ok: false,
      failure: { kind: 'unset', resolved: join(homedir(), '.mwf') },
    })
  })

  it.each([
    '.mwf',
    '.dsh',
    // A case variant would be the same shared directory on Windows; refusing
    // it on every platform keeps one rule instead of a platform split.
    '.MWF',
  ])('refuses MWF_HOME=%s because it is a shared Harness home', (configured) => {
    const home = userHome()
    expect(checkHomeIsolation({ MWF_HOME: join(home, configured) }, home)).toEqual({
      ok: false,
      failure: { kind: 'shared', resolved: join(home, configured) },
    })
  })

  it('accepts the repository-local home', () => {
    const home = userHome()
    const isolated = join(tempDir(), '.mwf-home')
    expect(checkHomeIsolation({ MWF_HOME: isolated }, home)).toEqual({ ok: true, home: isolated })
  })

  it('accepts another directory of the user\u2019s choosing', () => {
    const home = userHome()
    const isolated = join(process.cwd(), 'meta-home')
    expect(checkHomeIsolation({ MWF_HOME: isolated }, home)).toEqual({ ok: true, home: isolated })
  })
})

describe('fixTarget', () => {
  it('names the checkout-local home', () => {
    expect(fixTarget(join('C:', 'repo'))).toBe(join('C:', 'repo', '.mwf-home'))
  })

  it('falls back to the documented placeholder when no checkout is known', () => {
    expect(fixTarget(undefined)).toBe(join('<repo>', '.mwf-home'))
  })
})

describe('homeIsolationMessage', () => {
  it('prints the checkout-local home as the copy-paste fix', () => {
    const message = homeIsolationMessage({ kind: 'unset', resolved: join('C:', 'Users', 'me', '.mwf') }, join('C:', 'repo'))
    expect(message).toContain('MWF_HOME is unset')
    expect(message).toContain(join('C:', 'Users', 'me', '.mwf'))
    expect(message).toContain(`$env:MWF_HOME = "${fixTarget(join('C:', 'repo'))}"`)
    expect(message.split('\n').at(-1)).toBe('Then run the same command again.')
  })

  it('names the shared home when MWF_HOME points at one', () => {
    const message = homeIsolationMessage({ kind: 'shared', resolved: join('/', 'home', 'me', '.dsh') }, join('/', 'repo'))
    expect(message).toContain(`MWF_HOME resolves to ${join('/', 'home', 'me', '.dsh')}, a shared Harness home`)
    expect(message).toContain(`$env:MWF_HOME = "${fixTarget(join('/', 'repo'))}"`)
  })
})

describe('checkoutRoot', () => {
  it('finds the checkout that owns this package by default', () => {
    const root = checkoutRoot()
    expect(root).toBeDefined()
    expect(existsSync(join(root as string, 'pnpm-workspace.yaml'))).toBe(true)
    expect(checkoutRoot([root as string])).toBe(root)
  })

  it('returns undefined when no candidate holds a pnpm workspace manifest', () => {
    expect(checkoutRoot([tempDir()])).toBeUndefined()
    expect(checkoutRoot([])).toBeUndefined()
  })

  it('returns the first matching candidate', () => {
    const first = tempDir()
    writeFileSync(join(first, 'pnpm-workspace.yaml'), 'packages:\n  - .\n')
    const second = tempDir()
    writeFileSync(join(second, 'pnpm-workspace.yaml'), 'packages:\n  - .\n')
    expect(checkoutRoot([first, second])).toBe(first)
  })
})

describe('assertIsolatedHome', () => {
  it('refuses the shared home with the actionable fix command', () => {
    const home = userHome()
    expect(() => { assertIsolatedHome({}, home) }).toThrow(/refusing to start/u)
    expect(() => { assertIsolatedHome({}, home) }).toThrow(/\$env:MWF_HOME = "/u)
  })

  it('accepts an explicit home of its own', () => {
    const home = userHome()
    expect(() => { assertIsolatedHome({ MWF_HOME: join(tempDir(), '.mwf-home') }, home) }).not.toThrow()
  })
})
