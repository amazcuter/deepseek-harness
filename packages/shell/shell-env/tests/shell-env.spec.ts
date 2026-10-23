/**
 * Registry tests for `@metaworkflow/shell-env`: built-in facts, contributor
 * ownership and validation, collection ordering, effect-scoped disposal, and
 * the explicit disposer contract.
 */

import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@metaworkflow/llm'
import type { Agent } from '@metaworkflow/agent'
import { SESSION_FORMAT_VERSION } from '@metaworkflow/session'
import type { ToolExecution } from '@metaworkflow/tools'
import { ShellEnvRegistry } from '@metaworkflow/shell-env'
import * as BashEnvPlugin from '@metaworkflow/shell-env'

const testToolSignal = new AbortController().signal

afterEach(() => vi.unstubAllEnvs())

function execution(sessionId?: string): ToolExecution {
  return {
    signal: testToolSignal,
    token: Symbol('bash-env-test') as ToolExecution['token'],
    callId: ToolCallId('bash-env-call'),
    rootCallId: ToolCallId('bash-env-call'),
    name: 'bash',
    arguments: { command: 'true' },
    ...(sessionId === undefined
      ? {}
      : {
        agent: {
          session: {
            header: { version: SESSION_FORMAT_VERSION, id: sessionId, createdAt: 0, isSeeded: false },
          },
        } as unknown as Agent,
      }),
  }
}

