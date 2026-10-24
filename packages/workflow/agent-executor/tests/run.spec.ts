/**
 * A scheduler-driven run whose nodes are agent nodes: the committed value of one
 * node becomes the input of the next, so the completion value participates in
 * routing exactly like any other node result.
 */

import { describe, expect, it } from 'vitest'
import { agentNode, definition, edge, mount } from './support/harness.ts'
import { toolCallResponse } from './support/mock-adapter.ts'
import { COMPLETION_TOOL_NAME } from '../src/index.ts'

describe('agent nodes in a scheduled run', () => {
  it('routes one node value into the next node input', async () => {
    const h = await mount({
      script: [
        toolCallResponse('call-draft', COMPLETION_TOOL_NAME, { value: { answer: 'draft-value' } }),
        toolCallResponse('call-review', COMPLETION_TOOL_NAME, { value: { answer: 'reviewed-value' } }),
      ],
    })
    try {
      const revision = await h.define(definition(
        [
          agentNode('draft'),
          agentNode('review', {
            inputs: [{ name: 'answer', source: { kind: 'node', nodeId: 'draft', field: 'answer' } }],
          }),
        ],
        [edge('draft', 'review')],
      ))
      const runId = await h.start(revision)
      const ticked = await h.tick(runId)
      expect(ticked.status).toBe('succeeded')
      expect(ticked.completed).toBe(2)
      const activations = await h.scheduler.listActivations({ projectId: h.projectId, runId })
      expect(activations.map(activation => [activation.nodeId, activation.status])).toEqual([
        ['draft', 'succeeded'],
        ['review', 'succeeded'],
      ])
      const reviewRequest = h.adapter.requests[1]!
      const texts = reviewRequest.messages
        .flatMap(message => message.content.flatMap(block => block.type === 'text' ? [block.text] : []))
        .join(String.fromCharCode(10))
      expect(texts).toContain('"answer": "draft-value"')
      // Each node runs its own child session.
      expect(reviewRequest.sessionId).not.toBe(h.adapter.requests[0]?.sessionId)
    } finally {
      await h.close()
    }
  })

  it('runs concurrently ready agent nodes under one scheduler tick', async () => {
    const answer = toolCallResponse('call-x', COMPLETION_TOOL_NAME, { value: { answer: 'ok' } })
    const h = await mount({ script: [answer, answer, answer] })
    try {
      const revision = await h.define(definition(
        [agentNode('a'), agentNode('b'), agentNode('c')],
        [edge('a', 'b'), edge('a', 'c')],
      ))
      const runId = await h.start(revision)
      const ticked = await h.tick(runId)
      expect(ticked.status).toBe('succeeded')
      expect(h.adapter.requests).toHaveLength(3)
      expect(new Set(h.adapter.requests.map(request => request.sessionId)).size).toBe(3)
    } finally {
      await h.close()
    }
  })

  it('unregisters the agent executor when its plugin is disposed', async () => {
    const h = await mount({ script: [] })
    try {
      await h.disposeExecutor()
      const revision = await h.define(definition([agentNode('ask')]))
      const runId = await h.start(revision)
      const ticked = await h.tick(runId)
      expect(ticked.diagnostics.map(diagnostic => diagnostic.code)).toContain('scheduler/executor-missing')
    } finally {
      await h.close()
    }
  })
})
