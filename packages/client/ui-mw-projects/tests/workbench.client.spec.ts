/**
 * The workbench controller: one project's definition, tool switches, decisions,
 * newest run, and run history read through the `projects` Remote namespace,
 * published as one snapshot the panel renders.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RemoteError } from '@metaworkflow/client-test-runtime'
import { ok, RemoteMock } from '@metaworkflow/remote-mock'
import type {
  ProjectAttemptView,
  ProjectDefinitionValue,
  ProjectNodeView,
  ProjectPendingDecisionView,
  ProjectRunsValue,
  ProjectRunSummaryView,
  ProjectRunView,
} from '@metaworkflow/api-workspace-controller/types'
import type { ProjectId } from '../src/client/projects.ts'
import { WorkbenchController, type WorkbenchSnapshot } from '../src/client/workbench.ts'

const PROJECT = 'project-1' as ProjectId

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

/** One python node fixture. */
function pythonNode(overrides: Partial<ProjectNodeView> = {}): ProjectNodeView {
  return {
    id: 'fetch',
    title: 'Fetch',
    kind: 'python',
    source: 'def nodemain_fetch(inputs):\n    return {"ok": True}\n',
    instructions: null,
    memory: null,
    outputSchema: null,
    tools: [],
    inputs: [],
    join: 'all',
    ...overrides,
  }
}

/** One agent node fixture. */
function agentNode(overrides: Partial<ProjectNodeView> = {}): ProjectNodeView {
  return {
    id: 'review',
    title: 'Review',
    kind: 'agent',
    source: null,
    instructions: 'Review it.',
    memory: 'fresh',
    outputSchema: '{\n  "type": "object"\n}',
    tools: ['read'],
    inputs: [{ name: 'previous', kind: 'node', ref: 'fetch', field: 'ok' }],
    join: 'all',
    ...overrides,
  }
}

/** One stored definition fixture. */
function definition(overrides: Partial<ProjectDefinitionValue> = {}): ProjectDefinitionValue {
  return {
    revision: 1,
    document: '{}',
    valid: true,
    violations: [],
    nodes: [pythonNode(), agentNode()],
    ...overrides,
  }
}

/** One run fixture. */
function run(overrides: Partial<ProjectRunView> = {}): ProjectRunView {
  return {
    runId: 'run-1',
    definitionRevision: 1,
    status: 'succeeded',
    reason: null,
    createdAt: 1,
    updatedAt: 2,
    activations: [
      { activationId: 'a1', nodeId: 'fetch', iteration: 0, status: 'succeeded' },
      { activationId: 'a2', nodeId: 'review', iteration: 0, status: 'waiting' },
    ],
    ...overrides,
  }
}

/** One attempt fixture. */
function attempt(overrides: Partial<ProjectAttemptView> = {}): ProjectAttemptView {
  return {
    attemptId: 'attempt-1',
    activationId: 'a1',
    nodeId: 'fetch',
    attemptNo: 1,
    status: 'succeeded',
    startedAt: 1,
    endedAt: 2,
    error: null,
    ...overrides,
  }
}

/** One run-history row fixture. */
function runSummary(overrides: Partial<ProjectRunSummaryView> = {}): ProjectRunSummaryView {
  return {
    runId: 'run-1',
    definitionRevision: 1,
    status: 'succeeded',
    startedAt: 1,
    endedAt: 2,
    reason: null,
    ...overrides,
  }
}

/** The run history the review bench answers with. */
function runs(overrides: Partial<ProjectRunsValue> = {}): ProjectRunsValue {
  return { items: [runSummary()], ...overrides }
}

/** One pending decision fixture. */
function decision(overrides: Partial<ProjectPendingDecisionView> = {}): ProjectPendingDecisionView {
  return {
    requestId: 'request-1',
    runId: 'run-1',
    nodeId: 'review',
    question: 'Which seed?',
    options: ['a'],
    createdAt: 1,
    ...overrides,
  }
}

