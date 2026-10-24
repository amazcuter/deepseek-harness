/**
 * Memory policy, session identity, and the durable mapping that lets a
 * `retained` node continue one conversation across its activations.
 */

import { rm } from 'node:fs/promises'
import type { JsonSchemaNode } from '@metaworkflow/tools'
import { describe, expect, it } from 'vitest'
import {
  activationFor,
  agentNode,
  corruptProjectDatabase,
  definition,
  rejectRetainedWrites,
  edge,
  mount,
  overwriteDefinition,
  retainedSessionOf,
  unusedSessionId,
  writeRetainedRow,
} from './support/harness.ts'
import { textResponse, toolCallResponse } from './support/mock-adapter.ts'
import { COMPLETION_TOOL_NAME } from '../src/index.ts'

/** Output schema a routing condition can read a loop verdict from. */
const LOOP_SCHEMA: JsonSchemaNode = {
  type: 'object',
  properties: { more: { type: 'boolean' } },
  required: ['more'],
  additionalProperties: false,
}

/**
 * Submit one `{ more }` verdict through the completion tool.
 * @param more - whether the loop should re-enter the node under test.
 * @returns the scripted response.
 */
function verdict(more: boolean): ReturnType<typeof toolCallResponse> {
  return toolCallResponse(`call-${String(more)}`, COMPLETION_TOOL_NAME, { value: { more } })
}

/** The session every recorded request ran under. */
function sessionIds(requests: readonly { readonly sessionId?: unknown }[]): (string | undefined)[] {
  return requests.map(request => request.sessionId as string | undefined)
}

