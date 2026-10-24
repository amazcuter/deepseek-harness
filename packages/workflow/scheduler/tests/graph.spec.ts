/**
 * Graph semantics: fan-out, joins, unselected branches, loop iterations and
 * exhaustion, routing failures, retries, and the executor seam.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { FakeExecutor, deferred, define, definition, edge, harness, loopEdge, pythonNode, startRun } from './support/harness.ts'
import type { Harness } from './support/harness.ts'
import type { WorkflowDefinition } from '@metaworkflow/workflow-definition'

const harnesses: Harness[] = []

afterEach(async () => {
  for (const mounted of harnesses.splice(0)) await mounted.close()
})

async function mounted(config?: Parameters<typeof harness>[0]): Promise<Harness> {
  const created = await harness(config)
  harnesses.push(created)
  return created
}

/** A three-node fan-out: a starts b and c. */
function fanOut(): WorkflowDefinition {
  return definition(
    [pythonNode('a'), pythonNode('b'), pythonNode('c'), pythonNode('d', { join: 'all' })],
    [edge('a', 'b'), edge('a', 'c'), edge('b', 'd'), edge('c', 'd')],
  )
}

describe('fan-out and joins', () => {
  it('starts every branch an unconditional node activates', async () => {
    const h = await mounted()
    const revision = await define(h, fanOut())
    const python = new FakeExecutor('python', () => ({ status: 'succeeded', value: null }))
    h.scheduler.registerExecutor(python)
    const runId = await startRun(h, revision)

    await expect(h.scheduler.tick({ projectId: h.projectId, runId })).resolves.toMatchObject({ status: 'succeeded' })
    const activations = await h.scheduler.listActivations({ projectId: h.projectId, runId })
    expect(activations.map(activation => [activation.nodeId, activation.iteration, activation.status])).toEqual([
      ['a', 0, 'succeeded'],
      ['b', 0, 'succeeded'],
      ['c', 0, 'succeeded'],
      ['d', 0, 'succeeded'],
    ])
    const join = activations.find(activation => activation.nodeId === 'd')
    expect(join?.incoming).toEqual([{ nodeId: 'b', iteration: 0 }, { nodeId: 'c', iteration: 0 }])
  })

  it('waits for every activated branch of an all-join', async () => {
    const h = await mounted()
    const revision = await define(h, fanOut())
    const started: string[] = []
    const python = new FakeExecutor('python', (execution) => {
      started.push(execution.activation.node.id)
      return { status: 'succeeded', value: null }
    })
    h.scheduler.registerExecutor(python)
    const runId = await startRun(h, revision)

    await h.scheduler.tick({ projectId: h.projectId, runId })
    expect(started.filter(id => id === 'd')).toHaveLength(1)
    expect(started.indexOf('d')).toBeGreaterThan(started.indexOf('b'))
    expect(started.indexOf('d')).toBeGreaterThan(started.indexOf('c'))
  })

  it('fires a first-success join once and ignores the branches that follow', async () => {
    const h = await mounted()
    const graph = fanOut()
    const revision = await define(h, {
      ...graph,
      nodes: graph.nodes.map(node => (node.id === 'd' ? { ...node, join: 'first-success' as const } : node)),
    })
    const python = new FakeExecutor('python', () => ({ status: 'succeeded', value: null }))
    h.scheduler.registerExecutor(python)
    const runId = await startRun(h, revision)

    await expect(h.scheduler.tick({ projectId: h.projectId, runId })).resolves.toMatchObject({ status: 'succeeded' })
    const activations = await h.scheduler.listActivations({ projectId: h.projectId, runId })
    expect(activations.filter(activation => activation.nodeId === 'd')).toHaveLength(1)
    expect(python.calls.filter(call => call.activation.node.id === 'd')).toHaveLength(1)
  })

  it('never counts a branch the routing did not select', async () => {
    const h = await mounted()
    const revision = await define(h, definition(
      [pythonNode('a'), pythonNode('b'), pythonNode('c'), pythonNode('d', { join: 'all' })],
      [
        edge('a', 'b', { mode: 'exclusive', condition: { op: 'eq', field: 'go', value: true } }),
        edge('a', 'c', { mode: 'exclusive', fallback: true }),
        edge('b', 'd'),
        edge('c', 'd'),
      ],
    ))
    h.scheduler.registerExecutor(new FakeExecutor('python', call => ({
      status: 'succeeded',
      value: { go: call.activation.node.id === 'a' ? true : null },
    })))
    const runId = await startRun(h, revision)

    await expect(h.scheduler.tick({ projectId: h.projectId, runId })).resolves.toMatchObject({ status: 'succeeded' })
    const activations = await h.scheduler.listActivations({ projectId: h.projectId, runId })
    expect(activations.map(activation => activation.nodeId)).toEqual(['a', 'b', 'd'])
    expect(activations.find(activation => activation.nodeId === 'd')?.incoming).toEqual([{ nodeId: 'b', iteration: 0 }])
  })
})

