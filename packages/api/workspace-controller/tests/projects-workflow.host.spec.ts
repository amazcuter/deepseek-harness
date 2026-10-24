/**
 * The workbench half of the `projects` Remote namespace: the coordinator
 * Session binding, the stored definition projection, the node tool switches and
 * edits, the pending decisions with their answers, and the run controls —
 * against a real project store, a real workspace registry, and a real
 * scheduler driving a stub executor, so every verb exercises the composition
 * the Host actually serves.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import SessionStore from '@metaworkflow/session'
import Storage from '@metaworkflow/storage'
import { DomainFacility } from '@metaworkflow/storage-domain'
import ProjectStore from '@metaworkflow/workflow-project-store'
import Scheduler, { WorkflowSchedulerError } from '@metaworkflow/workflow-scheduler'
import type { NodeActivation, NodeExecutor, NodeResult } from '@metaworkflow/workflow-scheduler'
import WorkspaceRegistry from '@metaworkflow/workspace'
import { MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import { MwProjectController } from '../src/projects.ts'

/** Identity every waiting executor records its request under. */
const DECISION_REQUEST_ID = 'request-1'

/** A project identity no registration carries, shaped like a real one. */
const UNKNOWN_PROJECT = '11111111-1111-4111-8111-111111111111' as never

const roots: Context[] = []
const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(ctx => ctx.fiber.dispose()))
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** A definition document with one python entry node and one agent node after it. */
function definitionDocument(overrides: {
  readonly title?: string
  readonly tools?: readonly string[]
  /** Whether the agent node declares one binding of each source; a run resolves none of them. */
  readonly bindings?: boolean
} = {}) {
  return JSON.stringify({
    version: 1,
    nodes: [
      {
        id: 'fetch',
        kind: 'python',
        title: overrides.title ?? 'Fetch',
        config: { kind: 'python', source: 'def nodemain_fetch(inputs):\n    return {"ok": True}\n' },
        inputs: [],
        join: 'all',
      },
      {
        id: 'review',
        kind: 'agent',
        title: 'Review',
        config: {
          kind: 'agent',
          instructions: 'Review the fetched value.',
          tools: [...overrides.tools ?? ['read']],
          memory: 'fresh',
          outputSchema: {
            type: 'object',
            properties: { ok: { type: 'boolean' } },
            required: ['ok'],
            additionalProperties: false,
          },
        },
        inputs: overrides.bindings === true
          ? [
            { name: 'previous', source: { kind: 'node', nodeId: 'fetch', field: 'ok' } },
            { name: 'seed', source: { kind: 'run', key: 'seed' } },
            { name: 'attachment', source: { kind: 'artifact', name: 'report' } },
          ]
          : [],
        join: 'all',
      },
    ],
    edges: [{ id: 'fetch-review', from: 'fetch', to: 'review', condition: null, mode: 'exclusive' }],
  })
}

/**
 * Build an executor that records one decision request and parks its activation
 * on it, so the run keeps a waiting node instead of settling. The resumed
 * attempt succeeds, which is what an answered decision looks like.
 * @param payload - the question and the choices the node offers.
 * @returns the executor that records it.
 */
function decisionExecutor(payload: {
  readonly question: string
  readonly options?: readonly string[]
}): (activation: NodeActivation, ctx: Context) => Promise<NodeResult> {
  return async (activation, ctx) => {
    if (activation.decision !== undefined) return { status: 'succeeded', value: { ok: true } }
    await ctx.mwfProjectStore.requestDecision(activation.projectId, {
      requestId: DECISION_REQUEST_ID,
      activationId: activation.activationId,
      attemptId: activation.attemptId,
      payload: {
        question: payload.question,
        ...payload.options === undefined ? {} : { options: [...payload.options] },
      },
    })
    return { status: 'waiting', requestId: DECISION_REQUEST_ID }
  }
}

/** The executor every waiting-run fixture uses: one question with two choices. */
const waitForDecision = decisionExecutor({ question: 'Which seed?', options: ['a', 'b'] })

