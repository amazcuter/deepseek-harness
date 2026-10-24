import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import {
  agentNode,
  definition,
  mount,
  systemText,
  toolNames,
  MODEL,
  PROVIDER,
  type Harness,
} from './support/harness.ts'
import { toolCallResponse } from './support/mock-adapter.ts'
import { COMPLETION_INSTRUCTION, COMPLETION_TOOL_NAME } from '../src/index.ts'

/**
 * Register one no-op global tool the node's allow list can name.
 * @param ctx - mounted composition that owns the global layer.
 * @param name - tool name.
 * @returns nothing.
 */
function globalTool(ctx: Context, name: string): void {
  ctx.tools.register({
    name,
    description: `${name} does nothing.`,
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: {
      schema: { type: 'object', properties: {}, additionalProperties: false },
      render: () => [{ type: 'text', text: `${name} done.` }],
    },
    execute: () => Promise.resolve({}),
  })
}

/** The completion call every successful case ends with. */
function submit(answer: string): ReturnType<typeof toolCallResponse> {
  return toolCallResponse(`call-${answer}`, COMPLETION_TOOL_NAME, { value: { answer } })
}

/**
 * Run one single-node definition and return the harness and the recorded request.
 * @param h - freshly mounted composition.
 * @param revision - stored revision to run.
 * @returns the request the child Agent sent.
 */
async function runOnce(h: Harness, revision: number) {
  const runId = await h.start(revision)
  await h.tick(runId)
  expect(h.adapter.requests).toHaveLength(1)
  return h.adapter.requests[0]!
}

describe('agent node composition', () => {
  it('composes the node instructions, the deployment model, and only the configured tools', async () => {
    const h = await mount({ script: [submit('ok')] })
    try {
      globalTool(h.ctx, 'alpha')
      globalTool(h.ctx, 'beta')
      const revision = await h.define(definition([agentNode('ask', { instructions: 'You are the answer node.', tools: ['alpha'] })]))
      const request = await runOnce(h, revision)
      expect(request.provider).toBe(PROVIDER)
      expect(request.model).toBe(MODEL)
      expect(toolNames(request)).toEqual(['alpha', COMPLETION_TOOL_NAME])
      const system = systemText(request)
      expect(system).toContain('You are the answer node.')
      expect(system).toContain(COMPLETION_INSTRUCTION)
      expect(system).not.toContain('beta')
    } finally {
      await h.close()
    }
  })

  it('carries the deployment reasoning effort onto the child call', async () => {
    const h = await mount({
      script: [submit('ok')],
      reasoningEffort: 'high',
    })
    try {
      const revision = await h.define(definition([agentNode('ask')]))
      const request = await runOnce(h, revision)
      expect(request.reasoningEffort).toBe('high')
    } finally {
      await h.close()
    }
  })

  it('keeps the completion tool when the node configures no tools', async () => {
    const h = await mount({ script: [submit('ok')] })
    try {
      globalTool(h.ctx, 'alpha')
      const revision = await h.define(definition([agentNode('ask')]))
      const request = await runOnce(h, revision)
      expect(toolNames(request)).toEqual([COMPLETION_TOOL_NAME])
    } finally {
      await h.close()
    }
  })

  it('does not leak one node tool allow list into another node', async () => {
    const h = await mount({ script: [submit('first'), submit('second')] })
    try {
      globalTool(h.ctx, 'alpha')
      globalTool(h.ctx, 'beta')
      const first = agentNode('first', { tools: ['alpha'] })
      const second = agentNode('second', { tools: ['beta'] })
      const revision = await h.define(definition([first, second], [{ id: 'first-second', from: 'first', to: 'second', condition: null, mode: 'multiple' }]))
      const runId = await h.start(revision)
      const ticked = await h.tick(runId)
      expect(ticked.status).toBe('succeeded')
      expect(h.adapter.requests.map(request => toolNames(request))).toEqual([
        ['alpha', COMPLETION_TOOL_NAME],
        ['beta', COMPLETION_TOOL_NAME],
      ])
    } finally {
      await h.close()
    }
  })

  it('reports a composition failure when the node names a tool this deployment does not register', async () => {
    const h = await mount({ script: [] })
    try {
      const revision = await h.define(definition([agentNode('ask', { tools: ['missing-tool'] })]))
      const runId = await h.start(revision)
      const ticked = await h.tick(runId)
      expect(ticked.status).toBe('failed')
      expect(ticked.diagnostics.map(diagnostic => diagnostic.code)).toContain('scheduler/node-failed')
      expect(ticked.diagnostics.some(diagnostic => diagnostic.message.includes('agent/composition-failed'))).toBe(true)
      expect(h.adapter.requests).toHaveLength(0)
      const activations = await h.scheduler.listActivations({ projectId: h.projectId, runId })
      expect(activations[0]?.status).toBe('failed')
    } finally {
      await h.close()
    }
  })

  it('leaves the configured instructions literal instead of interpolating prompt variables', async () => {
    const h = await mount({ script: [submit('ok')] })
    try {
      const revision = await h.define(definition([agentNode('ask', { instructions: 'Report {{value}} verbatim.' })]))
      const request = await runOnce(h, revision)
      expect(systemText(request)).toContain('Report {{value}} verbatim.')
    } finally {
      await h.close()
    }
  })
})
