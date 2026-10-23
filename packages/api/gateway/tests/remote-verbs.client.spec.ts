/**
 * Every `@Remote` verb a namespace declares must be mountable on the Client.
 *
 * The Client Remote service installs one method per descriptor on a namespace
 * service, and that service owns its own members (`remove`, `has`, `install`,
 * the Service base members, and its own fields). A Host verb that reuses one of
 * those names makes the whole contribution fail to mount and takes every plugin
 * behind `remote` down with it — the `projects/remove` verb did exactly that,
 * so the dashboard's delete verb is `projects/delete`.
 */
import { globSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import type { InvocationDescriptor } from '@metaworkflow/typert-protocol'
import TypertRegistry from '@metaworkflow/typert-registry'
import { z } from 'zod'
import type { ConnectionHandle } from '@metaworkflow/client-connection/client'
import { apply, inject } from '../src/client/index.ts'

const ROOT = resolve(import.meta.dirname, '../../../..')

/** One descriptor whose verb the spec chooses, with the strict codecs mounting requires. */
function descriptor(method: string): InvocationDescriptor {
  return {
    id: `@fixture/verbs#verbs/${method}`,
    service: 'verbs',
    namespace: 'verbs',
    method,
    invocation: { kind: 'direct' },
    parameters: [{
      name: 'request',
      wire: 'request',
      source: 'json',
      codec: { mode: 'strict', typeSymbol: '@fixture#Request', create: () => z.object({}) },
    }],
    result: { mode: 'strict', typeSymbol: '@fixture#Result', create: () => z.object({}) },
  }
}

/** Context carrying the Client Remote service over an in-process carrier. */
async function bench(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(TypertRegistry)
  ctx.provide('connection', {
    interactions: 'none',
    openWebSocket: () => { throw new Error('fixture has no socket') },
    isLoopback: true,
    generation: { getSnapshot: () => undefined, subscribe: () => () => {} },
    state: { getSnapshot: () => undefined, subscribe: () => () => {} },
    reconnect: () => {},
    rpc: {
      call: () => Promise.reject(new Error('fixture does not dispatch')),
      open: () => { throw new Error('fixture has no stream') },
    },
    registerGenerationSource: () => () => {},
    start: () => ({ stop: () => {} }),
  } satisfies ConnectionHandle)
  await ctx.plugin({ inject, apply }).await()
  return ctx
}

/**
 * Every distinct verb the workspace declares through a Remote decorator.
 * @returns the verbs, ordered by name.
 */
function declaredVerbs(): string[] {
  const verbs = new Set<string>()
  const files = [
    ...globSync('packages/*/*/src/**/*.ts', { cwd: ROOT }),
    ...globSync('packages/*/*/src/**/*.tsx', { cwd: ROOT }),
  ]
  for (const file of files) {
    const source = readFileSync(resolve(ROOT, file), 'utf8')
    for (const match of source.matchAll(/@Remote\(\s*['"]([^'"]+)['"]\s*\)/g)) verbs.add(match[1] as string)
  }
  return [...verbs].sort()
}

describe('Remote namespace verbs', () => {
  it('discovers the verbs the workspace declares', () => {
    const verbs = declaredVerbs()
    expect(verbs.length).toBeGreaterThan(20)
    expect(verbs).toEqual(expect.arrayContaining(['list', 'create', 'open', 'rename', 'delete']))
  })

  it('refuses a verb that names a namespace-service member', async () => {
    const ctx = await bench()
    // `remove` is the namespace service's own uninstall member; a Host verb of
    // that name cannot be mounted, which is why `projects` calls it `delete`.
    await expect(ctx.remote.$mount({ package: '@fixture/verbs', descriptors: [descriptor('remove')] }))
      .rejects.toThrow('client api: method "verbs/remove" conflicts with its namespace service')
    await ctx.fiber.dispose()
  })

  it('mounts every Remote verb the workspace declares', async () => {
    const ctx = await bench()
    const verbs = declaredVerbs()
    const dispose = await ctx.remote.$mount({
      package: '@fixture/verbs',
      descriptors: verbs.map(verb => descriptor(verb)),
    })
    expect(ctx.get('remote.verbs')).toBeDefined()
    await dispose()
    await ctx.fiber.dispose()
  })
})