/** Executor that reports a fixed JSON value, so a run dispatches and settles without a subprocess. */
function stubExecutor(kind: 'python' | 'agent'): NodeExecutor {
  return {
    kind,
    execute: () => Promise.resolve({ status: 'succeeded', value: { ok: true } }),
  }
}

interface HarnessOptions {
  /** Mount the coordinator stub; a composition without one serves `sessionId: null`. */
  readonly coordinator?: boolean
  /** Mount the scheduler and register stub executors; off leaves the workbench verbs unavailable. */
  readonly scheduler?: boolean
  /** Tool schemas the composition registers. */
  readonly tools?: boolean | readonly { name: string; description: string }[]
  /** Executor per node kind, replacing the stub that succeeds with `{ ok: true }`. */
  readonly executors?: Partial<Record<'python' | 'agent', (activation: NodeActivation, ctx: Context) => Promise<NodeResult>>>
}

async function harness(options: HarnessOptions = {}) {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'mwf-projects-workflow-')))
  tempDirs.push(root)
  const ctx = new Context()
  roots.push(ctx)
  await ctx.plugin(SessionStore)
  await ctx.plugin(Storage)
  ctx.storage.backend.register('memory', new MemoryStorageBackend())
  const storageDomain = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.storage.mount('domain', storageDomain)
  ctx.provide('storageDomain', storageDomain)
  ctx.provide('sessionPersistence', { list: () => Promise.resolve([]) } as never)
  await ctx.plugin(ProjectStore, { mwfHome: join(root, 'home') })
  await ctx.plugin(WorkspaceRegistry)
  const dispose = (): void => {}
  ctx.provide('typert', {
    lookups: { configure: () => dispose },
    contexts: { configureHost: () => dispose },
    resources: { register: vi.fn(() => dispose) },
  } as never)
  const ensureSession = vi.fn(async () => 'session-coordinator')
  if (options.coordinator !== false) {
    ctx.provide('mwfCoordinator', { ensureSession } as never)
  }
  if (options.scheduler !== false) {
    await ctx.plugin(Scheduler, { maxConcurrent: 1, maxAttempts: 1 })
    for (const kind of ['python', 'agent'] as const) {
      const custom = options.executors?.[kind]
      ctx.mwfScheduler.registerExecutor(custom === undefined
        ? stubExecutor(kind)
        : { kind, execute: activation => custom(activation, ctx) })
    }
  }
  if (options.tools !== false) {
    const schemas = Array.isArray(options.tools)
      ? options.tools
      : [{ name: 'read', description: 'Read a file' }, { name: 'write', description: 'Write a file' }]
    ctx.provide('tools', { schemas: () => schemas.map(schema => ({ ...schema, parameters: {} })) } as never)
  }
  const projects = new MwProjectController(ctx)
  const workspace = await ctx.workspaceRegistry.create(
    (() => {
      const path = join(root, 'project')
      mkdirSync(path, { recursive: true })
      return path
    })(),
    'Workflow project',
  )
  return { ctx, projects, id: workspace.id, ensureSession }
}

async function writeValidDefinition(
  projects: MwProjectController,
  id: Awaited<ReturnType<typeof harness>>['id'],
  overrides: Parameters<typeof definitionDocument>[0] = {},
): Promise<number> {
  const imported = await projects.importDefinition({ id, document: definitionDocument(overrides) })
  return imported.revision
}

