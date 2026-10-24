/**
 * Unit checks of the scheduler's pure decisions, its row parsers, and the
 * executor registry.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { brandString } from '@metaworkflow/brand'
import { serializeDefinition } from '@metaworkflow/workflow-definition'
import type { WorkflowDefinition } from '@metaworkflow/workflow-definition'
import type { ActivationId, AttemptId, RunId } from '@metaworkflow/workflow-project-store'
import { WorkflowSchedulerError } from '../src/index.ts'
import { ExecutorRegistry } from '../src/executors.ts'
import { assembleInputs } from '../src/inputs.ts'
import { selectAttempt } from '../src/records.ts'
import type { ActivationRow } from '../src/records.ts'
import {
  activationIndex,
  activationReady,
  edgeIndex,
  entryNode,
  isTerminal,
  nodeIndex,
  readyActivations,
  requireNode,
  routingFailureReason,
  settleStatus,
  targetIteration,
} from '../src/schedule.ts'
import type { NodeExecutor } from '../src/index.ts'
import { FakeExecutor, define, definition, edge, harness, loopEdge, pythonNode } from './support/harness.ts'
import type { Harness } from './support/harness.ts'

const harnesses: Harness[] = []

afterEach(async () => {
  for (const mounted of harnesses.splice(0)) await mounted.close()
})

async function mounted(): Promise<Harness> {
  const created = await harness()
  harnesses.push(created)
  return created
}

/** One stored activation row. */
function activationRow(
  nodeId: string,
  status: ActivationRow['status'],
  incoming: ActivationRow['incoming'] = [],
  iteration = 0,
): ActivationRow {
  return {
    activationId: brandString<ActivationId>(`${nodeId}-${String(iteration)}`),
    runId: brandString<RunId>('run-1'),
    nodeId,
    iteration,
    status,
    incoming,
    createdAt: 1,
    updatedAt: 1,
  }
}

/** A two-node definition whose second node joins on the first. */
function linear(): WorkflowDefinition {
  return definition([pythonNode('a'), pythonNode('b')], [edge('a', 'b')])
}

describe('schedule arithmetic', () => {
  it('indexes nodes and edges by id and finds the entry node', () => {
    const graph = linear()
    expect([...nodeIndex(graph).keys()]).toEqual(['a', 'b'])
    expect([...edgeIndex(graph).keys()]).toEqual(['a-b'])
    expect(entryNode(graph).id).toBe('a')
    const cyclic = definition([pythonNode('a')], [edge('a', 'a', { id: 'a-a' })])
    expect(() => entryNode(cyclic)).toThrow(/one entry node/u)
  })

  it('reports terminal activation statuses', () => {
    expect(isTerminal('succeeded')).toBe(true)
    expect(isTerminal('failed')).toBe(true)
    expect(isTerminal('canceled')).toBe(true)
    expect(isTerminal('pending')).toBe(false)
    expect(isTerminal('running')).toBe(false)
    expect(isTerminal('waiting')).toBe(false)
  })

  it('fires the entry activation and waits for the declared predecessor', () => {
    const graph = linear()
    const index = activationIndex([activationRow('a', 'pending'), activationRow('b', 'pending', [{ nodeId: 'a', iteration: 0 }])])
    const nodes = nodeIndex(graph)
    const entry = activationRow('a', 'pending')
    const follower = activationRow('b', 'pending', [{ nodeId: 'a', iteration: 0 }])
    expect(activationReady(graph, requireNode(nodes, 'a'), entry, index)).toBe(true)
    expect(activationReady(graph, requireNode(nodes, 'b'), follower, index)).toBe(false)
    expect(readyActivations(graph, [entry, follower]).map(activation => activation.nodeId)).toEqual(['a'])
  })

  it('refuses to schedule an activation whose node the definition does not declare', () => {
    expect(() => readyActivations(linear(), [activationRow('ghost', 'pending')]))
      .toThrow(/undeclared node "ghost"/u)
  })

  it('adds one iteration for a loop edge', () => {
    expect(targetIteration(0, edge('a', 'b'))).toBe(0)
    expect(targetIteration(0, loopEdge('b', 'a', 2))).toBe(1)
  })

  it('describes a routing failure with and without candidates', () => {
    expect(routingFailureReason({
      code: 'routing/ambiguous',
      nodeId: 'a',
      message: 'two edges matched',
      candidates: ['a-b', 'a-c'],
    })).toBe('routing/ambiguous: two edges matched (a-b, a-c)')
    expect(routingFailureReason({
      code: 'routing/no-match',
      nodeId: 'a',
      message: 'nothing matched',
      candidates: [],
    })).toBe('routing/no-match: nothing matched')
  })

  it('settles a run only once every activation is terminal', () => {
    expect(settleStatus([activationRow('a', 'pending')])).toBeUndefined()
    expect(settleStatus([activationRow('a', 'succeeded'), activationRow('b', 'succeeded')])).toBe('succeeded')
    expect(settleStatus([activationRow('a', 'succeeded'), activationRow('b', 'canceled')])).toBe('canceled')
    expect(settleStatus([activationRow('a', 'canceled'), activationRow('b', 'failed')])).toBe('failed')
  })
})