/** A bench with every verb the controller reads registered against fixtures. */
function bench() {
  const mock = RemoteMock.create()
  mock.unary('projects/coordinator', () => ok({ sessionId: 'session-coordinator' }))
  mock.unary('projects/definition', () => ok(definition()))
  mock.unary('projects/pendingDecisions', () => ok({ items: [decision()] }))
  mock.unary('projects/attempts', () => ok({ run: run(), items: [attempt()] }))
  mock.unary('projects/runs', () => ok(runs()))
  mock.unary('projects/availableTools', () => ok({
    items: [
      { name: 'read', description: 'Read a file', enabled: true, registered: true },
      { name: 'write', description: 'Write a file', enabled: false, registered: true },
    ],
  }))
  mock.unary('projects/updateNode', () => ok({ revision: 2 }))
  mock.unary('projects/startRun', () => ok({ runId: 'run-1', status: 'running' }))
  mock.unary('projects/pause', () => ok({ runId: 'run-1', status: 'paused' }))
  mock.unary('projects/resume', () => ok({ runId: 'run-1', status: 'running' }))
  mock.unary('projects/answerDecision', () => ok({ answered: true, runStatus: 'succeeded' }))
  const controller = new WorkbenchController(mock.remote.projects)
  return { mock, controller, snapshot: (): WorkbenchSnapshot => controller.view.getSnapshot() }
}

describe('WorkbenchController open', () => {
  it('reads the coordinator, definition, decisions, and run, and selects the first node', async () => {
    const b = bench()
    await b.controller.open(PROJECT)
    const snapshot = b.snapshot()
    expect(snapshot.projectId).toBe(PROJECT)
    expect(snapshot.coordinator).toEqual({ status: 'ready', sessionId: 'session-coordinator' })
    expect(snapshot.definition).toMatchObject({ status: 'ready', revision: 1, valid: true })
    expect(snapshot.definition.nodes.map(node => node.id)).toEqual(['fetch', 'review'])
    expect(snapshot.selectedNodeId).toBe('fetch')
    expect(snapshot.decisions).toEqual([decision()])
    expect(snapshot.run).toMatchObject({ runId: 'run-1', status: 'succeeded' })
    expect(snapshot.attempts).toEqual([attempt()])
    expect(snapshot.runs).toEqual({ status: 'ready', items: [runSummary()] })
    expect(snapshot.definition.document).toBe('{}')
    expect(snapshot.failure).toBeNull()
    expect(b.mock.remote.projects.availableTools).toHaveBeenCalledWith({ id: PROJECT, nodeId: 'fetch' })
  })

  it('reports a Host without a coordinator and a project without a definition', async () => {
    const b = bench()
    b.mock.unary('projects/coordinator', () => ok({ sessionId: null }))
    b.mock.unary('projects/definition', () => ok({
      revision: 0,
      document: null,
      valid: false,
      violations: [],
      nodes: [],
    }))
    b.mock.unary('projects/attempts', () => ok({ run: null, items: [] }))
    await b.controller.open(PROJECT)
    const snapshot = b.snapshot()
    expect(snapshot.coordinator.sessionId).toBeNull()
    expect(snapshot.definition.nodes).toEqual([])
    expect(snapshot.selectedNodeId).toBeNull()
    expect(snapshot.run).toBeNull()
    expect(snapshot.attempts).toEqual([])
    expect(b.mock.remote.projects.availableTools).not.toHaveBeenCalled()
  })

  it('reports an unreadable definition and keeps the other reads', async () => {
    const b = bench()
    b.mock.unary('projects/definition', () => ({ ok: false, error: new RemoteError('project/definition-missing', 'none', {}) }))
    await b.controller.open(PROJECT)
    expect(b.snapshot().definition).toMatchObject({
      status: 'error',
      failure: { code: 'project/definition-missing', message: 'none' },
      nodes: [],
    })
    expect(b.snapshot().failure).toEqual({ code: 'project/definition-missing', message: 'none' })
    expect(b.snapshot().decisions).toHaveLength(1)
  })

  it('drops the decisions and the run when those reads fail', async () => {
    const b = bench()
    b.mock.unary('projects/pendingDecisions', () => ({ ok: false, error: new RemoteError('project/not-found', 'gone', {}) }))
    b.mock.unary('projects/attempts', () => ({ ok: false, error: new RemoteError('project/workflow-unavailable', 'no scheduler', { capability: 'mwfScheduler' }) }))
    b.mock.unary('projects/coordinator', () => ({ ok: false, error: new RemoteError('project/not-found', 'gone', {}) }))
    await b.controller.open(PROJECT)
    const snapshot = b.snapshot()
    expect(snapshot.coordinator.sessionId).toBeNull()
    expect(snapshot.decisions).toEqual([])
    expect(snapshot.run).toBeNull()
    expect(snapshot.failure).toEqual({ code: 'project/not-found', message: 'gone' })
  })

  it('publishes a carrier fault as a failure instead of rejecting', async () => {
    const b = bench()
    b.mock.unary('projects/definition', () => { throw new Error('the carrier closed') })
    await b.controller.open(PROJECT)
    expect(b.snapshot().definition).toMatchObject({
      status: 'error',
      failure: { code: 'gateway/internal', message: 'the carrier closed' },
    })
  })

  it('publishes a non-Error carrier fault as its stringified value', async () => {
    const b = bench()
    b.mock.unary('projects/attempts', () => { throw 'socket closed' })
    await b.controller.open(PROJECT)
    expect(b.snapshot().failure).toEqual({ code: 'gateway/internal', message: 'socket closed' })
  })

  it('notifies every subscriber of the snapshot and keeps its identity between changes', async () => {
    const b = bench()
    const seen: WorkbenchSnapshot[] = []
    const unsubscribe = b.controller.view.subscribe(() => { seen.push(b.snapshot()) })
    const before = b.snapshot()
    expect(b.controller.view.getSnapshot()).toBe(before)
    await b.controller.open(PROJECT)
    expect(seen.length).toBeGreaterThan(0)
    expect(seen.at(-1)?.projectId).toBe(PROJECT)
    unsubscribe()
    const settled = seen.length
    b.controller.reset()
    expect(seen.length).toBe(settled)
  })

  it('keeps the newer open when an older one settles later', async () => {
    const b = bench()
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    let calls = 0
    b.mock.unary('projects/definition', async () => {
      calls += 1
      if (calls === 1) await gate
      return ok(definition({ revision: calls === 1 ? 7 : 9 }))
    })
    const first = b.controller.open(PROJECT)
    await b.controller.open('project-2' as ProjectId)
    release()
    await first
    expect(b.snapshot().definition.revision).toBe(9)
    expect(b.snapshot().projectId).toBe('project-2')
  })
})

