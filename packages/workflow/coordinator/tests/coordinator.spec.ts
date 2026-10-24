/**
 * The coordinator as its consumers see it: one persistent Session per project,
 * its recorded identity across restarts, the tools that answer and list
 * decisions, the errors of an unknown or repeated answer, and the events a UI
 * subscribes to.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { createUserMessage } from '@metaworkflow/llm'
import { WorkflowCoordinatorError } from '../src/index.ts'
import {
  ANSWER_DECISION_TOOL_NAME,
  COORDINATOR_SESSION_KEY,
  LIST_DECISIONS_TOOL_NAME,
  PROJECT_STATE_TOOL_NAME,
} from '../src/index.ts'
import {
  agentNode,
  definition,
  mount,
  recordedCoordinatorSession,
  type Harness,
} from './support/harness.ts'
import { textResponse, toolCallResponse } from './support/mock-adapter.ts'
import type { ScriptEntry } from './support/mock-adapter.ts'
import type { GenerateOptions, StreamChunk } from '@metaworkflow/llm'
import { COMPLETION_TOOL_NAME, DECISION_TOOL_NAME } from '@metaworkflow/workflow-agent-executor'

const harnesses: Harness[] = []

afterEach(async () => {
  for (const mounted of harnesses.splice(0)) await mounted.close()
})

async function mounted(options?: Parameters<typeof mount>[0]): Promise<Harness> {
  const created = await mount(options)
  harnesses.push(created)
  return created
}

/** Every stored session snapshot, so a case can assert lineage and event counts. */
async function storedSessions(h: Harness): Promise<Awaited<ReturnType<Harness['ctx']['sessionPersistence']['list']>>> {
  return await h.ctx.sessionPersistence.list()
}

/**
 * Every text one model call carried, tool results included.
 *
 * A live Session does not expose its log, and the persisted copy is written when
 * the Session closes, so a case asserts on what the model was actually shown.
 * @param h - mounted composition.
 * @returns the text blocks of every recorded request.
 */
function modelTexts(h: Harness): string[] {
  return h.adapter.requests.flatMap(request => request.messages
    .flatMap(message => message.content.flatMap(block => block.type === 'text' ? [block.text] : [])))
}

/** One scripted response that completes; a hang has no meaning in a role queue. */
type RoleEntry = Exclude<ScriptEntry, 'hang'>

/** Scripted responses per role, so a concurrent node call never steals one. */
interface RoleScript {
  readonly coordinator: RoleEntry[]
  readonly node: RoleEntry[]
}

/**
 * Split one model call by the Session that made it.
 * @param options - the recorded request.
 * @returns `true` for the coordinator Session's calls.
 */
function isCoordinatorCall(options: GenerateOptions): boolean {
  return JSON.stringify(options.messages[0] ?? {}).includes('project coordinator')
}

/**
 * Script entries that serve coordinator and node model calls independently.
 *
 * Answering a decision resumes the node while the coordinator's own call is
 * still in flight, so one global queue would hand the node the coordinator's
 * next response. Each call is routed to its role's queue instead.
 * @param roles - responses each role receives, in its own call order.
 * @returns entries for the scripted transport, enough for the whole case.
 */
function roleScript(roles: RoleScript): ScriptEntry[] {
  const queues = { coordinator: [...roles.coordinator], node: [...roles.node] }
  return Array.from({ length: 16 }, () => (options: GenerateOptions): StreamChunk[] => {
    const role = isCoordinatorCall(options) ? 'coordinator' : 'node'
    const entry = queues[role].shift()
    if (entry === undefined) throw new Error(`no scripted ${role} response is left`)
    return typeof entry === 'function' ? entry(options) : entry
  })
}

/**
 * Drive one coordinator turn and wait for it to settle.
 * @param h - mounted composition.
 * @param instruction - the user text the coordinator answers.
 * @returns nothing.
 */
async function coordinatorTurn(h: Harness, instruction: string): Promise<void> {
  const agent = await h.coordinatorAgent()
  agent.followup(createUserMessage({ content: [{ type: 'text', text: instruction }], source: { kind: 'user' } }))
  await agent.whenIdle()
}

/** The first request id the composition recorded. */
function firstRequest(): string {
  const [request] = harnesses[harnesses.length - 1]?.requested ?? []
  if (request === undefined) throw new Error('no decision request was recorded')
  return request.requestId
}