describe('projects.coordinator', () => {
  it('opens the project coordinator Session through the Host service', async () => {
    const { projects, id, ensureSession } = await harness()
    await expect(projects.coordinator({ id })).resolves.toEqual({ sessionId: 'session-coordinator' })
    expect(ensureSession).toHaveBeenCalledWith(id)
  })

  it('reports no Session when the composition serves no coordinator', async () => {
    const { projects, id } = await harness({ coordinator: false })
    await expect(projects.coordinator({ id })).resolves.toEqual({ sessionId: null })
  })

  it('reports an unknown project instead of opening anything', async () => {
    const { projects } = await harness()
    await expect(projects.coordinator({ id: UNKNOWN_PROJECT }))
      .rejects.toMatchObject({ code: 'project/not-found' })
  })

  it('maps a coordinator failure onto the Remote vocabulary', async () => {
    const { projects, id, ensureSession } = await harness()
    ensureSession.mockRejectedValueOnce(new Error('no session backend'))
    await expect(projects.coordinator({ id })).rejects.toMatchObject({ code: 'project/invalid-path' })
  })
})

describe('projects.definition', () => {
  it('reports a project that stores no definition', async () => {
    const { projects, id } = await harness()
    await expect(projects.definition({ id })).resolves.toEqual({
      revision: 0,
      document: null,
      valid: false,
      violations: [],
      nodes: [],
    })
  })

  it('projects both node kinds with their configuration, tools, and inputs', async () => {
    const { projects, id } = await harness()
    const revision = await writeValidDefinition(projects, id, { bindings: true })
    const value = await projects.definition({ id })
    expect(value).toMatchObject({ revision, valid: true, violations: [] })
    expect(value.nodes).toEqual([
      {
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
      },
      {
        id: 'review',
        title: 'Review',
        kind: 'agent',
        source: null,
        instructions: 'Review the fetched value.',
        memory: 'fresh',
        outputSchema: expect.any(String),
        tools: ['read'],
        inputs: [
          { name: 'previous', kind: 'node', ref: 'fetch', field: 'ok' },
          { name: 'seed', kind: 'run', ref: 'seed', field: '' },
          { name: 'attachment', kind: 'artifact', ref: 'report', field: '' },
        ],
        join: 'all',
      },
    ])
  })

  it('reports an unparseable stored document instead of throwing', async () => {
    const { ctx, projects, id } = await harness()
    await ctx.mwfProjectStore.writeDefinition(id, 'version: 1')
    const value = await projects.definition({ id })
    expect(value.valid).toBe(false)
    expect(value.nodes).toEqual([])
    expect(value.violations.map(violation => violation.code)).toEqual(['definition/document-invalid-json'])
  })

  it('reports every violation of a syntactically valid but unusable document', async () => {
    const { ctx, projects, id } = await harness()
    await ctx.mwfProjectStore.writeDefinition(id, JSON.stringify({ version: 1, nodes: [{ id: 'Bad' }], edges: [] }))
    const value = await projects.definition({ id })
    expect(value.valid).toBe(false)
    expect(value.violations.length).toBeGreaterThan(0)
    expect(value.violations[0]).toMatchObject({ path: expect.any(String) })
  })

  it('reports an unknown project', async () => {
    const { projects } = await harness()
    await expect(projects.definition({ id: UNKNOWN_PROJECT }))
      .rejects.toMatchObject({ code: 'project/not-found' })
  })
})

describe('projects.importDefinition', () => {
  it('stores a valid document as the next revision in canonical form', async () => {
    const { ctx, projects, id } = await harness()
    const imported = await projects.importDefinition({ id, document: definitionDocument() })
    expect(imported).toEqual({ revision: 1, nodeCount: 2 })
    const stored = await ctx.mwfProjectStore.readDefinition(id)
    expect(stored?.revision).toBe(1)
    expect(stored?.document.startsWith('{"edges":')).toBe(true)
  })

  it('maps a storage fault while writing the document', async () => {
    const { ctx, projects, id } = await harness()
    vi.spyOn(ctx.mwfProjectStore, 'writeDefinition').mockRejectedValueOnce(new Error('disk is full'))
    await expect(projects.importDefinition({ id, document: definitionDocument() }))
      .rejects.toMatchObject({ code: 'project/invalid-path' })
  })

  it('refuses a document that does not validate and writes nothing', async () => {
    const { ctx, projects, id } = await harness()
    await expect(projects.importDefinition({ id, document: '{"version":2,"nodes":[],"edges":[]}' }))
      .rejects.toMatchObject({ code: 'project/definition-invalid' })
    await expect(ctx.mwfProjectStore.readDefinition(id)).resolves.toBeUndefined()
  })

  it('reports an unknown project', async () => {
    const { projects } = await harness()
    await expect(projects.importDefinition({ id: 'missing' as never, document: definitionDocument() }))
      .rejects.toMatchObject({ code: 'project/not-found' })
  })
})

