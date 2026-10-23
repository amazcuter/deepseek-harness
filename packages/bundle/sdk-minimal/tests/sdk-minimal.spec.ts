/** The standalone SDK-minimal bundle's complete declared Cordis tree. */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as yaml from 'js-yaml'
import { describe, expect, it } from 'vitest'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'

function packageName(specifier: string): string {
  return specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0]!
}

describe('mwf-sdk-minimal bundle', () => {
  it('declares one standalone allowlisted tree with every row dependency', () => {
    const root = fileURLToPath(new URL('..', import.meta.url))
    const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>
      mwf?: { bundle?: { patch?: string } }
    }
    expect(manifest.mwf?.bundle?.patch).toBe('./cordis.patch.yml')
    const patches = yaml.load(
      readFileSync(resolve(root, manifest.mwf!.bundle!.patch!), 'utf8'),
      { schema: entryListSchema },
    ) as Array<{ insert?: Array<{ id?: string; inject?: string[]; name?: string; config?: Record<string, unknown>; disabled?: unknown }> }>
    expect(patches).toHaveLength(1)
    const rows = patches[0]?.insert ?? []
    expect(rows.map(row => [row.id, row.name])).toEqual([
      ['sdk-app-startup', '@metaworkflow/sdk-app'],
      ['sdk-jsonrpc-server', '@metaworkflow/sdk-jsonrpc-server'],
      ['deepseek-llm-api-extensions', '@metaworkflow/deepseek-llm-api-extensions'],
      ['session-log-deepseek', '@metaworkflow/session-log-deepseek'],
      ['plugin-package-inventory-deepseek', '@metaworkflow/plugin-package-inventory-deepseek'],
      ['llm-deepseek', '@metaworkflow/llm-deepseek-api-key'],
      ['sandbox', '@metaworkflow/sandbox-local'],
      ['filesystem', '@metaworkflow/fs-local'],
      ['attachment-local', '@metaworkflow/attachment-local'],
      ['tool-fs', '@metaworkflow/tool-fs'],
      ['working-directory', '@metaworkflow/working-directory'],
      ['tool-working-directory', '@metaworkflow/tool-working-directory'],
      ['session-projection', '@metaworkflow/session-projection'],
      ['token-meter', '@metaworkflow/token-meter'],
      ['compaction-basic', '@metaworkflow/compaction-basic'],
      ['image-offload', '@metaworkflow/compaction-image-offload'],
      ['sandbox-policy', '@metaworkflow/sandbox-policy'],
      ['subprocess', '@metaworkflow/subprocess-local'],
      ['pty', '@metaworkflow/terminal'],
      ['terminal-bash', '@metaworkflow/terminal-bash'],
      ['terminal-pwsh', '@metaworkflow/terminal-bash'],
      ['timer', '@deepseek-ai/cordis-plugin-timer'],
      ['llm', '@metaworkflow/llm'],
      ['session', '@metaworkflow/session'],
      ['session-title', '@metaworkflow/session-title'],
      ['system-prompt', '@metaworkflow/system-prompt'],
      ['tools', '@metaworkflow/tools'],
      ['mcp-resources', '@metaworkflow/mcp-resources'],
      ['agent', '@metaworkflow/agent'],
      ['llm-retry', '@metaworkflow/llm-retry'],
      ['jobs', '@metaworkflow/jobs-local'],
      ['agent-loop', '@metaworkflow/agent-loop'],
      ['persistent-bash', '@metaworkflow/tool-bash-persistent'],
      ['persistent-pwsh', '@metaworkflow/tool-pwsh-persistent'],
      ['sessions', '@metaworkflow/session-persistence-jsonl'],
    ])
    expect(rows.find(row => row.id === 'sdk-app-startup')?.config).toEqual({ profile: 'sdk-minimal' })
    expect(rows.find(row => row.id === 'sdk-jsonrpc-server')).toMatchObject({
      inject: ['sdkAppStartup', 'loader'],
      config: { maxTokensAsSuccess: false },
    })
    expect(rows.find(row => row.id === 'llm-deepseek')?.config).toEqual({
      apiKeyEnv: 'DEEPSEEK_API_KEY',
      defaultContextWindow: { __jsExpr: 'Number(process.env.MWF_CONTEXT_WINDOW ?? 1000000)' },
      streamIdleTimeoutMs: 172800000,
    })
    expect(rows.find(row => row.id === 'system-prompt')?.config).toEqual({
      includeHarnessIdentity: false,
      includeRuntimeContext: false,
      personaPrefix: { __jsExpr: "process.env.MWF_SYSTEM_PROMPT ?? 'You are a helpful software engineer assistant.'" },
    })
    expect(rows.find(row => row.id === 'agent-loop')?.config).toEqual({ agents: [] })
    expect(rows.find(row => row.id === 'tool-fs')?.config).toEqual({ read: false, readImage: true, write: false, edit: false })
    expect(rows.find(row => row.id === 'compaction-basic')?.config).toBeUndefined()
    expect(rows.find(row => row.id === 'terminal-bash')).toMatchObject({
      disabled: { __jsExpr: "process.platform === 'win32'" },
    })
    expect(rows.find(row => row.id === 'terminal-pwsh')).toMatchObject({
      disabled: { __jsExpr: "process.platform !== 'win32'" },
      config: { shellDialect: 'pwsh', timeoutMs: 300000 },
    })
    expect(Object.keys(manifest.dependencies ?? {}).sort()).toEqual(
      [...new Set(rows.map(row => row.name).filter((name): name is string => name !== undefined).map(packageName))].sort(),
    )
  })
})