describe('loops', () => {
  /** a starts b, b starts c, and c re-enters b while its result says so. */
  function loopGraph(maxIterations: number): WorkflowDefinition {
    return definition(
      [pythonNode('a'), pythonNode('b'), pythonNode('c')],
      [edge('a', 'b'), edge('b', 'c'), loopEdge('c', 'b', maxIterations, { condition: { op: 'eq', field: 'more', value: true } })],
    )
  }

  it('iterates along the loop edge and stops when the condition no longer matches', async () => {
    const h = await mounted()
    const revision = await define(h, loopGraph(3))
    const python = new FakeExecutor('python', execution => ({
      status: 'succeeded',
      value: { more: execution.activation.iteration < 2 },
    }))
    h.scheduler.registerExecutor(python)
    const runId = await startRun(h, revision)

    await expect(h.scheduler.tick({ projectId: h.projectId, runId })).resolves.toMatchObject({ status: 'succeeded' })
    const activations = await h.scheduler.listActivations({ projectId: h.projectId, runId })
    expect(activations.map(activation => [activation.nodeId, activation.iteration, activation.status])).toEqual([
      ['a', 0, 'succeeded'],
      ['b', 0, 'succeeded'],
      ['c', 0, 'succeeded'],
      ['b', 1, 'succeeded'],
      ['c', 1, 'succeeded'],
      ['b', 2, 'succeeded'],
      ['c', 2, 'succeeded'],
    ])
    const second = activations.find(activation => activation.nodeId === 'b' && activation.iteration === 1)
    expect(second?.incoming).toEqual([{ nodeId: 'c', iteration: 0 }])
    expect(python.calls.filter(call => call.activation.node.id === 'b').map(call => call.activation.iteration))
      .toEqual([0, 1, 2])
  })

  it('fails the run when a loop re-enters beyond its bound', async () => {
    const h = await mounted()
    const revision = await define(h, loopGraph(2))
    h.scheduler.registerExecutor(new FakeExecutor('python', () => ({ status: 'succeeded', value: { more: true } })))
    const runId = await startRun(h, revision)

    const result = await h.scheduler.tick({ projectId: h.projectId, runId })
    expect(result.status).toBe('failed')
    expect(result.diagnostics.map(diagnostic => diagnostic.code)).toContain('scheduler/loop-exhausted')
    const run = await h.scheduler.getRun({ projectId: h.projectId, runId })
    expect(run?.reason).toContain('scheduler/loop-exhausted')
    const activations = await h.scheduler.listActivations({ projectId: h.projectId, runId })
    expect(activations.filter(activation => activation.nodeId === 'b').map(activation => activation.iteration))
      .toEqual([0, 1, 2])
  })
})