describe('projects.availableTools', () => {
  it('lists every registered tool with the node switch state', async () => {
    const { projects, id } = await harness()
    await writeValidDefinition(projects, id)
    await expect(projects.availableTools({ id, nodeId: 'review' })).resolves.toEqual({
      items: [
        { name: 'read', description: 'Read a file', enabled: true, registered: true },
        { name: 'write', description: 'Write a file', enabled: false, registered: true },
      ],
    })
  })

  it('lists a declared tool the Host no longer registers as unwritable', async () => {
    const { projects, id } = await harness({
      tools: [{ name: 'read', description: 'Read a file' }],
    })
    await writeValidDefinition(projects, id, { tools: ['read', 'retired'] })
    await expect(projects.availableTools({ id, nodeId: 'review' })).resolves.toEqual({
      items: [
        { name: 'read', description: 'Read a file', enabled: true, registered: true },
        { name: 'retired', description: '', enabled: true, registered: false },
      ],
    })
  })

  it('lists nothing when the composition registers no tools registry', async () => {
    const { projects, id } = await harness({ tools: false })
    await writeValidDefinition(projects, id)
    await expect(projects.availableTools({ id, nodeId: 'review' })).resolves.toEqual({
      items: [{ name: 'read', description: '', enabled: true, registered: false }],
    })
  })

  it('lists no switches for a python node', async () => {
    const { projects, id } = await harness()
    await writeValidDefinition(projects, id)
    await expect(projects.availableTools({ id, nodeId: 'fetch' })).resolves.toEqual({ items: [] })
  })

  it('reports an unknown node and an absent definition', async () => {
    const { projects, id } = await harness()
    await expect(projects.availableTools({ id, nodeId: 'review' }))
      .rejects.toMatchObject({ code: 'project/definition-missing' })
    await writeValidDefinition(projects, id)
    await expect(projects.availableTools({ id, nodeId: 'missing' }))
      .rejects.toMatchObject({ code: 'project/node-not-found' })
  })
})

