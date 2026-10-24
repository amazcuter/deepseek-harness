/**
 * Decision requests from an agent node: the request the node records and the
 * suspension it reports, the answer the resumed attempt receives as an input,
 * the one-request rule, the failure a store that cannot record one produces,
 * and the coordinator Session the node conversation hangs from.
 */

import { describe, expect, it } from 'vitest'
import { SessionId } from '@metaworkflow/session'
import type { ActivationId, RunId } from '@metaworkflow/workflow-project-store'
import {
  agentNode,
  corruptProjectDatabase,
  definition,
  mount,
  toolResultTexts,
  type Harness,
} from './support/harness.ts'
import { multiToolCallResponse, toolCallResponse } from './support/mock-adapter.ts'
import { COMPLETION_TOOL_NAME, DECISION_TOOL_NAME } from '../src/index.ts'

/** The question every case asks. */
const QUESTION = 'Ship the release?'

/**
 * Drive one run until its agent node suspends itself.
 * @param h - mounted composition.
 * @returns the run and the waiting activation's identity.
 */
async function waitingRun(h: Harness): Promise<{ readonly runId: RunId; readonly activationId: ActivationId }> {
  const revision = await h.define(definition([agentNode('ask')]))
  const runId = await h.start(revision)
  await expect(h.tick(runId)).resolves.toMatchObject({ status: 'running' })
  const [activation] = await h.scheduler.listActivations({ projectId: h.projectId, runId })
  if (activation === undefined) throw new Error('the run has no activation')
  expect(activation.status).toBe('waiting')
  return { runId, activationId: activation.activationId }
}

/**
 * The stored node Session of the run: the only session that is not the
 * coordinator's.
 * @param h - mounted composition.
 * @param coordinator - coordinator session to exclude.
 * @returns the node session identity.
 */
async function nodeSession(h: Harness, coordinator?: SessionId): Promise<string> {
  const sessions = await h.ctx.sessionPersistence.list()
  const snapshot = sessions.find(candidate => candidate.header.id !== coordinator)
  if (snapshot === undefined) throw new Error('the node session was not stored')
  return snapshot.header.id
}