describe('routing', () => {
  it('fails the run when two exclusive edges match', async () => {
    const h = await mounted()
    const revision = await define(h, definition(
      [pythonNode('a'), pythonNode('b'), pythonNode('c')],
      [
        edge('a', 'b', { mode: 'exclusive', condition: { op: 'exists', field: 'value' } }),
        edge('a', 'c', { mode: 'exclusive', condition: { op: 'truthy', field: 'value' } }),
      ],
    ))
    h.scheduler.registerExecutor(new FakeExecutor('python', () => ({ status: 'succeeded', value: { value: 1 } })))
    const runId = await startRun(h, revision)

    const result = await h.scheduler.tick({ projectId: h.projectId, runId })
    expect(result.status).toBe('failed')
    expect(result.diagnostics.map(diagnostic => diagnostic.code)).toContain('routing/ambiguous')
    const failed = await h.scheduler.getRun({ projectId: h.projectId, runId })
    expect(failed?.status).toBe('failed')
    expect(failed?.reason).toContain('routing/ambiguous')
    const activations = await h.scheduler.listActivations({ projectId: h.projectId, runId })
    expect(activations.map(activation => activation.nodeId)).toEqual(['a'])
  })

  it('fails the run when no exclusive edge matches and no fallback exists', async () => {
    const h = await mounted()
    const revision = await define(h, definition(
      [pythonNode('a'), pythonNode('b')],
      [edge('a', 'b', { mode: 'exclusive', condition: { op: 'eq', field: 'go', value: true } })],
    ))
    h.scheduler.registerExecutor(new FakeExecutor('python', () => ({ status: 'succeeded', value: { go: false } })))
    const runId = await startRun(h, revision)

    const result = await h.scheduler.tick({ projectId: h.projectId, runId })
    expect(result.diagnostics.map(diagnostic => diagnostic.code)).toContain('routing/no-match')
    const unmatched = await h.scheduler.getRun({ projectId: h.projectId, runId })
    expect(unmatched?.reason).toContain('routing/no-match')
  })

  it('takes the fallback edge when nothing else matches', async () => {
    const h = await mounted()
    const revision = await define(h, definition(
      [pythonNode('a'), pythonNode('b'), pythonNode('c')],
      [
        edge('a', 'b', { mode: 'exclusive', condition: { op: 'eq', field: 'go', value: true } }),
        edge('a', 'c', { mode: 'exclusive', fallback: true }),
      ],
    ))
    h.scheduler.registerExecutor(new FakeExecutor('python', () => ({ status: 'succeeded', value: { go: false } })))
    const runId = await startRun(h, revision)

    await expect(h.scheduler.tick({ projectId: h.projectId, runId })).resolves.toMatchObject({ status: 'succeeded' })
    const activations = await h.scheduler.listActivations({ projectId: h.projectId, runId })
    expect(activations.map(activation => activation.nodeId)).toEqual(['a', 'c'])
  })
})