describe('projects.updateNode', () => {
  it('writes a new revision with the patched title and tool list', async () => {
    const { projects, id } = await harness()
    await writeValidDefinition(projects, id)
    const updated = await projects.updateNode({
      id,
      nodeId: 'review',
      patch: { title: 'Re-reviewed', tools: ['write'] },
    })
    expect(updated.revision).toBe(2)
    const value = await projects.definition({ id })
    expect(value.revision).toBe(2)
    const node = value.nodes.find(candidate => candidate.id === 'review')
    expect(node).toMatchObject({ title: 'Re-reviewed', tools: ['write'] })
  })

  it('keeps the title when only the tools change', async () => {
    const { projects, id } = await harness()
    await writeValidDefinition(projects, id)
    await projects.updateNode({ id, nodeId: 'review', patch: { tools: [] } })
    const node = (await projects.definition({ id })).nodes.find(candidate => candidate.id === 'review')
    expect(node).toMatchObject({ title: 'Review', tools: [] })
  })

  it('keeps the tool list when only the title changes', async () => {
    const { projects, id } = await harness()
    await writeValidDefinition(projects, id)
    await projects.updateNode({ id, nodeId: 'review', patch: { title: 'Renamed' } })
    const node = (await projects.definition({ id })).nodes.find(candidate => candidate.id === 'review')
    expect(node).toMatchObject({ title: 'Renamed', tools: ['read'] })
  })

  it('renames a python node without touching its source', async () => {
    const { projects, id } = await harness()
    await writeValidDefinition(projects, id)
    await projects.updateNode({ id, nodeId: 'fetch', patch: { title: 'Renamed fetch' } })
    const node = (await projects.definition({ id })).nodes.find(candidate => candidate.id === 'fetch')
    expect(node).toMatchObject({
      title: 'Renamed fetch',
      source: 'def nodemain_fetch(inputs):\n    return {"ok": True}\n',
    })
  })

  it('refuses a tool list on a python node', async () => {
    const { projects, id } = await harness()
    await writeValidDefinition(projects, id)
    await expect(projects.updateNode({ id, nodeId: 'fetch', patch: { tools: ['read'] } }))
      .rejects.toMatchObject({ code: 'gateway/bad-request' })
  })

  it('refuses a blank title without writing a revision', async () => {
    const { projects, id } = await harness()
    await writeValidDefinition(projects, id)
    await expect(projects.updateNode({ id, nodeId: 'review', patch: { title: '   ' } }))
      .rejects.toMatchObject({ code: 'project/definition-invalid' })
    expect((await projects.definition({ id })).revision).toBe(1)
  })

  it('reports an unknown node and an absent definition', async () => {
    const { projects, id } = await harness()
    await expect(projects.updateNode({ id, nodeId: 'review', patch: { title: 'x' } }))
      .rejects.toMatchObject({ code: 'project/definition-missing' })
    await writeValidDefinition(projects, id)
    await expect(projects.updateNode({ id, nodeId: 'missing', patch: { title: 'x' } }))
      .rejects.toMatchObject({ code: 'project/node-not-found' })
  })

  it('maps a storage fault while writing the edited revision', async () => {
    const { ctx, projects, id } = await harness()
    await writeValidDefinition(projects, id)
    vi.spyOn(ctx.mwfProjectStore, 'writeDefinition').mockRejectedValueOnce(new Error('disk is full'))
    await expect(projects.updateNode({ id, nodeId: 'review', patch: { title: 'Renamed' } }))
      .rejects.toMatchObject({ code: 'project/invalid-path' })
  })
})