describe('agent node sessions', () => {
  it('reuses one session for a retained node across its loop activations', async () => {
    const h = await mount({ script: [verdict(false), verdict(false), verdict(true), verdict(false), verdict(false)] })
    try {
      const revision = await h.define(definition(
        [
          agentNode('entry', { outputSchema: LOOP_SCHEMA }),
          agentNode('work', { memory: 'retained', outputSchema: LOOP_SCHEMA }),
          agentNode('verdict', { outputSchema: LOOP_SCHEMA }),
        ],
        [
          edge('entry', 'work'),
          edge('work', 'verdict'),
          edge('verdict', 'work', { loop: 2, condition: { op: 'eq', field: 'more', value: true } }),
        ],
      ))
      const runId = await h.start(revision)
      const ticked = await h.tick(runId)
      expect(ticked.status).toBe('succeeded')
      const activations = await h.scheduler.listActivations({ projectId: h.projectId, runId })
      expect(activations.filter(activation => activation.nodeId === 'work').map(activation => activation.iteration))
        .toEqual([0, 1])
      const workSessions = sessionIds(h.adapter.requests.filter((_request, index) => index === 1 || index === 3))
      expect(workSessions[0]).toBeDefined()
      expect(workSessions[1]).toBe(workSessions[0])
      // The second activation resumed the stored conversation instead of starting one.
      const resumed = h.adapter.requests[3]!
      expect(resumed.messages.length).toBeGreaterThan(h.adapter.requests[1]!.messages.length)
    } finally {
      await h.close()
    }
  })

  it('records the retained session in the project database', async () => {
    const h = await mount({ script: [verdict(false), verdict(false)] })
    try {
      const revision = await h.define(definition(
        [agentNode('entry', { memory: 'retained', outputSchema: LOOP_SCHEMA })],
      ))
      const runId = await h.start(revision)
      await h.tick(runId)
      const recorded = await retainedSessionOf(h, runId, 'entry')
      expect(h.adapter.requests).toHaveLength(1)
      expect(recorded).toBeDefined()
      expect(recorded).toBe(h.adapter.requests[0]?.sessionId)
    } finally {
      await h.close()
    }
  })

  it('starts a fresh session for each activation of a fresh node', async () => {
    const h = await mount({ script: [verdict(false), verdict(false), verdict(true), verdict(false), verdict(false)] })
    try {
      const revision = await h.define(definition(
        [
          agentNode('entry', { outputSchema: LOOP_SCHEMA }),
          agentNode('work', { outputSchema: LOOP_SCHEMA }),
          agentNode('verdict', { outputSchema: LOOP_SCHEMA }),
        ],
        [
          edge('entry', 'work'),
          edge('work', 'verdict'),
          edge('verdict', 'work', { loop: 2, condition: { op: 'eq', field: 'more', value: true } }),
        ],
      ))
      const runId = await h.start(revision)
      await h.tick(runId)
      const workSessions = sessionIds(h.adapter.requests.filter((_request, index) => index === 1 || index === 3))
      expect(workSessions[0]).toBeDefined()
      expect(workSessions[1]).not.toBe(workSessions[0])
      expect(await retainedSessionOf(h, runId, 'work')).toBeUndefined()
    } finally {
      await h.close()
    }
  })

  it('adds each run of one project to the same retained-session row', async () => {
    const h = await mount({ script: [verdict(false), verdict(false), verdict(false), verdict(false)] })
    try {
      const revision = await h.define(definition([agentNode('entry', { memory: 'retained', outputSchema: LOOP_SCHEMA })]))
      const first = await h.start(revision)
      const second = await h.start(revision)
      await h.tick(first)
      await h.tick(second)
      const firstSession = await retainedSessionOf(h, first, 'entry')
      const secondSession = await retainedSessionOf(h, second, 'entry')
      expect(firstSession).toBe(h.adapter.requests[0]?.sessionId)
      expect(secondSession).toBe(h.adapter.requests[1]?.sessionId)
      expect(secondSession).not.toBe(firstSession)
    } finally {
      await h.close()
    }
  })

  it('fails an activation whose stored revision no longer parses', async () => {
    const h = await mount({ script: [verdict(false)] })
    try {
      const revision = await h.define(definition([agentNode('entry', { outputSchema: LOOP_SCHEMA })]))
      const runId = await h.start(revision)
      const activation = await activationFor(h, runId, 'entry')
      await overwriteDefinition(h, revision, '5')
      await expect(h.executor.execute(activation, {}, new AbortController().signal)).resolves.toMatchObject({
        status: 'failed',
        error: { code: 'agent/definition-unavailable' },
        retryable: false,
      })
      await overwriteDefinition(h, revision, '{"version":1,"nodes":[],"edges":[]}')
      await expect(h.executor.execute(activation, {}, new AbortController().signal)).resolves.toMatchObject({
        status: 'failed',
        error: { code: 'agent/definition-unavailable' },
        retryable: false,
      })
    } finally {
      await h.close()
    }
  })

  it('fails an activation whose definition cannot be read', async () => {
    const h = await mount({ script: [verdict(false)] })
    try {
      const revision = await h.define(definition([agentNode('entry', { outputSchema: LOOP_SCHEMA })]))
      const runId = await h.start(revision)
      const activation = await activationFor(h, runId, 'entry')
      corruptProjectDatabase(h, 'DROP TABLE definitions')
      await expect(h.executor.execute(activation, {}, new AbortController().signal)).resolves.toMatchObject({
        status: 'failed',
        error: { code: 'agent/definition-unavailable' },
        retryable: false,
      })
    } finally {
      await h.close()
    }
  })

  it('fails an activation whose stored revision no longer holds the definition row', async () => {
    const h = await mount({ script: [verdict(false)] })
    try {
      const revision = await h.define(definition([agentNode('entry', { outputSchema: LOOP_SCHEMA })]))
      const runId = await h.start(revision)
      const activation = await activationFor(h, runId, 'entry')
      corruptProjectDatabase(h, 'DROP TABLE nodes; DROP TABLE edges; DELETE FROM definitions')
      await expect(h.executor.execute(activation, {}, new AbortController().signal)).resolves.toMatchObject({
        status: 'failed',
        error: { code: 'agent/definition-unavailable' },
        retryable: false,
      })
    } finally {
      await h.close()
    }
  })

  it('fails an activation whose stored revision declares no such agent node', async () => {
    const h = await mount({ script: [verdict(false)] })
    try {
      const revision = await h.define(definition([agentNode('entry', { outputSchema: LOOP_SCHEMA })]))
      const runId = await h.start(revision)
      const activation = await activationFor(h, runId, 'entry')
      const other = agentNode('other', { outputSchema: LOOP_SCHEMA })
      await overwriteDefinition(h, revision, JSON.stringify({ version: 1, nodes: [other], edges: [] }))
      await expect(h.executor.execute(activation, {}, new AbortController().signal)).resolves.toMatchObject({
        status: 'failed',
        error: { code: 'agent/node-unavailable' },
        retryable: false,
      })
    } finally {
      await h.close()
    }
  })

  it('fails an activation whose retained session record is not readable', async () => {
    const h = await mount({ script: [verdict(false)] })
    try {
      const revision = await h.define(definition([agentNode('entry', { memory: 'retained', outputSchema: LOOP_SCHEMA })]))
      const runId = await h.start(revision)
      await writeRetainedRow(h, 'not json')
      const activation = await activationFor(h, runId, 'entry')
      await expect(h.executor.execute(activation, {}, new AbortController().signal)).resolves.toMatchObject({
        status: 'failed',
        error: { code: 'agent/session-unavailable' },
        retryable: false,
      })
    } finally {
      await h.close()
    }
  })

  it('fails an activation whose retained record is not an object of session ids', async () => {
    const h = await mount({ script: [verdict(false), verdict(false)] })
    try {
      const revision = await h.define(definition([agentNode('entry', { memory: 'retained', outputSchema: LOOP_SCHEMA })]))
      const runId = await h.start(revision)
      const activation = await activationFor(h, runId, 'entry')
      await writeRetainedRow(h, '[]')
      await expect(h.executor.execute(activation, {}, new AbortController().signal)).resolves.toMatchObject({
        status: 'failed',
        error: { code: 'agent/session-unavailable' },
      })
      await writeRetainedRow(h, JSON.stringify({ [`${runId}/entry`]: 7 }))
      await expect(h.executor.execute(activation, {}, new AbortController().signal)).resolves.toMatchObject({
        status: 'failed',
        error: { code: 'agent/session-unavailable' },
      })
    } finally {
      await h.close()
    }
  })

  it('fails an activation whose retained row cannot be written', async () => {
    const h = await mount({ script: [verdict(false)] })
    try {
      const revision = await h.define(definition([agentNode('entry', { memory: 'retained', outputSchema: LOOP_SCHEMA })]))
      const runId = await h.start(revision)
      await rejectRetainedWrites(h)
      const activation = await activationFor(h, runId, 'entry')
      await expect(h.executor.execute(activation, {}, new AbortController().signal)).resolves.toMatchObject({
        status: 'failed',
        error: { code: 'agent/session-unavailable' },
        retryable: true,
      })
    } finally {
      await h.close()
    }
  })

  it('fails an activation that resumes a retained session the backend does not hold', async () => {
    const h = await mount({ script: [verdict(false)] })
    try {
      const revision = await h.define(definition([agentNode('entry', { memory: 'retained', outputSchema: LOOP_SCHEMA })]))
      const runId = await h.start(revision)
      await writeRetainedRow(h, JSON.stringify({ [`${runId}/entry`]: unusedSessionId() }))
      const activation = await activationFor(h, runId, 'entry')
      await expect(h.executor.execute(activation, {}, new AbortController().signal)).resolves.toMatchObject({
        status: 'failed',
        error: { code: 'agent/session-unavailable' },
        retryable: false,
      })
      expect(h.adapter.requests).toHaveLength(0)
    } finally {
      await h.close()
    }
  })

  it('rejects a stale activation whose revision the run no longer executes', async () => {
    const h = await mount({ script: [verdict(false)] })
    try {
      const revision = await h.define(definition([agentNode('entry', { outputSchema: LOOP_SCHEMA })]))
      const runId = await h.start(revision)
      const activation = await activationFor(h, runId, 'entry')
      await expect(
        h.executor.execute({ ...activation, definitionRevision: revision + 1 }, {}, new AbortController().signal),
      ).resolves.toMatchObject({
        status: 'failed',
        error: { code: 'agent/stale-activation' },
        retryable: false,
      })
      expect(h.adapter.requests).toHaveLength(0)
    } finally {
      await h.close()
    }
  })

  it('fails an activation whose run cannot be read', async () => {
    const h = await mount({ script: [verdict(false)] })
    try {
      const revision = await h.define(definition([agentNode('entry', { outputSchema: LOOP_SCHEMA })]))
      const runId = await h.start(revision)
      const activation = await activationFor(h, runId, 'entry')
      await h.store.close()
      await expect(h.executor.execute(activation, {}, new AbortController().signal)).resolves.toMatchObject({
        status: 'failed',
        error: { code: 'agent/run-unavailable' },
        retryable: false,
      })
    } finally {
      await h.close()
    }
  })

  it('fails an activation whose run is not recorded', async () => {
    const h = await mount({ script: [verdict(false)] })
    try {
      const revision = await h.define(definition([agentNode('entry', { outputSchema: LOOP_SCHEMA })]))
      const runId = await h.start(revision)
      const activation = await activationFor(h, runId, 'entry')
      await expect(
        h.executor.execute(
          { ...activation, runId: `missing-${String(runId)}` as typeof activation.runId },
          {},
          new AbortController().signal,
        ),
      ).resolves.toMatchObject({ status: 'failed', error: { code: 'agent/run-unavailable' } })
    } finally {
      await h.close()
    }
  })

  it('fails an activation whose project working directory is gone', async () => {
    const h = await mount({ script: [verdict(false)] })
    try {
      const revision = await h.define(definition([agentNode('entry', { outputSchema: LOOP_SCHEMA })]))
      const runId = await h.start(revision)
      const activation = await activationFor(h, runId, 'entry')
      await rm(h.project.path, { recursive: true, force: true })
      await expect(h.executor.execute(activation, {}, new AbortController().signal)).resolves.toMatchObject({
        status: 'failed',
        error: { code: 'agent/project-unavailable' },
      })
    } finally {
      await h.close()
    }
  })

  it('carries assistant text across a resumed retained conversation', async () => {
    const h = await mount({ script: [textResponse('thinking out loud'), verdict(false)] })
    try {
      const revision = await h.define(definition([agentNode('entry', { memory: 'retained', outputSchema: LOOP_SCHEMA })]))
      const runId = await h.start(revision)
      const activation = await activationFor(h, runId, 'entry')
      const first = await h.executor.execute(activation, {}, new AbortController().signal)
      expect(first).toMatchObject({ status: 'failed', error: { code: 'agent/completion-missing' } })
      const second = await h.executor.execute({ ...activation, attemptNo: 2 }, {}, new AbortController().signal)
      expect(second).toMatchObject({ status: 'succeeded', value: { more: false } })
      expect(h.adapter.requests[1]?.sessionId).toBe(h.adapter.requests[0]?.sessionId)
      const texts = h.adapter.requests[1]!.messages.flatMap(message => message.content.flatMap(block => block.type === 'text' ? [block.text] : []))
      expect(texts).toContain('thinking out loud')
    } finally {
      await h.close()
    }
  })
})
