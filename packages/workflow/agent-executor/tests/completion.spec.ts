/**
 * The completion tool: schema enforcement, the invalid-argument retry, the
 * terminal guard, and the value the attempt commits.
 */

import { describe, expect, it } from 'vitest'
import {
  activationFor,
  agentNode,
  definition,
  mount,
  toolResultTexts,
} from './support/harness.ts'
import { multiToolCallResponse, textResponse, toolCallResponse } from './support/mock-adapter.ts'
import { COMPLETION_TOOL_NAME } from '../src/index.ts'

describe('agent node completion', () => {
  it('returns the recorded value and sends the activation inputs to the child', async () => {
    const h = await mount({ script: [toolCallResponse('call-1', COMPLETION_TOOL_NAME, { value: { answer: 'forty-two' } })] })
    try {
      const revision = await h.define(definition([agentNode('ask')]))
      const runId = await h.start(revision)
      const activation = await activationFor(h, runId, 'ask')
      const result = await h.executor.execute(activation, { seed: 7 }, new AbortController().signal)
      expect(result).toEqual({ status: 'succeeded', value: { answer: 'forty-two' } })
      const texts = h.adapter.requests[0]!.messages
        .flatMap(message => message.content.flatMap(block => block.type === 'text' ? [block.text] : []))
        .join(String.fromCharCode(10))
      expect(texts).toContain('"seed": 7')
      expect(texts).toContain('attempt 1')
    } finally {
      await h.close()
    }
  })

  it('backfills an invalid submission and accepts the corrected one', async () => {
    const h = await mount({
      script: [
        toolCallResponse('call-invalid', COMPLETION_TOOL_NAME, { value: { answer: 7 } }),
        toolCallResponse('call-valid', COMPLETION_TOOL_NAME, { value: { answer: 'seven' } }),
      ],
    })
    try {
      const revision = await h.define(definition([agentNode('ask')]))
      const runId = await h.start(revision)
      const ticked = await h.tick(runId)
      expect(ticked.status).toBe('succeeded')
      // The model saw the violation inside the same turn and corrected itself.
      expect(h.adapter.requests).toHaveLength(2)
      const texts = await toolResultTexts(h, h.adapter.requests[0]?.sessionId ?? '')
      expect(texts.some(text => text.includes('invalid arguments'))).toBe(true)
      expect(texts.some(text => text.includes('Node result recorded.'))).toBe(true)
    } finally {
      await h.close()
    }
  })

  it('records only the first completion when a step calls the tool twice', async () => {
    const h = await mount({
      script: [multiToolCallResponse([
        { name: COMPLETION_TOOL_NAME, args: { value: { answer: 'first' } } },
        { name: COMPLETION_TOOL_NAME, args: { value: { answer: 'second' } } },
      ])],
    })
    try {
      const revision = await h.define(definition([agentNode('ask')]))
      const runId = await h.start(revision)
      const activation = await activationFor(h, runId, 'ask')
      const result = await h.executor.execute(activation, {}, new AbortController().signal)
      expect(result).toEqual({ status: 'succeeded', value: { answer: 'first' } })
      const texts = await toolResultTexts(h, h.adapter.requests[0]?.sessionId ?? '')
      expect(texts.some(text => text.includes('already recorded'))).toBe(true)
    } finally {
      await h.close()
    }
  })

  it('does not treat a plain assistant answer as the node result', async () => {
    const h = await mount({ script: [textResponse('the answer is forty-two'), textResponse('still only text')] })
    try {
      const revision = await h.define(definition([agentNode('ask')]))
      const runId = await h.start(revision)
      const ticked = await h.tick(runId)
      expect(ticked.status).toBe('failed')
      // The missing completion is retryable, so the scheduler spent both attempts.
      expect(h.adapter.requests).toHaveLength(2)
      expect(ticked.diagnostics.some(diagnostic => diagnostic.message.includes('agent/completion-missing'))).toBe(true)
    } finally {
      await h.close()
    }
  })

  it('validates nested fields against the node output schema', async () => {
    const h = await mount({
      script: [
        toolCallResponse('call-nested-bad', COMPLETION_TOOL_NAME, { value: { findings: [{ title: 1 }] } }),
        toolCallResponse('call-nested-good', COMPLETION_TOOL_NAME, { value: { findings: [{ title: 'one' }] } }),
      ],
    })
    try {
      const revision = await h.define(definition([agentNode('review', {
        outputSchema: {
          type: 'object',
          properties: {
            findings: {
              type: 'array',
              items: {
                type: 'object',
                properties: { title: { type: 'string' } },
                required: ['title'],
                additionalProperties: false,
              },
            },
          },
          required: ['findings'],
          additionalProperties: false,
        },
      })]))
      const runId = await h.start(revision)
      const ticked = await h.tick(runId)
      expect(ticked.status).toBe('succeeded')
      expect(h.adapter.requests).toHaveLength(2)
    } finally {
      await h.close()
    }
  })

  it('refuses a submission that omits the value parameter', async () => {
    const h = await mount({
      script: [
        multiToolCallResponse([{ name: COMPLETION_TOOL_NAME, args: {} }]),
        toolCallResponse('call-valid', COMPLETION_TOOL_NAME, { value: { answer: 'ok' } }),
      ],
    })
    try {
      const revision = await h.define(definition([agentNode('ask')]))
      const runId = await h.start(revision)
      const ticked = await h.tick(runId)
      expect(ticked.status).toBe('succeeded')
      const texts = await toolResultTexts(h, h.adapter.requests[0]?.sessionId ?? '')
      expect(texts.some(text => text.includes('invalid arguments'))).toBe(true)
    } finally {
      await h.close()
    }
  })

  it('discards a recorded completion that a later tool policy turns into a failure', async () => {
    const h = await mount({
      script: [
        toolCallResponse('call-1', COMPLETION_TOOL_NAME, { value: { answer: 'refused' } }),
        textResponse('nothing more'),
      ],
    })
    try {
      h.ctx.on('tools/post-execute', async (exec, _result, next) => {
        if (exec.name !== COMPLETION_TOOL_NAME) return await next()
        return { kind: 'block', feedback: [{ type: 'text', text: 'a tool policy refused this result' }] }
      })
      const revision = await h.define(definition([agentNode('ask')]))
      const runId = await h.start(revision)
      const activation = await activationFor(h, runId, 'ask')
      const result = await h.executor.execute(activation, {}, new AbortController().signal)
      expect(result).toMatchObject({ status: 'failed', error: { code: 'agent/completion-missing' }, retryable: true })
    } finally {
      await h.close()
    }
  })

  it('ignores tool results that are not completions', async () => {
    const h = await mount({
      script: [
        toolCallResponse('call-alpha', 'alpha', { note: 'nothing' }),
        toolCallResponse('call-answer', COMPLETION_TOOL_NAME, { value: { answer: 'after alpha' } }),
      ],
    })
    try {
      h.ctx.tools.register({
        name: 'alpha',
        description: 'alpha does nothing.',
        parameters: { type: 'object', properties: { note: { type: 'string' } }, additionalProperties: false },
        output: {
          schema: { type: 'object', properties: {}, additionalProperties: false },
          render: () => [{ type: 'text', text: 'alpha done.' }],
        },
        execute: () => Promise.resolve({}),
      })
      const revision = await h.define(definition([agentNode('ask', { tools: ['alpha'] })]))
      const runId = await h.start(revision)
      const activation = await activationFor(h, runId, 'ask')
      const result = await h.executor.execute(activation, {}, new AbortController().signal)
      expect(result).toEqual({ status: 'succeeded', value: { answer: 'after alpha' } })
    } finally {
      await h.close()
    }
  })

  it('records the completion of the retried attempt only', async () => {
    const h = await mount({
      script: [
        textResponse('no result yet'),
        toolCallResponse('call-2', COMPLETION_TOOL_NAME, { value: { answer: 'second attempt' } }),
      ],
    })
    try {
      const revision = await h.define(definition([agentNode('ask')]))
      const runId = await h.start(revision)
      const ticked = await h.tick(runId)
      expect(ticked.status).toBe('succeeded')
      expect(h.adapter.requests).toHaveLength(2)
      expect(h.adapter.requests[1]?.sessionId).not.toBe(h.adapter.requests[0]?.sessionId)
    } finally {
      await h.close()
    }
  })
})