describe('project runs', () => {
  it('starts a run from the newest definition and reports its status', async () => {
    const { projects, id } = await harness()
    await writeValidDefinition(projects, id)
    const started = await projects.startRun({ id })
    expect(started.status).toBe('succeeded')
    expect(started.runId.length).toBeGreaterThan(0)
  })

  it('maps the scheduler faults a start can report', async () => {
    const { ctx, projects, id } = await harness()
    await writeValidDefinition(projects, id)
    vi.spyOn(ctx.mwfScheduler, 'createRun').mockRejectedValueOnce(
      new WorkflowSchedulerError('scheduler/definition-unavailable', 'revision 9 is gone'),
    )
    await expect(projects.startRun({ id })).rejects.toMatchObject({ code: 'project/definition-missing' })
    vi.spyOn(ctx.mwfScheduler, 'createRun').mockRejectedValueOnce(
      new WorkflowSchedulerError('scheduler/definition-invalid', 'the graph is not executable'),
    )
    await expect(projects.startRun({ id })).rejects.toMatchObject({ code: 'project/definition-invalid' })
    vi.spyOn(ctx.mwfScheduler, 'createRun').mockRejectedValueOnce(new Error('the store is gone'))
    await expect(projects.startRun({ id })).rejects.toMatchObject({ code: 'project/invalid-path' })
  })

  it('refuses to start a run without a stored definition', async () => {
    const { projects, id } = await harness()
    await expect(projects.startRun({ id })).rejects.toMatchObject({ code: 'project/definition-missing' })
  })

  it('refuses to start a run from a stored document that no longer validates', async () => {
    const { ctx, projects, id } = await harness()
    await ctx.mwfProjectStore.writeDefinition(id, JSON.stringify({ version: 1, nodes: [], edges: [] }))
    await expect(projects.startRun({ id })).rejects.toMatchObject({ code: 'project/definition-invalid' })
  })

  it('pauses and resumes a run, reporting the status after each transition', async () => {
    const { projects, id } = await harness({ executors: { python: waitForDecision } })
    await writeValidDefinition(projects, id)
    const started = await projects.startRun({ id })
    expect(started.status).toBe('running')
    await expect(projects.pause({ id, runId: started.runId })).resolves.toEqual({
      runId: started.runId,
      status: 'paused',
    })
    await expect(projects.resume({ id, runId: started.runId })).resolves.toEqual({
      runId: started.runId,
      status: 'running',
    })
  })

  it('maps a scheduler refusal of an unknown run', async () => {
    const { projects, id } = await harness()
    await expect(projects.pause({ id, runId: 'missing' }))
      .rejects.toMatchObject({ code: 'project/run-unavailable' })
    await expect(projects.resume({ id, runId: 'missing' }))
      .rejects.toMatchObject({ code: 'project/run-unavailable' })
  })

  it('maps the scheduler faults a control call can report', async () => {
    const { ctx, projects, id } = await harness({ executors: { python: waitForDecision } })
    await writeValidDefinition(projects, id)
    const started = await projects.startRun({ id })
    vi.spyOn(ctx.mwfScheduler, 'resume').mockRejectedValueOnce(
      new WorkflowSchedulerError('scheduler/run-not-found', 'the run was deleted'),
    )
    await expect(projects.resume({ id, runId: started.runId }))
      .rejects.toMatchObject({ code: 'project/run-unavailable' })
    vi.spyOn(ctx.mwfScheduler, 'resume').mockRejectedValueOnce(
      new WorkflowSchedulerError('scheduler/run-state-invalid', 'the run already settled'),
    )
    await expect(projects.resume({ id, runId: started.runId }))
      .rejects.toMatchObject({ code: 'gateway/bad-request' })
  })

  it('reports a disposed scheduler as a host fault', async () => {
    const { ctx, projects, id } = await harness()
    await writeValidDefinition(projects, id)
    const started = await projects.startRun({ id })
    vi.spyOn(ctx.mwfScheduler, 'pause').mockRejectedValueOnce(
      new WorkflowSchedulerError('scheduler/closed', 'the scheduler is closed'),
    )
    await expect(projects.pause({ id, runId: started.runId }))
      .rejects.toMatchObject({ code: 'gateway/internal' })
  })

  it('reports the workflow verbs unavailable without a scheduler', async () => {
    const { projects, id } = await harness({ scheduler: false })
    await writeValidDefinition(projects, id)
    for (const call of [
      () => projects.startRun({ id }),
      () => projects.pause({ id, runId: 'any' }),
      () => projects.resume({ id, runId: 'any' }),
      () => projects.attempts({ id }),
      () => projects.answerDecision({ id, requestId: 'any', answer: 'yes' }),
    ]) {
      await expect(call()).rejects.toMatchObject({ code: 'project/workflow-unavailable' })
    }
  })
})

describe('projects.runs', () => {
  it('reports no run before the project has started one', async () => {
    const { projects, id } = await harness()
    await expect(projects.runs({ id })).resolves.toEqual({ items: [] })
  })

  it('lists every settled run newest first with the instants it reached', async () => {
    const { projects, id } = await harness()
    await writeValidDefinition(projects, id)
    const first = await projects.startRun({ id })
    const second = await projects.startRun({ id })
    const { items } = await projects.runs({ id })
    expect(items.map(item => [item.runId, item.status, item.reason])).toEqual([
      [second.runId, 'succeeded', null],
      [first.runId, 'succeeded', null],
    ])
    expect(items[0]).toMatchObject({
      definitionRevision: 1,
      startedAt: expect.any(Number),
      endedAt: expect.any(Number),
    })
  })

  it('reports no end instant for a run that can still advance', async () => {
    const { projects, id } = await harness({ executors: { python: waitForDecision } })
    await writeValidDefinition(projects, id)
    const started = await projects.startRun({ id })
    const running = await projects.runs({ id })
    expect(running.items[0]).toMatchObject({ runId: started.runId, endedAt: null })
    await projects.pause({ id, runId: started.runId })
    await expect(projects.runs({ id })).resolves.toMatchObject({
      items: [{ runId: started.runId, status: 'paused', endedAt: null }],
    })
  })

  it('reports an unknown project', async () => {
    const { projects } = await harness()
    await expect(projects.runs({ id: UNKNOWN_PROJECT })).rejects.toMatchObject({ code: 'project/not-found' })
  })
})