describe('failures', () => {
  it('retries a retryable failure within the attempt budget', async () => {
    const h = await mounted()
    const revision = await define(h, definition([pythonNode('a'), pythonNode('b')], [edge('a', 'b')]))
    let call = 0
    h.scheduler.registerExecutor(new FakeExecutor('python', () => {
      call += 1
      if (call === 1) return { status: 'failed', error: { code: 'node/flaky', message: 'try again' }, retryable: true }
      return { status: 'succeeded', value: { ok: true } }
    }))
    const runId = await startRun(h, revision)

    await expect(h.scheduler.tick({ projectId: h.projectId, runId })).resolves.toMatchObject({ status: 'succeeded' })
    const attempts = await h.scheduler.listAttempts({ projectId: h.projectId, runId })
    expect(attempts.map(attempt => [attempt.attemptNo, attempt.status])).toEqual([[1, 'failed'], [2, 'succeeded'], [1, 'succeeded']])
  })

  it('fails the activation and the run when the budget is spent', async () => {
    const h = await mounted()
    const revision = await define(h, definition([pythonNode('a')], []))
    h.scheduler.registerExecutor(new FakeExecutor('python', () => ({
      status: 'failed',
      error: { code: 'node/broken', message: 'never works' },
      retryable: true,
    })))
    const runId = await startRun(h, revision)

    const result = await h.scheduler.tick({ projectId: h.projectId, runId })
    expect(result.status).toBe('failed')
    expect(result.diagnostics.map(diagnostic => diagnostic.code)).toEqual(['scheduler/node-failed'])
    const attempts = await h.scheduler.listAttempts({ projectId: h.projectId, runId })
    expect(attempts.map(attempt => attempt.status)).toEqual(['failed', 'failed'])
    const activations = await h.scheduler.listActivations({ projectId: h.projectId, runId })
    expect(activations.map(activation => activation.status)).toEqual(['failed'])
    const failedRun = await h.scheduler.getRun({ projectId: h.projectId, runId })
    expect(failedRun?.status).toBe('failed')
    expect(failedRun?.reason).toContain('node/broken')
  })

  it('does not retry a non-retryable failure', async () => {
    const h = await mounted()
    const revision = await define(h, definition([pythonNode('a')], []))
    h.scheduler.registerExecutor(new FakeExecutor('python', () => ({
      status: 'failed',
      error: { code: 'node/fatal', message: 'no retry' },
      retryable: false,
    })))
    const runId = await startRun(h, revision)

    await h.scheduler.tick({ projectId: h.projectId, runId })
    const attempts = await h.scheduler.listAttempts({ projectId: h.projectId, runId })
    expect(attempts).toHaveLength(1)
  })

  it('honors a smaller attempt budget from the configuration', async () => {
    const h = await mounted({ maxAttempts: 1 })
    const revision = await define(h, definition([pythonNode('a')], []))
    h.scheduler.registerExecutor(new FakeExecutor('python', () => ({
      status: 'failed',
      error: { code: 'node/flaky', message: 'one shot' },
      retryable: true,
    })))
    const runId = await startRun(h, revision)

    await h.scheduler.tick({ projectId: h.projectId, runId })
    const attempts = await h.scheduler.listAttempts({ projectId: h.projectId, runId })
    expect(attempts).toHaveLength(1)
  })

  it('fails a ready activation whose node kind has no executor', async () => {
    const h = await mounted()
    const revision = await define(h, definition([pythonNode('a')], []))
    const runId = await startRun(h, revision)

    const result = await h.scheduler.tick({ projectId: h.projectId, runId })
    expect(result.diagnostics.map(diagnostic => diagnostic.code)).toEqual(['scheduler/executor-missing'])
    expect(result.status).toBe('failed')
    const attempts = await h.scheduler.listAttempts({ projectId: h.projectId, runId })
    expect(attempts.map(attempt => attempt.error)).toEqual([{
      code: 'scheduler/executor-missing',
      message: 'no executor is registered for node kind "python"',
    }])
  })

  it('turns an executor rejection into a structured failure', async () => {
    const h = await mounted()
    const revision = await define(h, definition([pythonNode('a')], []))
    h.scheduler.registerExecutor(new FakeExecutor('python', () => {
      throw new Error('the executor crashed')
    }))
    const runId = await startRun(h, revision)

    const result = await h.scheduler.tick({ projectId: h.projectId, runId })
    expect(result.status).toBe('failed')
    const attempts = await h.scheduler.listAttempts({ projectId: h.projectId, runId })
    expect(attempts[0]?.error).toEqual({ code: 'scheduler/executor-error', message: 'Error: the executor crashed' })
  })

  it('records a node that suspends itself and releases its slot', async () => {
    const h = await mounted()
    const revision = await define(h, definition([pythonNode('a'), pythonNode('b')], [edge('a', 'b')]))
    let suspended = false
    h.scheduler.registerExecutor(new FakeExecutor('python', (call) => {
      if (call.activation.node.id === 'a' && !suspended) {
        suspended = true
        return { status: 'waiting', requestId: 'decision-1' }
      }
      return { status: 'succeeded', value: null }
    }))
    const runId = await startRun(h, revision)

    const result = await h.scheduler.tick({ projectId: h.projectId, runId })
    expect(result).toMatchObject({ status: 'running', dispatched: 1, completed: 1 })
    const activations = await h.scheduler.listActivations({ projectId: h.projectId, runId })
    expect(activations.map(activation => [activation.nodeId, activation.status])).toEqual([['a', 'waiting']])

    const activation = activations[0]
    if (activation === undefined) throw new Error('the activation is missing')
    await h.scheduler.retry({ projectId: h.projectId, runId, activationId: activation.activationId })
    await expect(h.scheduler.tick({ projectId: h.projectId, runId })).resolves.toMatchObject({ status: 'succeeded' })
  })
})