describe('input assembly', () => {
  it('reports the first binding that resolves to nothing', () => {
    const node = pythonNode('b', {
      inputs: [
        { name: 'first', source: { kind: 'run', key: 'present' } },
        { name: 'second', source: { kind: 'run', key: 'absent' } },
      ],
    })
    const assembly = assembleInputs(node, 0, {
      params: { present: 1 },
      result: () => undefined,
      artifact: () => undefined,
    })
    expect(assembly).toEqual({
      ok: false,
      binding: { name: 'second', source: { kind: 'run', key: 'absent' } },
    })
    expect(assembleInputs(pythonNode('b'), 0, { params: {}, result: () => undefined, artifact: () => undefined }))
      .toEqual({ ok: true, inputs: {} })
  })
})

describe('executor registry', () => {
  it('refuses a second executor for one kind and forgets a disposed one', () => {
    const registry = new ExecutorRegistry()
    const python: NodeExecutor = new FakeExecutor('python', () => ({ status: 'succeeded', value: null }))
    const dispose = registry.register(python)
    expect(registry.find('python')).toBe(python)
    expect(() => registry.register(python)).toThrow(WorkflowSchedulerError)
    dispose()
    expect(registry.find('python')).toBeUndefined()
    dispose()
    const agent: NodeExecutor = new FakeExecutor('agent', () => ({ status: 'succeeded', value: null }))
    registry.register(agent)
    registry.clear()
    expect(registry.find('agent')).toBeUndefined()
  })

  it('unregisters an executor when its returned disposer runs', async () => {
    const h = await mounted()
    const dispose = h.scheduler.registerExecutor(new FakeExecutor('python', () => ({ status: 'succeeded', value: null })))
    dispose()
    const revision = await define(h, linear())
    const runId = await runIdOf(h, revision)
    const result = await h.scheduler.tick({ projectId: h.projectId, runId })
    expect(result.diagnostics.map(diagnostic => diagnostic.code)).toEqual(['scheduler/executor-missing'])
  })

  it('refuses a registration after the service is disposed', async () => {
    const h = await mounted()
    await h.ctx.fiber.dispose()
    harnesses.splice(harnesses.indexOf(h), 1)
    expect(() => h.scheduler.registerExecutor(new FakeExecutor('python', () => ({ status: 'succeeded', value: null }))))
      .toThrow(WorkflowSchedulerError)
  })
})