describe('projects.attempts', () => {
  it('reports no run before the project has started one', async () => {
    const { projects, id } = await harness()
    await expect(projects.attempts({ id })).resolves.toEqual({ run: null, items: [] })
  })

  it('reads the newest run with its activations and attempts', async () => {
    const { projects, id } = await harness()
    await writeValidDefinition(projects, id)
    const started = await projects.startRun({ id })
    const value = await projects.attempts({ id })
    expect(value.run).toMatchObject({
      runId: started.runId,
      status: 'succeeded',
      definitionRevision: 1,
      reason: null,
    })
    expect(value.run?.activations.map(activation => [activation.nodeId, activation.status])).toEqual([
      ['fetch', 'succeeded'],
      ['review', 'succeeded'],
    ])
    expect(value.items.map(attempt => [attempt.nodeId, attempt.attemptNo, attempt.status, attempt.error]))
      .toEqual([['fetch', 1, 'succeeded', null], ['review', 1, 'succeeded', null]])
    expect(value.items[0]).toMatchObject({ startedAt: expect.any(Number), endedAt: expect.any(Number) })
  })

  it('reads one named run and reports an unknown one', async () => {
    const { projects, id } = await harness()
    await writeValidDefinition(projects, id)
    const started = await projects.startRun({ id })
    await expect(projects.attempts({ id, runId: started.runId })).resolves.toMatchObject({
      run: { runId: started.runId },
    })
    await expect(projects.attempts({ id, runId: 'missing' }))
      .rejects.toMatchObject({ code: 'project/run-unavailable' })
  })

  it('reports the failure an attempt recorded', async () => {
    const { projects, id } = await harness({
      executors: {
        agent: () => Promise.resolve({
          status: 'failed',
          error: { code: 'agent/failed', message: 'the reviewer refused' },
          retryable: false,
        }),
      },
    })
    await writeValidDefinition(projects, id)
    await expect(projects.startRun({ id })).resolves.toMatchObject({ status: 'failed' })
    const value = await projects.attempts({ id })
    const failed = value.items.find(attempt => attempt.nodeId === 'review')
    expect(failed).toMatchObject({ status: 'failed', error: 'the reviewer refused' })
  })

  it('reports a run the scheduler no longer reads back', async () => {
    const { ctx, projects, id } = await harness()
    await writeValidDefinition(projects, id)
    const started = await projects.startRun({ id })
    vi.spyOn(ctx.mwfScheduler, 'getRun').mockResolvedValueOnce(undefined)
    await expect(projects.attempts({ id })).rejects.toMatchObject({ code: 'project/run-unavailable' })
    expect(started.runId.length).toBeGreaterThan(0)
  })

  it('maps a scheduler fault onto a Remote failure', async () => {
    const { ctx, projects, id } = await harness()
    await writeValidDefinition(projects, id)
    await projects.startRun({ id })
    vi.spyOn(ctx.mwfScheduler, 'getRun').mockRejectedValueOnce(
      new WorkflowSchedulerError('scheduler/closed', 'the scheduler is closed'),
    )
    await expect(projects.attempts({ id })).rejects.toMatchObject({ code: 'gateway/internal' })
  })
})

