import { fileURLToPath } from 'node:url'
import { agentEvents, type Agent } from '@metaworkflow/agent'
import { ToolCallId } from '@metaworkflow/llm'
import { boot, loadOverlayPatches } from '@metaworkflow/app-boot'
import { SessionId } from '@metaworkflow/session'
import type {} from '@metaworkflow/skill'
import type {} from '@metaworkflow/tools'
import { unsupportedInbox } from '@metaworkflow/agent-loop-testkit'

const overlayPath = process.argv[2]
if (overlayPath === undefined) throw new Error('dsh-badge snapshot requires an overlay path')
const rootConfigPath = fileURLToPath(new URL('../../../../../packages/bundle/base/tests/fixtures/root.cordis.yml', import.meta.url))
const basePatchPath = fileURLToPath(new URL('../../../../../packages/bundle/base/cordis.patch.yml', import.meta.url))
// The fixture owns the optional provider; the base bundle has no dependency on it.
const overlays = loadOverlayPatches('mwf-badge-snapshot', overlayPath).map(patch => patch.insert === undefined ? patch : {
  ...patch,
  insert: patch.insert.map(row => row.name === '@metaworkflow/skill-badge'
    ? { ...row, name: import.meta.resolve('@metaworkflow/skill-badge') }
    : row),
})
const ctx = await boot('mwf-badge-snapshot', rootConfigPath, [
  ...loadOverlayPatches('mwf-badge-snapshot', basePatchPath),
  ...overlays,
])

try {
  const agentId = SessionId('mwf-badge-snapshot')
  const session = ctx.sessions.create(agentId, { meta: { cwd: process.cwd() } })
  const agent: Agent = {
    ctx,
    id: agentId,
    options: {},
    session,
    inbox: unsupportedInbox(),
    status: 'idle',
    send: () => {},
    followup: () => {},
    steer: () => {},
    inject: () => { throw new Error('dsh-badge snapshot must receive the catalog at the step boundary') },
    cancel: () => {},
    runMaintenance: job => job(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  }
  const decision = await agentEvents(ctx, agent).waterfall(
    'agent/pre-step',
    { messages: [], turn: 1, step: 1, signal: new AbortController().signal },
    () => Promise.resolve({ kind: 'enter' as const, messages: [] }),
  )
  const catalog = decision.kind === 'enter'
    ? decision.messages.find(message => message.role === 'user'
      && message.source.kind === 'skill-catalog')?.content
    : undefined
  const summary = (await ctx.skills.list()).find(skill => skill.name === 'dsh-badge')
  const result = await ctx.tools.execute({
    callId: ToolCallId('mwf-badge-snapshot'),
    name: 'skill',
    arguments: { name: 'dsh-badge' },
    signal: new AbortController().signal,
  })
  process.stdout.write(`${JSON.stringify({ catalog: catalog ?? null, summary: summary ?? null, result })}\n`)
} finally {
  await ctx.fiber.dispose()
}