describe('requesting a decision', () => {
  it('records the request and reports the activation waiting', async () => {
    const h = await mount({
      script: [toolCallResponse('call-ask', DECISION_TOOL_NAME, { question: QUESTION, options: ['yes', 'no'] })],
    })
    try {
      const { runId } = await waitingRun(h)
      expect(await h.store.listPendingDecisions(h.projectId)).toMatchObject([{
        runId,
        nodeId: 'ask',
        payload: { question: QUESTION, options: ['yes', 'no'] },
        response: undefined,
        answeredAt: null,
      }])
      await expect(h.scheduler.listAttempts({ projectId: h.projectId, runId }))
        .resolves.toMatchObject([{ status: 'waiting', error: { code: 'scheduler/waiting' } }])
    } finally {
      await h.close()
    }
  })

  it('offers the decision tool alongside the completion tool', async () => {
    const h = await mount({
      script: [toolCallResponse('call-ask', DECISION_TOOL_NAME, { question: QUESTION })],
    })
    try {
      await waitingRun(h)
      expect((h.adapter.requests[0]?.tools ?? []).map(tool => tool.name))
        .toEqual([DECISION_TOOL_NAME, COMPLETION_TOOL_NAME])
    } finally {
      await h.close()
    }
  })

  it('resumes with the answer as one more input', async () => {
    const h = await mount({
      script: [
        toolCallResponse('call-ask', DECISION_TOOL_NAME, { question: QUESTION }),
        (options) => {
          const text = options.messages
            .flatMap(message => message.content)
            .flatMap(block => block.type === 'text' ? [block.text] : [])
            .join('\n')
          expect(text).toContain('"decision": "yes"')
          return toolCallResponse('call-done', COMPLETION_TOOL_NAME, { value: { answer: 'shipped' } })
        },
      ],
    })
    try {
      const { runId, activationId } = await waitingRun(h)
      const [request] = await h.store.listPendingDecisions(h.projectId)
      if (request === undefined) throw new Error('the node recorded no request')
      await h.store.answerDecision(h.projectId, request.requestId, 'yes')
      await expect(h.scheduler.resumeActivation({
        projectId: h.projectId,
        runId,
        activationId,
        decision: 'yes',
      })).resolves.toMatchObject({ status: 'succeeded' })
      await expect(h.scheduler.getRun({ projectId: h.projectId, runId }))
        .resolves.toMatchObject({ status: 'succeeded' })
    } finally {
      await h.close()
    }
  })

  it('refuses a second request in one attempt', async () => {
    const h = await mount({
      script: [multiToolCallResponse([
        { name: DECISION_TOOL_NAME, args: { question: 'first?' } },
        { name: DECISION_TOOL_NAME, args: { question: 'second?' } },
      ])],
    })
    try {
      await waitingRun(h)
      const pending = await h.store.listPendingDecisions(h.projectId)
      expect(pending.map(request => request.payload.question)).toEqual(['first?'])
      const texts = (await toolResultTexts(h, await nodeSession(h))).join('\n')
      expect(texts).toContain('already waits for decision')
    } finally {
      await h.close()
    }
  })

  it('reports a decision the project database could not record', async () => {
    const h = await mount({
      script: [
        toolCallResponse('call-ask', DECISION_TOOL_NAME, { question: QUESTION }),
        toolCallResponse('call-done', COMPLETION_TOOL_NAME, { value: { answer: 'never asked' } }),
      ],
    })
    try {
      corruptProjectDatabase(h, 'DROP TABLE decisions')
      const revision = await h.define(definition([agentNode('ask')]))
      const runId = await h.start(revision)
      // The tool reports the failure to the model inside the same turn, so the
      // node stays free to continue without a request it never recorded.
      await h.tick(runId)
      const texts = (await toolResultTexts(h, await nodeSession(h))).join('\n')
      expect(texts).toContain('the decision request of node "ask" could not be recorded')
    } finally {
      await h.close()
    }
  })

  it('hangs the node conversation from the coordinator session', async () => {
    const h = await mount({
      script: [toolCallResponse('call-done', COMPLETION_TOOL_NAME, { value: { answer: 'done' } })],
    })
    try {
      const coordinator = SessionId('session-coordinator-fixture')
      h.ctx.provide('mwfCoordinator', { ensureSession: async () => coordinator } as never)
      const revision = await h.define(definition([agentNode('ask')]))
      const runId = await h.start(revision)
      await h.tick(runId)
      const sessions = await h.ctx.sessionPersistence.list()
      expect(sessions.map(snapshot => snapshot.header.parentSession)).toEqual([coordinator])
    } finally {
      await h.close()
    }
  })

  it('keeps the node conversation unparented without a coordinator', async () => {
    const h = await mount({
      script: [toolCallResponse('call-done', COMPLETION_TOOL_NAME, { value: { answer: 'done' } })],
    })
    try {
      const revision = await h.define(definition([agentNode('ask')]))
      const runId = await h.start(revision)
      await h.tick(runId)
      const sessions = await h.ctx.sessionPersistence.list()
      expect(sessions.map(snapshot => snapshot.header.parentSession)).toEqual([undefined])
    } finally {
      await h.close()
    }
  })

  it('stores the tool result the model saw for its request', async () => {
    const h = await mount({
      script: [toolCallResponse('call-ask', DECISION_TOOL_NAME, { question: QUESTION })],
    })
    try {
      await waitingRun(h)
      const texts = (await toolResultTexts(h, await nodeSession(h))).join('\n')
      expect(texts).toContain('Waiting for the project coordinator to answer decision')
    } finally {
      await h.close()
    }
  })
})
