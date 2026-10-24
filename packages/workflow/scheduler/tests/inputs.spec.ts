/**
 * Input assembly: values from ancestor results, run parameters, and artifacts,
 * plus the missing-input failure that keeps a node from running with a partial
 * input.
 */

import { afterEach, describe, expect, it } from 'vitest'
import type { InputBinding } from '@metaworkflow/workflow-definition'
import { FakeExecutor, define, definition, edge, harness, pythonNode, startRun } from './support/harness.ts'
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

/** A two-node graph whose second node declares the given inputs. */
async function inputGraph(h: Harness, inputs: readonly InputBinding[]): Promise<number> {
  return define(h, definition([pythonNode('a'), pythonNode('b', { inputs })], [edge('a', 'b')]))
}

/** An executor that publishes one result and one artifact from node `a`. */
function producer(): FakeExecutor {
  return new FakeExecutor('python', call => call.activation.node.id === 'a'
    ? {
      status: 'succeeded',
      value: { count: 3, nested: { value: 'inner' } },
      artifacts: [{ name: 'draft', path: 'out/draft.md', sha256: 'abc123' }],
    }
    : { status: 'succeeded', value: null })
}

describe('input mapping', () => {
  it('reads ancestor fields, run parameters, and artifact references', async () => {
    const h = await mounted()
    const revision = await inputGraph(h, [
      { name: 'count', source: { kind: 'node', nodeId: 'a', field: 'count' } },
      { name: 'nested', source: { kind: 'node', nodeId: 'a', field: 'nested.value' } },
      { name: 'topic', source: { kind: 'run', key: 'topic' } },
      { name: 'draft', source: { kind: 'artifact', name: 'draft' } },
    ])
    const python = producer()
    h.scheduler.registerExecutor(python)
    const runId = await startRun(h, revision, { topic: 'novel' })

    await expect(h.scheduler.tick({ projectId: h.projectId, runId })).resolves.toMatchObject({ status: 'succeeded' })
    const second = python.calls.find(call => call.activation.node.id === 'b')
    expect(second?.inputs).toEqual({
      count: 3,
      nested: 'inner',
      topic: 'novel',
      draft: { name: 'draft', version: 1, path: 'out/draft.md', sha256: 'abc123' },
    })
    const artifacts = await h.store.transact(h.projectId, db => db.prepare(
      'SELECT name, version, rel_path, sha256, immutable FROM artifacts',
    ).all())
    expect(artifacts).toEqual([{ name: 'draft', version: 1, rel_path: 'out/draft.md', sha256: 'abc123', immutable: 1 }])
  })

  it('fails the activation when an ancestor field is missing', async () => {
    const h = await mounted()
    const revision = await inputGraph(h, [
      { name: 'count', source: { kind: 'node', nodeId: 'a', field: 'absent' } },
    ])
    h.scheduler.registerExecutor(producer())
    const runId = await startRun(h, revision)

    const result = await h.scheduler.tick({ projectId: h.projectId, runId })
    expect(result.status).toBe('failed')
    expect(result.diagnostics.map(diagnostic => diagnostic.code)).toEqual(['scheduler/input-missing'])
    const activations = await h.scheduler.listActivations({ projectId: h.projectId, runId })
    expect(activations.map(activation => [activation.nodeId, activation.status])).toEqual([['a', 'succeeded'], ['b', 'failed']])
    const attempts = await h.scheduler.listAttempts({ projectId: h.projectId, runId })
    expect(attempts[1]?.error).toEqual({ code: 'scheduler/input-missing', message: 'input "count" of node "b" has no value from node' })
  })

  it('fails the activation when a run parameter is missing', async () => {
    const h = await mounted()
    const revision = await inputGraph(h, [{ name: 'topic', source: { kind: 'run', key: 'topic' } }])
    h.scheduler.registerExecutor(producer())
    const runId = await startRun(h, revision)

    const result = await h.scheduler.tick({ projectId: h.projectId, runId })
    expect(result.diagnostics.map(diagnostic => diagnostic.code)).toEqual(['scheduler/input-missing'])
  })

  it('fails the activation when an artifact is missing', async () => {
    const h = await mounted()
    const revision = await inputGraph(h, [{ name: 'draft', source: { kind: 'artifact', name: 'reviewed' } }])
    h.scheduler.registerExecutor(producer())
    const runId = await startRun(h, revision)

    const result = await h.scheduler.tick({ projectId: h.projectId, runId })
    expect(result.diagnostics.map(diagnostic => diagnostic.code)).toEqual(['scheduler/input-missing'])
  })

  it('keeps the newest artifact version readable by later activations', async () => {
    const h = await mounted()
    const revision = await define(h, definition(
      [pythonNode('a'), pythonNode('b'), pythonNode('c', {
        inputs: [{ name: 'draft', source: { kind: 'artifact', name: 'draft' } }],
      })],
      [edge('a', 'b'), edge('b', 'c')],
    ))
    const python = new FakeExecutor('python', (call) => {
      if (call.activation.node.id === 'a') {
        return { status: 'succeeded', value: null, artifacts: [{ name: 'draft', path: 'v1.md' }] }
      }
      if (call.activation.node.id === 'b') {
        return { status: 'succeeded', value: null, artifacts: [{ name: 'draft', path: 'v2.md' }] }
      }
      return { status: 'succeeded', value: null }
    })
    h.scheduler.registerExecutor(python)
    const runId = await startRun(h, revision)

    await h.scheduler.tick({ projectId: h.projectId, runId })
    const consumer = python.calls.find(call => call.activation.node.id === 'c')
    expect(consumer?.inputs).toEqual({ draft: { name: 'draft', version: 1, path: 'v2.md', sha256: null } })
  })
})

describe('unfinished branches', () => {
  it('reports a missing input when a first-success target reads a branch that has not finished', async () => {
    const h = await harness()
    harnesses.push(h)
    const revision = await define(h, definition(
      [
        pythonNode('a'),
        pythonNode('b'),
        pythonNode('c'),
        pythonNode('d', {
          join: 'first-success',
          inputs: [{ name: 'fromC', source: { kind: 'node', nodeId: 'c', field: 'value' } }],
        }),
      ],
      [edge('a', 'b'), edge('a', 'c'), edge('b', 'd'), edge('c', 'd')],
    ))
    h.scheduler.registerExecutor(new FakeExecutor('python', call => call.activation.node.id === 'c'
      ? { status: 'waiting', reason: 'still working' }
      : { status: 'succeeded', value: { value: 'ready' } }))
    const runId = await startRun(h, revision)

    const result = await h.scheduler.tick({ projectId: h.projectId, runId })
    expect(result.diagnostics.map(diagnostic => diagnostic.code)).toContain('scheduler/input-missing')
    const activations = await h.scheduler.listActivations({ projectId: h.projectId, runId })
    expect(activations.map(activation => [activation.nodeId, activation.status])).toEqual([
      ['a', 'succeeded'],
      ['b', 'succeeded'],
      ['c', 'waiting'],
      ['d', 'failed'],
    ])
  })
})
