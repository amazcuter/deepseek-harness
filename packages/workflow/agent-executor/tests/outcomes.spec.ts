/**
 * Failure and cancellation outcomes: the deadline, an externally canceled turn,
 * a turn the loop ended with an error, and an aborted run signal.
 */

import { SessionId } from '@metaworkflow/session'
import { describe, expect, it } from 'vitest'
import { activationFor, agentNode, definition, mount, type Harness } from './support/harness.ts'
import { maxTokensResponse, textResponse, toolCallResponse } from './support/mock-adapter.ts'
import { COMPLETION_TOOL_NAME } from '../src/index.ts'

describe('agent node outcomes', () => {
  it('reports a retryable timeout when the turn exceeds the deadline', async () => {
    const h = await mount({ script: ['hang'], config: { turnTimeoutMs: 30 } })
    try {
      const revision = await h.define(definition([agentNode('ask')]))
      const runId = await h.start(revision)
      const activation = await activationFor(h, runId, 'ask')
      const result = await h.executor.execute(activation, {}, new AbortController().signal)
      expect(result).toMatchObject({
        status: 'failed',
        error: { code: 'agent/timeout' },
        retryable: true,
      })
    } finally {
      await h.close()
    }
  })

  it('reports a non-retryable cancellation when the turn is canceled outside this executor', async () => {
    const holder: { harness?: Harness } = {}
    const h = await mount({
      script: [
        (options) => {
          // Cancel the live Agent the way an operator or another owner would.
          holder.harness?.ctx.agents.get(options.sessionId!)?.cancel({ kind: 'user' })
          return textResponse('late text')
        },
      ],
    })
    holder.harness = h
    try {
      const revision = await h.define(definition([agentNode('ask')]))
      const runId = await h.start(revision)
      const activation = await activationFor(h, runId, 'ask')
      const result = await h.executor.execute(activation, {}, new AbortController().signal)
      expect(result).toMatchObject({
        status: 'failed',
        error: { code: 'agent/canceled' },
        retryable: false,
      })
    } finally {
      await h.close()
    }
  })

  it('reports a retryable turn failure when the model call fails', async () => {
    const h = await mount({
      script: [
        () => { throw new Error('provider exploded') },
        toolCallResponse('call-ok', COMPLETION_TOOL_NAME, { value: { answer: 'recovered' } }),
      ],
    })
    try {
      const revision = await h.define(definition([agentNode('ask')]))
      const runId = await h.start(revision)
      const activation = await activationFor(h, runId, 'ask')
      const result = await h.executor.execute(activation, {}, new AbortController().signal)
      expect(result).toMatchObject({ status: 'failed', retryable: true })
      expect((result as { error: { code: string } }).error.code).toBe('agent/turn-failed')
    } finally {
      await h.close()
    }
  })

  it('reports a retryable turn failure when the turn reaches the output-token ceiling', async () => {
    const h = await mount({ script: [maxTokensResponse('truncated')] })
    try {
      const revision = await h.define(definition([agentNode('ask')]))
      const runId = await h.start(revision)
      const activation = await activationFor(h, runId, 'ask')
      const result = await h.executor.execute(activation, {}, new AbortController().signal)
      expect(result).toMatchObject({ status: 'failed', error: { code: 'agent/turn-failed' }, retryable: true })
      expect((result as { error: { message: string } }).error.message).toContain('output-token ceiling')
    } finally {
      await h.close()
    }
  })

  it('rejects instead of reporting a failure when the run signal aborts', async () => {
    const h = await mount({ script: ['hang'] })
    try {
      const revision = await h.define(definition([agentNode('ask')]))
      const runId = await h.start(revision)
      const activation = await activationFor(h, runId, 'ask')
      const controller = new AbortController()
      const pending = h.executor.execute(activation, {}, controller.signal)
      setTimeout(() => { controller.abort('workflow run stopped scheduling') }, 20)
      await expect(pending).rejects.toBe('workflow run stopped scheduling')
    } finally {
      await h.close()
    }
  })

  it('rejects immediately when the signal is already aborted', async () => {
    const h = await mount({ script: [] })
    try {
      const revision = await h.define(definition([agentNode('ask')]))
      const runId = await h.start(revision)
      const activation = await activationFor(h, runId, 'ask')
      const controller = new AbortController()
      controller.abort('already stopped')
      await expect(h.executor.execute(activation, {}, controller.signal)).rejects.toBe('already stopped')
      expect(h.adapter.requests).toHaveLength(0)
    } finally {
      await h.close()
    }
  })

  it('reports a session failure when the Agent factory rejects with a foreign value', async () => {
    const h = await mount({ script: [] })
    try {
      const revision = await h.define(definition([agentNode('ask')]))
      const runId = await h.start(revision)
      const activation = await activationFor(h, runId, 'ask')
      await h.disposeLoop()
      // The fallback this covers is a foreign non-Error rejection; throwing a
      // string rethrows nothing an `Error` rule can rewrite into an Error.
      const refused = async (): Promise<never> => {
        throw 'the factory refused'
      }
      h.ctx.agents.setFactory({ createAgent: refused, resume: refused })
      const result = await h.executor.execute(activation, {}, new AbortController().signal)
      expect(result).toMatchObject({ status: 'failed', error: { code: 'agent/session-unavailable' }, retryable: false })
      expect((result as { error: { message: string } }).error.message).toContain('the factory refused')
    } finally {
      await h.close()
    }
  })

  it('maps the live session to its attempt while the turn runs', async () => {
    const holder: { harness?: Harness } = {}
    let seen: { attemptId: string; nodeId: string; revision: number } | undefined
    let childId: string | undefined
    const h = await mount({
      script: [
        (options) => {
          childId = options.sessionId
          const record = holder.harness?.executor.nodeSessions.lookup(options.sessionId!)
          if (record !== undefined) {
            seen = { attemptId: record.attemptId, nodeId: record.nodeId, revision: record.revision }
          }
          return toolCallResponse('call-1', COMPLETION_TOOL_NAME, { value: { answer: 'ok' } })
        },
      ],
    })
    holder.harness = h
    try {
      const revision = await h.define(definition([agentNode('ask')]))
      const runId = await h.start(revision)
      const activation = await activationFor(h, runId, 'ask')
      await h.executor.execute(activation, {}, new AbortController().signal)
      expect(seen).toEqual({ attemptId: activation.attemptId, nodeId: 'ask', revision })
      // The record is gone once the attempt settles.
      expect(childId).toBeDefined()
      expect(h.executor.nodeSessions.lookup(SessionId(childId ?? ''))).toBeUndefined()
    } finally {
      await h.close()
    }
  })
})