describe('project decisions', () => {
  /** One run parked with a node waiting for an answer. */
  async function waitingRun(): Promise<Awaited<ReturnType<typeof harness>> & { runId: string; requestId: string }> {
    const harnessed = await harness({ executors: { python: waitForDecision } })
    const { projects, id } = harnessed
    await writeValidDefinition(projects, id)
    const started = await projects.startRun({ id })
    return { ...harnessed, runId: started.runId, requestId: DECISION_REQUEST_ID }
  }

  it('lists the decisions the project waits on', async () => {
    const { projects, id } = await waitingRun()
    const value = await projects.pendingDecisions({ id })
    expect(value.items).toHaveLength(1)
    expect(value.items[0]).toMatchObject({
      requestId: DECISION_REQUEST_ID,
      nodeId: 'fetch',
      question: 'Which seed?',
      options: ['a', 'b'],
    })
  })

  it('lists a decision that offers no choices', async () => {
    const { projects, id } = await harness({
      executors: { python: decisionExecutor({ question: 'Proceed?' }) },
    })
    await writeValidDefinition(projects, id)
    await projects.startRun({ id })
    const value = await projects.pendingDecisions({ id })
    expect(value.items[0]).toMatchObject({ question: 'Proceed?', options: [] })
  })

  it('maps a resumed activation the scheduler refuses for another reason', async () => {
    const { ctx, projects, id } = await waitingRun()
    vi.spyOn(ctx.mwfScheduler, 'resumeActivation').mockRejectedValueOnce(new Error('the executor is gone'))
    await expect(projects.answerDecision({ id, requestId: DECISION_REQUEST_ID, answer: 'a' }))
      .rejects.toMatchObject({ code: 'project/invalid-path' })
  })

  it('records an answer and resumes the waiting activation', async () => {
    const { projects, id } = await waitingRun()
    const answered = await projects.answerDecision({ id, requestId: DECISION_REQUEST_ID, answer: 'a' })
    expect(answered).toMatchObject({ answered: true, runStatus: 'succeeded' })
    await expect(projects.pendingDecisions({ id })).resolves.toEqual({ items: [] })
  })

  it('refuses a blank answer', async () => {
    const { projects, id } = await waitingRun()
    await expect(projects.answerDecision({ id, requestId: DECISION_REQUEST_ID, answer: '   ' }))
      .rejects.toMatchObject({ code: 'gateway/bad-request' })
  })

  it('refuses an answer for a request the project does not wait on', async () => {
    const { projects, id } = await waitingRun()
    await expect(projects.answerDecision({ id, requestId: 'other', answer: 'a' }))
      .rejects.toMatchObject({ code: 'project/decision-unavailable' })
  })

  it('maps a scheduler refusal of the resumed activation', async () => {
    const { ctx, projects, id } = await waitingRun()
    vi.spyOn(ctx.mwfScheduler, 'resumeActivation').mockRejectedValueOnce(
      new WorkflowSchedulerError('scheduler/activation-not-resumable', 'the activation already ran'),
    )
    await expect(projects.answerDecision({ id, requestId: DECISION_REQUEST_ID, answer: 'a' }))
      .rejects.toMatchObject({ code: 'gateway/bad-request' })
  })

  it('reports an unknown project for every decision verb', async () => {
    const { projects } = await harness()
    const id = UNKNOWN_PROJECT
    await expect(projects.pendingDecisions({ id })).rejects.toMatchObject({ code: 'project/not-found' })
    await expect(projects.answerDecision({ id, requestId: 'r', answer: 'a' }))
      .rejects.toMatchObject({ code: 'project/not-found' })
    await expect(projects.attempts({ id })).rejects.toMatchObject({ code: 'project/not-found' })
    await expect(projects.startRun({ id })).rejects.toMatchObject({ code: 'project/not-found' })
    await expect(projects.pause({ id, runId: 'r' })).rejects.toMatchObject({ code: 'project/not-found' })
    await expect(projects.resume({ id, runId: 'r' })).rejects.toMatchObject({ code: 'project/not-found' })
  })
})