describe('row parsing', () => {
  /** Seed one run, activation, and attempt with the given stored JSON columns. */
  async function seed(
    h: Harness,
    columns: { params?: string; incoming?: string; error?: string | null; result?: string | null },
  ): Promise<void> {
    const revision = await h.store.writeDefinition(h.projectId, serializeDefinition(linear()))
    await h.store.transact(h.projectId, (db) => {
      db.prepare('INSERT INTO runs (run_id, definition_revision, status, created_at, updated_at, params_json) VALUES (?, ?, ?, ?, ?, ?)')
        .run('run-1', revision, 'running', 1, 1, columns.params ?? '{}')
      db.prepare('INSERT INTO activations (activation_id, run_id, node_id, iteration, status, incoming_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run('act-1', 'run-1', 'a', 0, 'succeeded', columns.incoming ?? '[]', 1, 1)
      db.prepare('INSERT INTO attempts (attempt_id, activation_id, attempt_no, status, started_at, ended_at, error_json, result_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run('try-1', 'act-1', 1, 'succeeded', 1, 2, columns.error ?? null, columns.result ?? null)
    })
  }

  const runId = brandString<RunId>('run-1')
  it('refuses unparseable or misdeclared run parameters', async () => {
    const h = await mounted()
    await seed(h, { params: 'not json' })
    await expect(h.scheduler.getRun({ projectId: h.projectId, runId })).rejects.toMatchObject({ code: 'invalid-record' })
    const other = await mounted()
    await seed(other, { params: '[]' })
    await expect(other.scheduler.getRun({ projectId: other.projectId, runId })).rejects.toMatchObject({ code: 'invalid-record' })
  })

  it('refuses misdeclared incoming activations', async () => {
    for (const incoming of ['{}', '[1]', '[{"nodeId":"a"}]']) {
      const h = await mounted()
      await seed(h, { incoming })
      await expect(h.scheduler.listActivations({ projectId: h.projectId, runId }))
        .rejects.toMatchObject({ code: 'invalid-record' })
    }
  })

  it('refuses misdeclared attempt failures and results', async () => {
    const bad = await mounted()
    await seed(bad, { error: 'null' })
    await expect(bad.scheduler.listAttempts({ projectId: bad.projectId, runId }))
      .rejects.toMatchObject({ code: 'invalid-record' })

    const missing = await mounted()
    await seed(missing, { error: '{"code":1}' })
    await expect(missing.scheduler.listAttempts({ projectId: missing.projectId, runId }))
      .rejects.toMatchObject({ code: 'invalid-record' })

    const result = await mounted()
    await seed(result, { result: 'not json' })
    await expect(result.scheduler.listAttempts({ projectId: result.projectId, runId }))
      .rejects.toMatchObject({ code: 'invalid-record' })

  })

  it('reads a missing attempt as undefined', async () => {
    const h = await mounted()
    await seed(h, {})
    const found = await h.store.transact(h.projectId, db => selectAttempt(db, brandString<AttemptId>('ghost')))
    expect(found).toBeUndefined()
  })

  it('reads a stored result back through the attempt row', async () => {
    const h = await mounted()
    await seed(h, { result: '{"ok":true}', error: '{"code":"node/boom","message":"failed"}' })
    const attempts = await h.scheduler.listAttempts({ projectId: h.projectId, runId })
    expect(attempts[0]?.error).toEqual({ code: 'node/boom', message: 'failed' })
  })
})

describe('service closure', () => {
  it('refuses every call after disposal and aborts in-flight work', async () => {
    const h = await mounted()
    const revision = await define(h, linear())
    const runId = await runIdOf(h, revision)
    await h.ctx.fiber.dispose()
    harnesses.splice(harnesses.indexOf(h), 1)
    const request = { projectId: h.projectId, runId }
    await expect(h.scheduler.tick(request)).rejects.toMatchObject({ code: 'scheduler/closed' })
    await expect(h.scheduler.getRun(request)).rejects.toMatchObject({ code: 'scheduler/closed' })
    await expect(h.scheduler.listActivations(request)).rejects.toMatchObject({ code: 'scheduler/closed' })
    await expect(h.scheduler.listAttempts(request)).rejects.toMatchObject({ code: 'scheduler/closed' })
    await expect(h.scheduler.pause(request)).rejects.toMatchObject({ code: 'scheduler/closed' })
    await expect(h.scheduler.resume(request)).rejects.toMatchObject({ code: 'scheduler/closed' })
    await expect(h.scheduler.cancel(request)).rejects.toMatchObject({ code: 'scheduler/closed' })
    await expect(h.scheduler.reconcile({ projectId: h.projectId })).rejects.toMatchObject({ code: 'scheduler/closed' })
    await expect(h.scheduler.createRun({ projectId: h.projectId, definitionRevision: revision }))
      .rejects.toMatchObject({ code: 'scheduler/closed' })
    await expect(h.scheduler.step({ ...request, activationId: 'ghost' as never }))
      .rejects.toMatchObject({ code: 'scheduler/closed' })
    await expect(h.scheduler.retry({ ...request, activationId: 'ghost' as never }))
      .rejects.toMatchObject({ code: 'scheduler/closed' })
  })
})

/** Create one run and return its id, for the closure suite. */
async function runIdOf(h: Harness, revision: number): Promise<RunId> {
  const { runId } = await h.scheduler.createRun({ projectId: h.projectId, definitionRevision: revision })
  return runId
}