describe('the coordinator session', () => {
  it('creates one Session per project and records it', async () => {
    const h = await mounted()
    const first = await h.coordinator.ensureSession(h.projectId)
    const second = await h.coordinator.ensureSession(h.projectId)
    expect(second).toBe(first)
    expect(await recordedCoordinatorSession(h)).toBe(first)
    expect(h.ctx.agents.get(first)).toBeDefined()
  })

  it('returns the same Session to two concurrent callers', async () => {
    const h = await mounted()
    const [first, second] = await Promise.all([
      h.coordinator.ensureSession(h.projectId),
      h.coordinator.ensureSession(h.projectId),
    ])
    expect(second).toBe(first)
  })

  it('resumes the recorded Session after the plugin is remounted', async () => {
    const h = await mounted({ script: [textResponse('The plan is ready.')] })
    const sessionId = await h.coordinator.ensureSession(h.projectId)
    const agent = await h.coordinatorAgent()
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Plan the project.' }], source: { kind: 'user' } }))
    await agent.whenIdle()

    await h.disposeCoordinator()
    await h.remountCoordinator()
    await expect(h.coordinator.ensureSession(h.projectId)).resolves.toBe(sessionId)
    // The resumed conversation keeps its history, which is what makes the
    // coordinator one persistent Session rather than one per turn.
    const resumed = await h.coordinatorAgent()
    expect(resumed.session.id).toBe(sessionId)
    const snapshots = await storedSessions(h)
    expect(snapshots.some(snapshot => snapshot.header.id === sessionId)).toBe(true)
  })

  it('carries the deployment reasoning effort onto the coordinator call', async () => {
    const h = await mounted({ script: [textResponse('Ready.')], reasoningEffort: 'high' })
    await h.coordinator.ensureSession(h.projectId)
    await coordinatorTurn(h, 'Plan the project.')
    expect(h.adapter.requests[0]?.reasoningEffort).toBe('high')
  })

  it('reports a project whose Session record is empty', async () => {
    const h = await mounted()
    await h.store.transact(h.projectId, (db) => {
      db.prepare('INSERT INTO schema_meta (key, value) VALUES (?, ?)').run(COORDINATOR_SESSION_KEY, '')
    })
    await expect(h.coordinator.ensureSession(h.projectId)).rejects.toThrow(COORDINATOR_SESSION_KEY)
  })

  it('refuses an unregistered project with a typed error', async () => {
    const h = await mounted()
    await expect(h.coordinator.ensureSession('0f0f0f0f-1111-4222-8333-444444444444' as never))
      .rejects.toThrow(WorkflowCoordinatorError)
  })

  it('disposes its Sessions with the plugin', async () => {
    const h = await mounted()
    const sessionId = await h.coordinator.ensureSession(h.projectId)
    await h.disposeCoordinator()
    expect(h.ctx.agents.get(sessionId)).toBeUndefined()
  })

  it('gives the node conversation the coordinator as its parent session', async () => {
    const h = await mounted({ script: [toolCallResponse('call-done', COMPLETION_TOOL_NAME, { value: { answer: 'done' } })] })
    const sessionId = await h.coordinator.ensureSession(h.projectId)
    const revision = await h.define(definition([agentNode('ask')]))
    const runId = await h.start(revision)
    await h.tick(runId)
    const parents = (await storedSessions(h))
      .filter(snapshot => snapshot.header.id !== sessionId)
      .map(snapshot => snapshot.header.parentSession)
    expect(parents).toEqual([sessionId])
  })
})

