/**
 * The MetaWorkFlow startup hook refuses a shared Harness home before any
 * server-bound row can inject the web-startup service, and publishes the
 * invocation values when the home is isolated.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { internals, provideCmdline } from '@metaworkflow/cmdline'
import { afterEach, describe, expect, it } from 'vitest'
import { apply, WEB_STARTUP_SERVICE, type WebStartupValues } from '../src/startup.ts'

const tempDirs: string[] = []
const originalHome = process.env.MWF_HOME

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  if (originalHome === undefined) delete process.env.MWF_HOME
  else process.env.MWF_HOME = originalHome
  internals.stdout = process.stdout
  internals.stderr = process.stderr
})

/** One bare context with the launcher facts parseCmdline reads. */
function bench(args: string[]): { ctx: Context; exits: number[] } {
  const ctx = new Context()
  const exits: number[] = []
  const sink = { write: () => true }
  internals.stdout = sink
  internals.stderr = sink
  provideCmdline(ctx, { args, exit: code => void exits.push(code) })
  return { ctx, exits }
}

describe('metaworkflow startup home guard', () => {
  it('refuses startup when MWF_HOME is unset', () => {
    delete process.env.MWF_HOME
    const b = bench(['--no-open'])
    expect(() => { apply(b.ctx) }).toThrow(/refusing to start/u)
    expect(b.ctx.get(WEB_STARTUP_SERVICE)).toBeUndefined()
  })

  it('refuses startup when MWF_HOME points at the shared Harness home', () => {
    process.env.MWF_HOME = join(homedir(), '.mwf')
    const b = bench(['--no-open'])
    expect(() => { apply(b.ctx) }).toThrow(/shared Harness home/u)
    expect(b.ctx.get(WEB_STARTUP_SERVICE)).toBeUndefined()
  })

  it('publishes the parsed flags for an isolated home', () => {
    const home = mkdtempSync(join(tmpdir(), 'mwf-isolated-home-'))
    tempDirs.push(home)
    process.env.MWF_HOME = home
    const b = bench(['--no-open', '--port', '0'])
    apply(b.ctx)
    expect(b.ctx.get(WEB_STARTUP_SERVICE)).toEqual({
      openBrowser: false,
      port: 0,
      trustedHosts: [],
    } satisfies Partial<WebStartupValues>)
  })

  it('keeps --help working without publishing the service', () => {
    delete process.env.MWF_HOME
    const b = bench(['--help'])
    expect(() => { apply(b.ctx) }).not.toThrow()
    expect(b.ctx.get(WEB_STARTUP_SERVICE)).toBeUndefined()
    expect(b.exits).toEqual([0])
  })
})

describe('metaworkflow startup flags', () => {
  it('reports a wildcard bind before starting', () => {
    const home = mkdtempSync(join(tmpdir(), 'mwf-isolated-home-'))
    tempDirs.push(home)
    process.env.MWF_HOME = home
    const b = bench(['--host', '0.0.0.0'])
    expect(() => { apply(b.ctx) }).not.toThrow()
    expect(b.exits).toEqual([1])
  })
})