describe('WorkbenchController selection and edits', () => {
  it('selects a node and reads its switches', async () => {
    const b = bench()
    await b.controller.open(PROJECT)
    await b.controller.selectNode('review')
    expect(b.snapshot().selectedNodeId).toBe('review')
    expect(b.snapshot().tools).toEqual({
      nodeId: 'review',
      status: 'ready',
      items: [
        { name: 'read', description: 'Read a file', enabled: true, registered: true },
        { name: 'write', description: 'Write a file', enabled: false, registered: true },
      ],
    })
  })

  it('selects a node the definition no longer holds without asking for switches', async () => {
    const b = bench()
    await b.controller.open(PROJECT)
    b.mock.remote.projects.availableTools.mockClear()
    await b.controller.selectNode('missing')
    expect(b.snapshot().selectedNodeId).toBe('missing')
    expect(b.snapshot().tools).toEqual({ nodeId: 'missing', status: 'loading', items: [] })
    expect(b.mock.remote.projects.availableTools).not.toHaveBeenCalled()
  })

  it('reports a failed switch read with an empty list', async () => {
    const b = bench()
    await b.controller.open(PROJECT)
    b.mock.unary('projects/availableTools', () => ({ ok: false, error: new RemoteError('project/node-not-found', 'nope', { nodeId: 'review' }) }))
    await b.controller.selectNode('review')
    expect(b.snapshot().tools).toEqual({ nodeId: 'review', status: 'ready', items: [] })
    expect(b.snapshot().failure).toEqual({ code: 'project/node-not-found', message: 'nope' })
  })

  it('does nothing without an open project', async () => {
    const b = bench()
    await b.controller.selectNode('review')
    await b.controller.refresh()
    await b.controller.pauseRun()
    await b.controller.resumeRun()
    expect(b.snapshot().projectId).toBeNull()
    expect(b.mock.remote.projects.availableTools).not.toHaveBeenCalled()
    expect(b.mock.remote.projects.pause).not.toHaveBeenCalled()
  })

  it('saves a title and re-reads the definition with that node still selected', async () => {
    const b = bench()
    await b.controller.open(PROJECT)
    await b.controller.selectNode('review')
    b.mock.unary('projects/definition', () => ok(definition({ revision: 2 })))
    await b.controller.setNodeTitle('review', 'Re-reviewed')
    expect(b.mock.remote.projects.updateNode).toHaveBeenCalledWith({
      id: PROJECT,
      nodeId: 'review',
      patch: { title: 'Re-reviewed' },
    })
    expect(b.snapshot().definition.revision).toBe(2)
    expect(b.snapshot().selectedNodeId).toBe('review')
    expect(b.snapshot().busy).toBe(false)
  })

  it('publishes a failed edit and keeps the previous definition', async () => {
    const b = bench()
    await b.controller.open(PROJECT)
    b.mock.unary('projects/updateNode', () => ({ ok: false, error: new RemoteError('gateway/bad-request', 'blank', {}) }))
    await b.controller.setNodeTitle('review', '   ')
    expect(b.snapshot().failure).toEqual({ code: 'gateway/bad-request', message: 'blank' })
    expect(b.snapshot().definition.revision).toBe(1)
    expect(b.snapshot().busy).toBe(false)
  })

  it('adds a missing tool, keeps an existing one, and removes one', async () => {
    const b = bench()
    await b.controller.open(PROJECT)
    await b.controller.selectNode('review')
    await b.controller.toggleTool('review', 'write', true)
    expect(b.mock.remote.projects.updateNode).toHaveBeenLastCalledWith({
      id: PROJECT,
      nodeId: 'review',
      patch: { tools: ['read', 'write'] },
    })
    await b.controller.toggleTool('review', 'read', true)
    expect(b.mock.remote.projects.updateNode).toHaveBeenLastCalledWith({
      id: PROJECT,
      nodeId: 'review',
      patch: { tools: ['read'] },
    })
    await b.controller.toggleTool('review', 'read', false)
    expect(b.mock.remote.projects.updateNode).toHaveBeenLastCalledWith({
      id: PROJECT,
      nodeId: 'review',
      patch: { tools: [] },
    })
  })

  it('toggles a tool of a node the definition does not hold as an empty list', async () => {
    const b = bench()
    await b.controller.open(PROJECT)
    await b.controller.toggleTool('missing', 'read', true)
    expect(b.mock.remote.projects.updateNode).toHaveBeenLastCalledWith({
      id: PROJECT,
      nodeId: 'missing',
      patch: { tools: ['read'] },
    })
  })
})