describe('answering a decision', () => {
  it('answers a waiting node, resumes the run, and announces the answer', async () => {
    const h = await mounted({
      script: roleScript({
        node: [
          // The node asks the coordinator a question and suspends.
          toolCallResponse('call-ask', DECISION_TOOL_NAME, {
            question: 'Ship the release?',
            options: ['yes', 'no'],
          }),
          // The resumed node reports its result.
          toolCallResponse('call-done', COMPLETION_TOOL_NAME, { value: { answer: 'shipped' } }),
        ],
        coordinator: [
          () => toolCallResponse('call-answer', ANSWER_DECISION_TOOL_NAME, {
            requestId: firstRequest(),
            answer: 'yes',
          }),
          textResponse('The decision is answered.'),
        ],
      }),
    })
    const revision = await h.define(definition([agentNode('ask')]))
    const runId = await h.start(revision)
    await expect(h.tick(runId)).resolves.toMatchObject({ status: 'running' })
    const [request] = h.requested
    if (request === undefined) throw new Error('the node recorded no decision request')
    const pending = await h.store.listPendingDecisions(h.projectId)
    expect(pending).toMatchObject([{
      requestId: request.requestId,
      runId,
      nodeId: 'ask',
      payload: { question: 'Ship the release?', options: ['yes', 'no'] },
    }])

    await coordinatorTurn(h, 'Answer the waiting decision.')
    expect(await h.store.listPendingDecisions(h.projectId)).toEqual([])
    await expect(h.scheduler.getRun({ projectId: h.projectId, runId })).resolves.toMatchObject({ status: 'succeeded' })
    expect(h.answered).toMatchObject([{
      projectId: h.projectId,
      runId,
      requestId: request.requestId,
      answer: 'yes',
      runStatus: 'succeeded',
    }])
    expect(modelTexts(h).join('\n')).toContain(`Answered decision ${request.requestId}`)
  })

  it('refuses an unknown request id and a repeated answer', async () => {
    const h = await mounted({
      script: roleScript({
        node: [
          toolCallResponse('call-ask', DECISION_TOOL_NAME, { question: 'Ship it?' }),
          toolCallResponse('call-done', COMPLETION_TOOL_NAME, { value: { answer: 'shipped' } }),
        ],
        coordinator: [
          () => toolCallResponse('call-answer', ANSWER_DECISION_TOOL_NAME, {
            requestId: firstRequest(),
            answer: 'yes',
          }),
          textResponse('Answered.'),
          () => toolCallResponse('call-again', ANSWER_DECISION_TOOL_NAME, {
            requestId: firstRequest(),
            answer: 'no',
          }),
          textResponse('The request was already answered.'),
          toolCallResponse('call-unknown', ANSWER_DECISION_TOOL_NAME, {
            requestId: 'decision-never-asked',
            answer: 'yes',
          }),
          textResponse('No such request.'),
        ],
      }),
    })
    const revision = await h.define(definition([agentNode('ask')]))
    const runId = await h.start(revision)
    await h.tick(runId)
    const [request] = h.requested
    if (request === undefined) throw new Error('the node recorded no decision request')
    await h.coordinator.ensureSession(h.projectId)

    await coordinatorTurn(h, 'Answer the waiting decision.')
    await coordinatorTurn(h, 'Answer it again.')
    await coordinatorTurn(h, 'Answer an unknown request.')
    const answered = await h.store.answerDecision(h.projectId, request.requestId, 'no')
    expect(answered.kind).toBe('already-answered')
    expect(answered.kind === 'unknown' ? undefined : answered.decision.response).toBe('yes')
    const texts = modelTexts(h).join('\n')
    expect(texts).toContain('already answered')
    expect(texts).toContain('records no decision request "decision-never-asked"')
  })

  it('lists pending decisions and reports project state', async () => {
    const h = await mounted({
      script: roleScript({
        node: [
          toolCallResponse('call-ask-options', DECISION_TOOL_NAME, {
            question: 'Ship it?',
            options: ['yes', 'no'],
            detail: { branch: 'main' },
          }),
          toolCallResponse('call-ask-bare', DECISION_TOOL_NAME, { question: 'Which environment?' }),
          toolCallResponse('call-ask-third', DECISION_TOOL_NAME, { question: 'Which region?' }),
        ],
        coordinator: [
          toolCallResponse('call-list', LIST_DECISIONS_TOOL_NAME, {}),
          textResponse('Listed.'),
          toolCallResponse('call-state', PROJECT_STATE_TOOL_NAME, {}),
          textResponse('Reported.'),
        ],
      }),
    })
    const revision = await h.define(definition([agentNode('ask')]))
    const firstRun = await h.start(revision)
    await h.tick(firstRun)
    const secondRun = await h.start(revision)
    await h.tick(secondRun)
    // A parked run carries a reason, which the state report names.
    await h.scheduler.reconcile({ projectId: h.projectId })
    // A run started after the recovery pass has no reason, and its waiting
    // activation carries the attempt it recorded.
    const thirdRun = await h.start(revision)
    await h.tick(thirdRun)
    await h.coordinator.ensureSession(h.projectId)

    await coordinatorTurn(h, 'List the waiting decisions.')
    await coordinatorTurn(h, 'Report the project state.')
    const texts = modelTexts(h).join('\n')
    expect(texts).toContain('Ship it?')
    expect(texts).toContain('(options: yes, no)')
    expect(texts).toContain('Which environment?')
    expect(texts).toContain('"coordinator suite"')
    expect(texts).toContain('- ask [')
    expect(texts).toContain(secondRun)
    expect(texts).toContain(thirdRun)
    expect(texts).toContain(': waiting, 1 attempt(s)')
    expect(texts).toContain('(recovered after restart)')
  })

  it('reports an empty project state before any run started', async () => {
    const h = await mounted({
      script: roleScript({
        node: [],
        coordinator: [
          toolCallResponse('call-list', LIST_DECISIONS_TOOL_NAME, {}),
          textResponse('Nothing is waiting.'),
          toolCallResponse('call-state', PROJECT_STATE_TOOL_NAME, {}),
          textResponse('Reported.'),
        ],
      }),
    })
    await h.coordinator.ensureSession(h.projectId)
    await coordinatorTurn(h, 'List the waiting decisions.')
    await coordinatorTurn(h, 'Report the project state.')
    const texts = modelTexts(h).join('\n')
    expect(texts).toContain('No decision requests are waiting in this project.')
    expect(texts).toContain('No run has started yet.')
  })
})
