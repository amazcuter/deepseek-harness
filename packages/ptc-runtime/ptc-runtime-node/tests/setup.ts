import { Context } from '@deepseek-ai/cordis'
import { onTestFinished } from 'vitest'
import SessionStore from '@metaworkflow/session'
import FileSystem from '@metaworkflow/fs-local'
import Subprocess from '@metaworkflow/subprocess-local'
import Sandbox from '@metaworkflow/sandbox-local'
import SandboxPolicy from '@metaworkflow/sandbox-policy'
import SessionProjections from '@metaworkflow/session-projection'
import type { SandboxMode } from '@metaworkflow/sandbox'
import NodeRuntime from '../src/index.ts'
import type { Config } from '../src/index.ts'

export async function mountRuntime(ctx: Context, config: Config = {}, policy: { mode?: SandboxMode; workspaceRoot?: string } = {}) {
  onTestFinished(async () => { await ctx.fiber.dispose() })
  if (!ctx.get('sessions')) await ctx.plugin(SessionStore)
  if (!ctx.get('fs')) await ctx.plugin(FileSystem)
  if (!ctx.get('subprocess')) await ctx.plugin(Subprocess)
  if (!ctx.get('sandbox')) await ctx.plugin(Sandbox, {})
  if (!ctx.get('sessionProjections')) await ctx.plugin(SessionProjections)
  if (!ctx.get('sandboxPolicy')) await ctx.plugin(SandboxPolicy, { mode: 'danger-full-access', ...policy })
  const fiber = await ctx.plugin(NodeRuntime, config)
  return { runtime: ctx.ptcRuntime as NodeRuntime, fiber }
}