describe('WorkbenchController runs and decisions', () => {
  it('starts a run and re-reads the run state', async () => {
    const b = bench()
    await b.controller.open(PROJECT)
    b.mock.unary('projects/attempts', () => ok({ run: run({ status: 'running' }), items: [attempt()] }))
    await b.controller.startRun()
    expect(b.mock.remote.projects.startRun).toHaveBeenCalledWith({ id: PROJECT })
    expect(b.snapshot().run).toMatchObject({ status: 'running' })
    expect(b.snapshot().busy).toBe(false)
  })

  it('publishes a refused start', async () => {
    const b = bench()
    await b.controller.open(PROJECT)
    b.mock.unary('projects/startRun', () => ({ ok: false, error: new RemoteError('project/definition-invalid', 'bad graph', { violations: ['definition/node-title-empty'] }) }))
    await b.controller.startRun()
    expect(b.snapshot().failure).toEqual({ code: 'project/definition-invalid', message: 'bad graph' })
  })

  it('pauses and resumes the run on screen', async () => {
    const b = bench()
    await b.controller.open(PROJECT)
    await b.controller.pauseRun()
    expect(b.mock.remote.projects.pause).toHaveBeenCalledWith({ id: PROJECT, runId: 'run-1' })
    await b.controller.resumeRun()
    expect(b.mock.remote.projects.resume).toHaveBeenCalledWith({ id: PROJECT, runId: 'run-1' })
  })

  it('answers a decision and re-reads what the project now waits on', async () => {
    const b = bench()
    await b.controller.open(PROJECT)
    b.mock.unary('projects/pendingDecisions', () => ok({ items: [] }))
    await b.controller.answerDecision('request-1', 'a')
    expect(b.mock.remote.projects.answerDecision).toHaveBeenCalledWith({
      id: PROJECT,
      requestId: 'request-1',
      answer: 'a',
    })
    expect(b.snapshot().decisions).toEqual([])
  })

  it('publishes a refused answer', async () => {
    const b = bench()
    await b.controller.open(PROJECT)
    b.mock.unary('projects/answerDecision', () => ({ ok: false, error: new RemoteError('project/decision-unavailable', 'answered', { requestId: 'request-1' }) }))
    await b.controller.answerDecision('request-1', 'a')
    expect(b.snapshot().failure).toEqual({ code: 'project/decision-unavailable', message: 'answered' })
  })

  it('re-reads the pending decisions and the run while a project is open', async () => {
    vi.useFakeTimers()
    const b = bench()
    await b.controller.open(PROJECT)
    const reads = b.mock.remote.projects.pendingDecisions.mock.calls.length
    b.mock.unary('projects/pendingDecisions', () => ok({ items: [decision({ requestId: 'request-2' })] }))
    await vi.advanceTimersByTimeAsync(4000)
    expect(b.mock.remote.projects.pendingDecisions.mock.calls.length).toBeGreaterThan(reads)
    expect(b.snapshot().decisions.map(item => item.requestId)).toEqual(['request-2'])
  })

  it('re-reads the run history while a project is open', async () => {
    vi.useFakeTimers()
    const b = bench()
    await b.controller.open(PROJECT)
    b.mock.unary('projects/runs', () => ok(runs({
      items: [runSummary({ runId: 'run-2', status: 'running', endedAt: null }), runSummary()],
    })))
    await vi.advanceTimersByTimeAsync(4000)
    expect(b.snapshot().runs.items.map(item => [item.runId, item.status])).toEqual([
      ['run-2', 'running'],
      ['run-1', 'succeeded'],
    ])
  })

  it('keeps the history it already holds when the runs read fails', async () => {
    const b = bench()
    await b.controller.open(PROJECT)
    b.mock.unary('projects/runs', () => ({ ok: false, error: new RemoteError('project/not-found', 'gone', {}) }))
    await b.controller.refresh()
    expect(b.snapshot().runs).toEqual({ status: 'ready', items: [runSummary()] })
  })

  it('keeps the history it already holds when a polled runs read fails', async () => {
    vi.useFakeTimers()
    const b = bench()
    await b.controller.open(PROJECT)
    b.mock.unary('projects/runs', () => ({ ok: false, error: new RemoteError('project/not-found', 'gone', {}) }))
    await vi.advanceTimersByTimeAsync(4000)
    expect(b.snapshot().runs).toEqual({ status: 'ready', items: [runSummary()] })
  })

  it('keeps the last decisions when a polled read fails', async () => {
    vi.useFakeTimers()
    const b = bench()
    await b.controller.open(PROJECT)
    b.mock.unary('projects/pendingDecisions', () => ({ ok: false, error: new RemoteError('project/not-found', 'gone', {}) }))
    b.mock.unary('projects/attempts', () => ({ ok: false, error: new RemoteError('project/not-found', 'gone', {}) }))
    await vi.advanceTimersByTimeAsync(4000)
    expect(b.snapshot().decisions).toHaveLength(1)
    expect(b.snapshot().run).toMatchObject({ runId: 'run-1' })
    expect(b.snapshot().failure).toBeNull()
  })

  it('drops a polled read that a later open superseded', async () => {
    vi.useFakeTimers()
    const b = bench()
    await b.controller.open(PROJECT)
    let releaseOpen!: () => void
    const openGate = new Promise<void>((resolve) => { releaseOpen = resolve })
    let definitions = 0
    b.mock.unary('projects/definition', async () => {
      definitions += 1
      // The second read belongs to the second open, which stays in flight while
      // the first project's timer fires.
      if (definitions === 2) await openGate
      return ok(definition())
    })
    const reopen = b.controller.open('project-2' as ProjectId)
    b.mock.unary('projects/pendingDecisions', () => ok({ items: [decision({ requestId: 'request-stale' })] }))
    vi.advanceTimersByTime(4000)
    await vi.advanceTimersByTimeAsync(0)
    releaseOpen()
    await reopen
    expect(b.snapshot().projectId).toBe('project-2')
    // The second open's own read wins; the tick that belonged to the first
    // project never publishes its rows.
    expect(b.snapshot().decisions.map(item => item.requestId)).toEqual(['request-1'])
  })

  it('stops re-reading once the project is forgotten', async () => {
    vi.useFakeTimers()
    const b = bench()
    await b.controller.open(PROJECT)
    b.controller.reset()
    const reads = b.mock.remote.projects.pendingDecisions.mock.calls.length
    await vi.advanceTimersByTimeAsync(12000)
    expect(b.mock.remote.projects.pendingDecisions.mock.calls.length).toBe(reads)
  })

  it('re-reads the open project on refresh and forgets it on reset', async () => {
    const b = bench()
    await b.controller.open(PROJECT)
    b.mock.unary('projects/definition', () => ok(definition({ revision: 4 })))
    await b.controller.refresh()
    expect(b.snapshot().definition.revision).toBe(4)
    b.controller.reset()
    expect(b.snapshot()).toMatchObject({
      projectId: null,
      decisions: [],
      run: null,
      attempts: [],
      busy: false,
      failure: null,
    })
    expect(b.snapshot().definition.status).toBe('loading')
  })
})