describe('routing details', () => {
  it('keeps one activation when two edges reach the same target', async () => {
    const h = await mounted()
    const revision = await define(h, definition(
      [pythonNode('a'), pythonNode('b')],
      [edge('a', 'b', { id: 'first' }), edge('a', 'b', { id: 'second' })],
    ))
    h.scheduler.registerExecutor(new FakeExecutor('python', () => ({ status: 'succeeded', value: null })))
    const runId = await startRun(h, revision)

    await expect(h.scheduler.tick({ projectId: h.projectId, runId })).resolves.toMatchObject({ status: 'succeeded' })
    const activations = await h.scheduler.listActivations({ projectId: h.projectId, runId })
    const target = activations.find(activation => activation.nodeId === 'b')
    expect(target?.incoming).toEqual([{ nodeId: 'a', iteration: 0 }])
    expect(activations.filter(activation => activation.nodeId === 'b')).toHaveLength(1)
  })

  it('ignores a branch that routes after a first-success target already ran', async () => {
    const h = await mounted({ maxConcurrent: 2 })
    const graph = fanOut()
    const revision = await define(h, {
      ...graph,
      nodes: graph.nodes.map(node => (node.id === 'd' ? { ...node, join: 'first-success' as const } : node)),
    })
    const gate = deferred<{ status: 'succeeded'; value: null }>()
    const python = new FakeExecutor('python', (call) => {
      if (call.activation.node.id === 'c') return gate.promise
      return { status: 'succeeded', value: null }
    })
    h.scheduler.registerExecutor(python)
    const runId = await startRun(h, revision)

    const ticking = h.scheduler.tick({ projectId: h.projectId, runId })
    for (let attempt = 0; attempt < 2000; attempt += 1) {
      const done = (await h.scheduler.listActivations({ projectId: h.projectId, runId }))
        .some(activation => activation.nodeId === 'd' && activation.status === 'succeeded')
      if (done) break
      await new Promise(resolve => setTimeout(resolve, 1))
    }
    gate.resolve({ status: 'succeeded', value: null })
    await expect(ticking).resolves.toMatchObject({ status: 'succeeded' })
    const activations = await h.scheduler.listActivations({ projectId: h.projectId, runId })
    expect(activations.filter(activation => activation.nodeId === 'd')).toHaveLength(1)
    expect(python.calls.filter(call => call.activation.node.id === 'd')).toHaveLength(1)
  })

  it('keeps the first failure reason when two branches fail', async () => {
    const h = await mounted({ maxConcurrent: 2 })
    const revision = await define(h, definition(
      [pythonNode('a'), pythonNode('b'), pythonNode('c')],
      [edge('a', 'b'), edge('a', 'c')],
    ))
    h.scheduler.registerExecutor(new FakeExecutor('python', (call) => {
      if (call.activation.node.id === 'a') return { status: 'succeeded', value: null }
      return {
        status: 'failed',
        error: { code: `node/${call.activation.node.id}`, message: `${call.activation.node.id} failed` },
        retryable: false,
      }
    }))
    const runId = await startRun(h, revision)

    const result = await h.scheduler.tick({ projectId: h.projectId, runId })
    expect(result.status).toBe('failed')
    expect(result.diagnostics.filter(diagnostic => diagnostic.code === 'scheduler/node-failed')).toHaveLength(2)
    const run = await h.scheduler.getRun({ projectId: h.projectId, runId })
    expect(run?.reason).toMatch(/node\/(b|c):/u)
  })

  it('fails the whole tick when a second run of the same node publishes no outcome', async () => {
    const h = await mounted()
    const revision = await define(h, definition([pythonNode('a'), pythonNode('b')], [edge('a', 'b')]))
    let calls = 0
    h.scheduler.registerExecutor(new FakeExecutor('python', () => {
      calls += 1
      if (calls === 1) return { status: 'failed', error: { code: 'node/again', message: 'still broken' }, retryable: true }
      return { status: 'succeeded', value: null }
    }))
    const runId = await startRun(h, revision)

    await expect(h.scheduler.tick({ projectId: h.projectId, runId })).resolves.toMatchObject({ status: 'succeeded' })
    const attempts = await h.scheduler.listAttempts({ projectId: h.projectId, runId })
    expect(attempts.map(attempt => attempt.status)).toEqual(['failed', 'succeeded', 'succeeded'])
  })
})

describe('iteration scoping', () => {
  it('reads the newest ancestor result at or before the reading iteration', async () => {
    const h = await mounted({ maxConcurrent: 1 })
    const revision = await define(h, definition(
      [pythonNode('a'), pythonNode('b'), pythonNode('c'), pythonNode('d', {
        inputs: [{ name: 'fromB', source: { kind: 'node', nodeId: 'b', field: 'mark' } }],
      })],
      [
        edge('a', 'b'),
        edge('b', 'c'),
        loopEdge('c', 'b', 2, { condition: { op: 'eq', field: 'more', value: true } }),
        edge('c', 'd'),
      ],
    ))
    const python = new FakeExecutor('python', execution => ({
      status: 'succeeded',
      value: { more: execution.activation.node.id === 'c' && execution.activation.iteration === 0, mark: execution.activation.iteration },
    }))
    h.scheduler.registerExecutor(python)
    const runId = await startRun(h, revision)

    await expect(h.scheduler.tick({ projectId: h.projectId, runId })).resolves.toMatchObject({ status: 'succeeded' })
    const reader = python.calls.filter(call => call.activation.node.id === 'd')
    expect(reader.map(call => [call.activation.iteration, call.inputs.fromB])).toEqual([[0, 0], [1, 1]])
  })
})
