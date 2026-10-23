import { Context } from '@deepseek-ai/cordis'
import Sandbox from '@metaworkflow/sandbox-local'
import SandboxPolicy from '@metaworkflow/sandbox-policy'
import SessionProjections from '@metaworkflow/session-projection'
import { onTestFinished } from 'vitest'
import type { SandboxMode } from '@metaworkflow/sandbox'

/** Mount the Python runtime's policy and confinement providers with owned teardown. */
export async function createRuntimeContext(policy: { mode?: SandboxMode; workspaceRoot?: string } = {}): Promise<Context> {
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose() })
  await ctx.plugin(Sandbox, {})
  await ctx.plugin(SessionProjections)
  await ctx.plugin(SandboxPolicy, { mode: 'danger-full-access', ...policy })
  return ctx
}