describe('ShellEnvRegistry', () => {
  it('collects unconditional shell facts and the current agent session id', () => {
    const ctx = new Context()
    const registry = new ShellEnvRegistry(ctx, { mwfHome: './test-mwf-home' })

    expect(registry.collect(execution())).toEqual({
      MWF_HOME: resolve('./test-mwf-home'),
      MWF_SHELL: '1',
    })
    expect(registry.collect(execution('session-a'))).toEqual({
      MWF_HOME: resolve('./test-mwf-home'),
      MWF_SESSION_ID: 'session-a',
      MWF_SHELL: '1',
    })
  })

  it('collects the launcher-provided profile name and directory when a profile context exists', () => {
    const ctx = new Context()
    ctx.provide('profileContext', {
      name: 'web', dir: '/profiles/web', patchPath: '/profiles/web/cordis.patch.yml', installAnchor: '/mwf/package.json',
      cwd: '/work', home: '/home', startedBundles: [], overlays: [], telemetryDisabledEnv: undefined,
    })
    const registry = new ShellEnvRegistry(ctx, { mwfHome: './test-mwf-home' })
    expect(registry.collect(execution())).toMatchObject({ MWF_PROFILE: 'web', MWF_PROFILE_DIR: '/profiles/web' })
    expect(() => registry.register({
      name: 'profile-claimer',
      variables: { MWF_PROFILE: { description: 'Reserved key.' } },
      resolve: () => ({}),
    })).toThrow(/reserved key "MWF_PROFILE"/)
  })

  it('resolves MWF_HOME from the ambient override or the user-home default', () => {
    vi.stubEnv('MWF_HOME', './ambient-mwf-home')
    const fromEnvironment = new ShellEnvRegistry(new Context())
    expect(fromEnvironment.collect(execution()).MWF_HOME).toBe(resolve('./ambient-mwf-home'))

    vi.stubEnv('MWF_HOME', undefined)
    const fromDefault = new ShellEnvRegistry(new Context())
    expect(fromDefault.collect(execution()).MWF_HOME).toBe(join(homedir(), '.mwf'))
  })

  it('collects declared contributor variables and omits unavailable values', () => {
    const ctx = new Context()
    const registry = new ShellEnvRegistry(ctx, { mwfHome: './test-mwf-home' })
    registry.register({
      name: 'optional-session-fact',
      variables: {
        MWF_SESSION_OPTIONAL: { description: 'Optional session-scoped test fact.' },
      },
      resolve: exec => exec.agent === undefined ? {} : { MWF_SESSION_OPTIONAL: exec.agent.session.header.id },
    })
    registry.register({
      name: 'always-available-fact',
      variables: {
        MWF_ALWAYS_AVAILABLE: { description: 'Always-available test fact.' },
      },
      resolve: () => ({ MWF_ALWAYS_AVAILABLE: 'yes' }),
    })

    expect(registry.collect(execution())).not.toHaveProperty('MWF_SESSION_OPTIONAL')
    expect(registry.collect(execution()).MWF_ALWAYS_AVAILABLE).toBe('yes')
    expect(registry.collect(execution('session-b')).MWF_SESSION_OPTIONAL).toBe('session-b')
    expect(registry.list()).toEqual([
      {
        contributor: 'always-available-fact',
        description: 'Always-available test fact.',
        key: 'MWF_ALWAYS_AVAILABLE',
      },
      {
        contributor: 'optional-session-fact',
        description: 'Optional session-scoped test fact.',
        key: 'MWF_SESSION_OPTIONAL',
      },
    ])
  })

  it('rejects duplicate variable ownership at registration time', () => {
    const ctx = new Context()
    const registry = new ShellEnvRegistry(ctx, { mwfHome: './test-mwf-home' })
    registry.register({
      name: 'first',
      variables: { MWF_SHARED: { description: 'First owner.' } },
      resolve: () => ({ MWF_SHARED: 'first' }),
    })

    expect(() => registry.register({
      name: 'second',
      variables: { MWF_SHARED: { description: 'Second owner.' } },
      resolve: () => ({ MWF_SHARED: 'second' }),
    })).toThrow(/MWF_SHARED.*first.*second|MWF_SHARED.*second.*first/)
  })

  it('rejects duplicate contributor names and malformed declarations', () => {
    const registry = new ShellEnvRegistry(new Context(), { mwfHome: './test-mwf-home' })
    registry.register({
      name: 'declared',
      variables: { MWF_DECLARED: { description: 'Declared fact.' } },
      resolve: () => ({}),
    })

    expect(() => registry.register({
      name: 'declared',
      variables: { MWF_ANOTHER: { description: 'Another fact.' } },
      resolve: () => ({}),
    })).toThrow(/already registered/)
    expect(() => registry.register({
      name: ' ',
      variables: { MWF_BLANK_NAME: { description: 'Blank owner.' } },
      resolve: () => ({}),
    })).toThrow(/name must be non-empty/)
    expect(() => registry.register({
      name: 'invalid-key',
      variables: { mwf_invalid: { description: 'Invalid key.' } } as unknown as Record<'MWF_INVALID', { description: string }>,
      resolve: () => ({}),
    })).toThrow(/invalid key/)
    expect(() => registry.register({
      name: 'reserved-key',
      variables: { MWF_HOME: { description: 'Reserved key.' } },
      resolve: () => ({}),
    })).toThrow(/reserved key/)
    expect(() => registry.register({
      name: 'blank-description',
      variables: { MWF_BLANK_DESCRIPTION: { description: ' ' } },
      resolve: () => ({}),
    })).toThrow(/must describe/)
  })

  it('rejects undeclared variables returned by a contributor', () => {
    const ctx = new Context()
    const registry = new ShellEnvRegistry(ctx, { mwfHome: './test-mwf-home' })
    registry.register({
      name: 'drifted-provider',
      variables: { MWF_DECLARED: { description: 'Declared fact.' } },
      resolve: () => ({ MWF_UNDECLARED: 'bad' }),
    })

    expect(() => registry.collect(execution())).toThrow(/drifted-provider.*MWF_UNDECLARED/)
  })

  it('rejects non-string values returned by a contributor', () => {
    const registry = new ShellEnvRegistry(new Context(), { mwfHome: './test-mwf-home' })
    registry.register({
      name: 'wrong-value-type',
      variables: { MWF_STRING: { description: 'String fact.' } },
      resolve: () => ({ MWF_STRING: 42 }) as unknown as Record<'MWF_STRING', string>,
    })

    expect(() => registry.collect(execution())).toThrow(/wrong-value-type.*non-string.*MWF_STRING/)
  })

  it('removes an effect-scoped contributor when its plugin is disposed', async () => {
    const ctx = new Context()
    const registry = new ShellEnvRegistry(ctx, { mwfHome: './test-mwf-home' })
    const fiber = await ctx.plugin({
      inject: ['shellEnv'],
      apply(inner: Context) {
        inner.shellEnv.register({
          name: 'temporary',
          variables: { MWF_TEMPORARY: { description: 'Temporary fact.' } },
          resolve: () => ({ MWF_TEMPORARY: 'present' }),
        })
      },
    })

    expect(registry.collect(execution()).MWF_TEMPORARY).toBe('present')
    await fiber.dispose()
    expect(registry.collect(execution())).not.toHaveProperty('MWF_TEMPORARY')
  })

  it('returns an explicit contributor disposer', () => {
    const registry = new ShellEnvRegistry(new Context(), { mwfHome: './test-mwf-home' })
    const dispose = registry.register({
      name: 'explicit-disposal',
      variables: { MWF_EXPLICIT_DISPOSAL: { description: 'Explicitly disposed fact.' } },
      resolve: () => ({ MWF_EXPLICIT_DISPOSAL: 'present' }),
    })

    expect(registry.collect(execution()).MWF_EXPLICIT_DISPOSAL).toBe('present')
    dispose()
    expect(registry.collect(execution())).not.toHaveProperty('MWF_EXPLICIT_DISPOSAL')
  })

  it('the plugin registers the service with no contributors on load', async () => {
    const ctx = new Context()
    await ctx.plugin(BashEnvPlugin)
    expect(ctx.shellEnv).toBeInstanceOf(ShellEnvRegistry)
    expect(ctx.shellEnv.list()).toEqual([])
  })
})
