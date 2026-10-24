/**
 * Run lifecycle: creation, linear execution, single steps, pause, resume,
 * cancel, retry, recovery, and repeated ticks.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { WorkflowSchedulerError } from '../src/index.ts'
import type { TickResult } from '../src/index.ts'
import { FakeExecutor, agentNode, deferred, define, definition, edge, harness, pythonNode, startRun } from './support/harness.ts'
import type { Harness } from './support/harness.ts'

const harnesses: Harness[] = []

afterEach(async () => {
  for (const mounted of harnesses.splice(0)) await mounted.close()
})

async function mounted(config?: Parameters<typeof harness>[0]): Promise<Harness> {
  const created = await harness(config)
  harnesses.push(created)
  return created
}

/** Wait until a condition holds, so a test can act while a tick is in flight. */
async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 2000; attempt += 1) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 1))
  }
  throw new Error('condition was never observed')
}

/** The code of one refusal. */
async function refusal(run: () => Promise<unknown>): Promise<string> {
  try {
    await run()
  } catch (error: unknown) {
    if (error instanceof WorkflowSchedulerError) return error.code
    throw error
  }
  throw new Error('expected the call to refuse')
}

describe('createRun', () => {
  it('records the run and its entry activation', async () => {
    const h = await mounted()
    const revision = await define(h, definition([pythonNode('a'), pythonNode('b')], [edge('a', 'b')]))
    const runId = await startRun(h, revision)

    await expect(h.scheduler.getRun({ projectId: h.projectId, runId })).resolves.toMatchObject({
      runId,
      definitionRevision: revision,
      status: 'pending',
      params: {},
      reason: null,
    })
    const activations = await h.scheduler.listActivations({ projectId: h.projectId, runId })
    expect(activations).toHaveLength(1)
    expect(activations[0]).toMatchObject({ nodeId: 'a', iteration: 0, status: 'pending', incoming: [] })
    await expect(h.scheduler.listAttempts({ projectId: h.projectId, runId })).resolves.toEqual([])
  })

  it('refuses a revision the project never stored', async () => {
    const h = await mounted()
    await expect(refusal(() => h.scheduler.createRun({ projectId: h.projectId, definitionRevision: 9 })))
      .resolves.toBe('scheduler/definition-unavailable')
  })

  it('refuses a stored document that is not an executable graph', async () => {
    const h = await mounted()
    const revision = await h.store.writeDefinition(h.projectId, '{"version":2}')
    await expect(refusal(() => h.scheduler.createRun({ projectId: h.projectId, definitionRevision: revision })))
      .resolves.toBe('scheduler/definition-invalid')
  })

  it('reports an unknown run and an unknown project activation', async () => {
    const h = await mounted()
    const revision = await define(h, definition([pythonNode('a')], []))
    const runId = await startRun(h, revision)
    await expect(refusal(() => h.scheduler.tick({ projectId: h.projectId, runId: 'ghost' as typeof runId })))
      .resolves.toBe('scheduler/run-not-found')
    const activations = await h.scheduler.listActivations({ projectId: h.projectId, runId })
    const foreign = await h.scheduler.listActivations({ projectId: h.projectId, runId })
    expect(foreign).toHaveLength(1)
    await expect(refusal(() => h.scheduler.step({
      projectId: h.projectId,
      runId: 'ghost' as typeof runId,
      activationId: String(activations[0]?.activationId) as NonNullable<typeof activations[0]>['activationId'],
    }))).resolves.toBe('scheduler/run-not-found')
  })
})

describe('tick', () => {
  it('dispatches an agent node with the attempt identity its executor keys on', async () => {
    const h = await mounted()
    const revision = await define(h, definition([agentNode('ask')], []))
    const agent = new FakeExecutor('agent', () => ({ status: 'succeeded', value: { answer: 'ok' } }))
    h.scheduler.registerExecutor(agent)
    const runId = await startRun(h, revision)

    await expect(h.scheduler.tick({ projectId: h.projectId, runId })).resolves.toMatchObject({ status: 'succeeded' })
    const attempts = await h.scheduler.listAttempts({ projectId: h.projectId, runId })
    expect(agent.calls.map(call => call.activation)).toMatchObject([
      { projectId: h.projectId, definitionRevision: revision, attemptNo: 1, attemptId: attempts[0]?.attemptId },
    ])
  })

  it('executes a linear graph node by node and settles it', async () => {
    const h = await mounted()
    const revision = await define(h, definition(
      [pythonNode('a'), pythonNode('b')],
      [edge('a', 'b')],
    ))
    const python = new FakeExecutor('python', call => ({
      status: 'succeeded',
      value: { at: call.activation.node.id },
    }))
    h.scheduler.registerExecutor(python)
    const runId = await startRun(h, revision)

    const result = await h.scheduler.tick({ projectId: h.projectId, runId })
    expect(result).toMatchObject({ status: 'succeeded', dispatched: 2, completed: 2, diagnostics: [] })
    expect(python.calls.map(call => call.activation.node.id)).toEqual(['a', 'b'])
    expect(python.calls.map(call => call.activation.attemptNo)).toEqual([1, 1])
    expect(python.calls[1]?.activation.iteration).toEqual(0)
    // The activation names the project and revision an executor resolves its resources from.
    expect(python.calls[0]?.activation).toMatchObject({ projectId: h.projectId, definitionRevision: revision })

    const activations = await h.scheduler.listActivations({ projectId: h.projectId, runId })
    expect(activations.map(activation => [activation.nodeId, activation.status])).toEqual([['a', 'succeeded'], ['b', 'succeeded']])
    const attempts = await h.scheduler.listAttempts({ projectId: h.projectId, runId })
    expect(attempts.map(attempt => attempt.status)).toEqual(['succeeded', 'succeeded'])
    for (const attempt of attempts) {
      const events = await h.store.listOutbox(h.projectId, attempt.attemptId)
      expect(events).toHaveLength(1)
      expect(JSON.parse(events[0]?.payload ?? '{}')).toMatchObject({ type: 'scheduler/attempt-result', status: 'succeeded' })
    }
  })

  it('repeats a tick on a settled run without changing anything', async () => {
    const h = await mounted()
    const revision = await define(h, definition([pythonNode('a')], []))
    h.scheduler.registerExecutor(new FakeExecutor('python', () => ({ status: 'succeeded', value: null })))
    const runId = await startRun(h, revision)
    const first = await h.scheduler.tick({ projectId: h.projectId, runId })
    expect(first.status).toBe('succeeded')
    const activations = await h.scheduler.listActivations({ projectId: h.projectId, runId })
    const attempts = await h.scheduler.listAttempts({ projectId: h.projectId, runId })

    const second = await h.scheduler.tick({ projectId: h.projectId, runId })
    expect(second).toMatchObject({ status: 'succeeded', dispatched: 0, completed: 0 })
    await expect(h.scheduler.listActivations({ projectId: h.projectId, runId })).resolves.toEqual(activations)
    await expect(h.scheduler.listAttempts({ projectId: h.projectId, runId })).resolves.toEqual(attempts)
  })

  it('leaves a paused run alone until it resumes', async () => {
    const h = await mounted()
    const revision = await define(h, definition([pythonNode('a'), pythonNode('b')], [edge('a', 'b')]))
    const python = new FakeExecutor('python', () => ({ status: 'succeeded', value: null }))
    h.scheduler.registerExecutor(python)
    const runId = await startRun(h, revision)
    await h.scheduler.pause({ projectId: h.projectId, runId })

    const skipped = await h.scheduler.tick({ projectId: h.projectId, runId })
    expect(skipped).toMatchObject({ status: 'paused', dispatched: 0 })
    expect(python.calls).toHaveLength(0)

    await h.scheduler.resume({ projectId: h.projectId, runId })
    await expect(h.scheduler.tick({ projectId: h.projectId, runId })).resolves.toMatchObject({ status: 'succeeded' })
    await expect(refusal(() => h.scheduler.resume({ projectId: h.projectId, runId })))
      .resolves.toBe('scheduler/run-state-invalid')
  })

  it('advances two runs of one project independently', async () => {
    const h = await mounted()
    const revision = await define(h, definition([pythonNode('a'), pythonNode('b')], [edge('a', 'b')]))
    const python = new FakeExecutor('python', call => ({ status: 'succeeded', value: { run: call.activation.runId } }))
    h.scheduler.registerExecutor(python)
    const first = await startRun(h, revision)
    const second = await startRun(h, revision)

    const [left, right] = await Promise.all([
      h.scheduler.tick({ projectId: h.projectId, runId: first }),
      h.scheduler.tick({ projectId: h.projectId, runId: second }),
    ])
    expect(left.status).toBe('succeeded')
    expect(right.status).toBe('succeeded')
    const firstActivations = await h.scheduler.listActivations({ projectId: h.projectId, runId: first })
    const secondActivations = await h.scheduler.listActivations({ projectId: h.projectId, runId: second })
    expect(firstActivations).toHaveLength(2)
    expect(secondActivations).toHaveLength(2)
    const firstIds = new Set(firstActivations.map(activation => String(activation.activationId)))
    expect(secondActivations.filter(activation => firstIds.has(String(activation.activationId)))).toEqual([])
  })
})

describe('step', () => {
  it('executes one activation and parks the run until the next step', async () => {
    const h = await mounted()
    const revision = await define(h, definition([pythonNode('a'), pythonNode('b')], [edge('a', 'b')]))
    h.scheduler.registerExecutor(new FakeExecutor('python', () => ({ status: 'succeeded', value: null })))
    const runId = await startRun(h, revision)
    const [entry] = await h.scheduler.listActivations({ projectId: h.projectId, runId })
    if (entry === undefined) throw new Error('the run has no entry activation')

    const first = await h.scheduler.step({ projectId: h.projectId, runId, activationId: entry.activationId })
    expect(first).toMatchObject({ status: 'paused', dispatched: 1, completed: 1 })
    const midway = await h.scheduler.listActivations({ projectId: h.projectId, runId })
    expect(midway.map(activation => [activation.nodeId, activation.status])).toEqual([['a', 'succeeded'], ['b', 'pending']])

    const next = midway.find(activation => activation.nodeId === 'b')
    if (next === undefined) throw new Error('the second activation is missing')
    const second = await h.scheduler.step({ projectId: h.projectId, runId, activationId: next.activationId })
    expect(second).toMatchObject({ status: 'succeeded', dispatched: 1, completed: 1 })

    await expect(refusal(() => h.scheduler.step({ projectId: h.projectId, runId, activationId: next.activationId })))
      .resolves.toBe('scheduler/run-state-invalid')
  })

  it('refuses an activation whose join has not fired', async () => {
    const h = await mounted()
    const revision = await define(h, definition(
      [pythonNode('a'), pythonNode('b'), pythonNode('c'), pythonNode('d', { join: 'all' })],
      [edge('a', 'b'), edge('a', 'c'), edge('b', 'd'), edge('c', 'd')],
    ))
    h.scheduler.registerExecutor(new FakeExecutor('python', () => ({ status: 'succeeded', value: null })))
    const runId = await startRun(h, revision)
    const activationOf = async (nodeId: string): Promise<string> => {
      const found = (await h.scheduler.listActivations({ projectId: h.projectId, runId }))
        .find(activation => activation.nodeId === nodeId)
      if (found === undefined) throw new Error(`node ${nodeId} has no activation`)
      return String(found.activationId)
    }
    await h.scheduler.step({ projectId: h.projectId, runId, activationId: (await activationOf('a')) as never })
    await h.scheduler.step({ projectId: h.projectId, runId, activationId: (await activationOf('b')) as never })
    const joined = (await h.scheduler.listActivations({ projectId: h.projectId, runId }))
      .find(activation => activation.nodeId === 'd')
    if (joined === undefined) throw new Error('the join activation is missing')
    await expect(refusal(() => h.scheduler.step({
      projectId: h.projectId,
      runId,
      activationId: joined.activationId,
    }))).resolves.toBe('scheduler/activation-not-ready')

    await h.scheduler.resume({ projectId: h.projectId, runId })
    await expect(h.scheduler.tick({ projectId: h.projectId, runId })).resolves.toMatchObject({ status: 'succeeded' })
  })
})

describe('pause and cancel', () => {
  it('aborts an in-flight attempt and re-runs it after a resume', async () => {
    const h = await mounted()
    const revision = await define(h, definition([pythonNode('a'), pythonNode('b')], [edge('a', 'b')]))
    const gate = deferred<{ status: 'succeeded'; value: null }>()
    let call = 0
    const python = new FakeExecutor('python', () => {
      call += 1
      if (call === 2) return gate.promise
      return { status: 'succeeded', value: null }
    })
    h.scheduler.registerExecutor(python)
    const runId = await startRun(h, revision)

    const ticking: Promise<TickResult> = h.scheduler.tick({ projectId: h.projectId, runId })
    await waitFor(() => python.calls.length === 2)
    const paused = await h.scheduler.pause({ projectId: h.projectId, runId })
    expect(paused.status).toBe('paused')
    gate.resolve({ status: 'succeeded', value: null })
    const stale = await ticking
    expect(stale.diagnostics.map(diagnostic => diagnostic.code)).toContain('scheduler/stale-result')
    expect(stale.status).toBe('paused')

    const attempts = await h.scheduler.listAttempts({ projectId: h.projectId, runId })
    expect(attempts.map(attempt => attempt.status)).toEqual(['succeeded', 'canceled'])
    const activations = await h.scheduler.listActivations({ projectId: h.projectId, runId })
    expect(activations.map(activation => [activation.nodeId, activation.status])).toEqual([['a', 'succeeded'], ['b', 'pending']])

    await h.scheduler.resume({ projectId: h.projectId, runId })
    await expect(h.scheduler.tick({ projectId: h.projectId, runId })).resolves.toMatchObject({ status: 'succeeded' })
    const resumed = await h.scheduler.listAttempts({ projectId: h.projectId, runId })
    expect(resumed.map(attempt => [attempt.attemptNo, attempt.status])).toEqual([[1, 'succeeded'], [1, 'canceled'], [2, 'succeeded']])
    await expect(refusal(() => h.scheduler.pause({ projectId: h.projectId, runId })))
      .resolves.toBe('scheduler/run-state-invalid')
  })

  it('cancels a run and every activation it has not finished', async () => {
    const h = await mounted()
    const revision = await define(h, definition([pythonNode('a'), pythonNode('b')], [edge('a', 'b')]))
    const gate = deferred<{ status: 'succeeded'; value: null }>()
    const python = new FakeExecutor('python', (execution) => {
      if (execution.activation.node.id === 'b') return gate.promise
      return { status: 'succeeded', value: null }
    })
    h.scheduler.registerExecutor(python)
    const runId = await startRun(h, revision)

    const ticking = h.scheduler.tick({ projectId: h.projectId, runId })
    await waitFor(() => python.calls.length === 2)
    const canceled = await h.scheduler.cancel({ projectId: h.projectId, runId })
    expect(canceled.status).toBe('canceled')
    gate.resolve({ status: 'succeeded', value: null })
    const result = await ticking
    expect(result.diagnostics.map(diagnostic => diagnostic.code)).toContain('scheduler/stale-result')

    const activations = await h.scheduler.listActivations({ projectId: h.projectId, runId })
    expect(activations.map(activation => [activation.nodeId, activation.status])).toEqual([['a', 'succeeded'], ['b', 'canceled']])
    const attempts = await h.scheduler.listAttempts({ projectId: h.projectId, runId })
    expect(attempts.map(attempt => attempt.status)).toEqual(['succeeded', 'canceled'])
    await expect(refusal(() => h.scheduler.cancel({ projectId: h.projectId, runId })))
      .resolves.toBe('scheduler/run-state-invalid')
  })
})

describe('retry', () => {
  it('records a failed activation and a new attempt that succeeds', async () => {
    const h = await mounted()
    const revision = await define(h, definition([pythonNode('a')], []))
    let call = 0
    h.scheduler.registerExecutor(new FakeExecutor('python', () => {
      call += 1
      if (call === 1) return { status: 'failed', error: { code: 'node/boom', message: 'first attempt' }, retryable: false }
      return { status: 'succeeded', value: { ok: true } }
    }))
    const runId = await startRun(h, revision)

    const failed = await h.scheduler.tick({ projectId: h.projectId, runId })
    expect(failed.status).toBe('failed')
    expect(failed.diagnostics.map(diagnostic => diagnostic.code)).toEqual(['scheduler/node-failed'])
    const [activation] = await h.scheduler.listActivations({ projectId: h.projectId, runId })
    if (activation === undefined) throw new Error('the activation is missing')

    const retried = await h.scheduler.retry({ projectId: h.projectId, runId, activationId: activation.activationId })
    expect(String(retried.attemptId)).toHaveLength(36)
    await expect(h.scheduler.getRun({ projectId: h.projectId, runId })).resolves.toMatchObject({ status: 'succeeded' })
    const attempts = await h.scheduler.listAttempts({ projectId: h.projectId, runId, activationId: activation.activationId })
    expect(attempts.map(attempt => [attempt.attemptNo, attempt.status])).toEqual([[1, 'failed'], [2, 'succeeded']])
    expect(attempts[0]?.error).toEqual({ code: 'node/boom', message: 'first attempt' })
  })

  it('refuses a retry that would duplicate live or finished work', async () => {
    const h = await mounted()
    const revision = await define(h, definition([pythonNode('a')], []))
    h.scheduler.registerExecutor(new FakeExecutor('python', () => ({ status: 'succeeded', value: null })))
    const runId = await startRun(h, revision)
    const [activation] = await h.scheduler.listActivations({ projectId: h.projectId, runId })
    if (activation === undefined) throw new Error('the activation is missing')
    await expect(refusal(() => h.scheduler.retry({ projectId: h.projectId, runId, activationId: activation.activationId })))
      .resolves.toBe('scheduler/activation-not-retryable')

    await h.scheduler.tick({ projectId: h.projectId, runId })
    await expect(refusal(() => h.scheduler.retry({ projectId: h.projectId, runId, activationId: activation.activationId })))
      .resolves.toBe('scheduler/activation-not-retryable')
    await expect(refusal(() => h.scheduler.retry({ projectId: h.projectId, runId, activationId: 'ghost' as never })))
      .resolves.toBe('scheduler/activation-not-found')
  })
})

describe('reconcile', () => {
  it('marks in-flight attempts interrupted and parks every running run', async () => {
    const h = await mounted()
    const revision = await define(h, definition([pythonNode('a'), pythonNode('b')], [edge('a', 'b')]))
    const gate = deferred<{ status: 'succeeded'; value: null }>()
    let call = 0
    const python = new FakeExecutor('python', () => {
      call += 1
      if (call === 2) return gate.promise
      return { status: 'succeeded', value: null }
    })
    h.scheduler.registerExecutor(python)
    const runId = await startRun(h, revision)

    const ticking = h.scheduler.tick({ projectId: h.projectId, runId })
    await waitFor(() => python.calls.length === 2)
    const recovered = await h.scheduler.reconcile({ projectId: h.projectId })
    expect(recovered.interrupted).toHaveLength(1)
    expect(recovered.interrupted[0]).toMatchObject({ runId, nodeId: 'b', iteration: 0 })
    expect(recovered.paused).toEqual([runId])
    gate.resolve({ status: 'succeeded', value: null })
    const stale = await ticking
    expect(stale.diagnostics.map(diagnostic => diagnostic.code)).toContain('scheduler/stale-result')

    await expect(h.scheduler.getRun({ projectId: h.projectId, runId })).resolves.toMatchObject({
      status: 'paused',
      reason: 'recovered after restart',
    })
    const attempts = await h.scheduler.listAttempts({ projectId: h.projectId, runId })
    expect(attempts.map(attempt => attempt.status)).toEqual(['succeeded', 'interrupted'])
    await expect(h.scheduler.reconcile({ projectId: h.projectId })).resolves.toEqual({ interrupted: [], paused: [], waiting: [] })
  })
})

describe('concurrent and cross-run behavior', () => {
  it('serializes two concurrent ticks of one run', async () => {
    const h = await mounted()
    const revision = await define(h, definition([pythonNode('a'), pythonNode('b')], [edge('a', 'b')]))
    const python = new FakeExecutor('python', () => ({ status: 'succeeded', value: null }))
    h.scheduler.registerExecutor(python)
    const runId = await startRun(h, revision)

    const [first, second] = await Promise.all([
      h.scheduler.tick({ projectId: h.projectId, runId }),
      h.scheduler.tick({ projectId: h.projectId, runId }),
    ])
    expect(first.status).toBe('succeeded')
    expect(second.status).toBe('succeeded')
    expect(python.calls).toHaveLength(2)
    const attempts = await h.scheduler.listAttempts({ projectId: h.projectId, runId })
    expect(attempts).toHaveLength(2)
  })

  it('leaves another run\'s in-flight attempts alone when pausing or canceling', async () => {
    const h = await mounted()
    const revision = await define(h, definition([pythonNode('a'), pythonNode('b')], [edge('a', 'b')]))
    const gate = deferred<{ status: 'succeeded'; value: null }>()
    let blocked = 0
    const python = new FakeExecutor('python', () => {
      blocked += 1
      return blocked === 2 ? gate.promise : { status: 'succeeded', value: null }
    })
    h.scheduler.registerExecutor(python)
    const busy = await startRun(h, revision)
    const idle = await startRun(h, revision)

    const ticking = h.scheduler.tick({ projectId: h.projectId, runId: busy })
    await waitFor(() => python.calls.length === 2)
    await h.scheduler.pause({ projectId: h.projectId, runId: idle })
    await h.scheduler.cancel({ projectId: h.projectId, runId: idle })
    gate.resolve({ status: 'succeeded', value: null })
    await expect(ticking).resolves.toMatchObject({ status: 'succeeded' })
    const busyAttempts = await h.scheduler.listAttempts({ projectId: h.projectId, runId: busy })
    expect(busyAttempts.map(attempt => attempt.status)).toEqual(['succeeded', 'succeeded'])
  })

  it('refuses a retry on a canceled run', async () => {
    const h = await mounted()
    const revision = await define(h, definition([pythonNode('a')], []))
    h.scheduler.registerExecutor(new FakeExecutor('python', () => ({ status: 'succeeded', value: null })))
    const runId = await startRun(h, revision)
    const [activation] = await h.scheduler.listActivations({ projectId: h.projectId, runId })
    if (activation === undefined) throw new Error('the activation is missing')
    await h.scheduler.cancel({ projectId: h.projectId, runId })
    await expect(refusal(() => h.scheduler.retry({
      projectId: h.projectId,
      runId,
      activationId: activation.activationId,
    }))).resolves.toBe('scheduler/run-state-invalid')
  })

  it('reads an unknown run as undefined', async () => {
    const h = await mounted()
    const revision = await define(h, definition([pythonNode('a')], []))
    const runId = await startRun(h, revision)
    await expect(h.scheduler.getRun({ projectId: h.projectId, runId: 'ghost' as typeof runId }))
      .resolves.toBeUndefined()
  })

  it('aborts in-flight attempts and forgets executors when the fiber is disposed', async () => {
    const h = await mounted()
    const revision = await define(h, definition([pythonNode('a'), pythonNode('b')], [edge('a', 'b')]))
    const gate = deferred<{ status: 'succeeded'; value: null }>()
    let blocked = 0
    const python = new FakeExecutor('python', () => {
      blocked += 1
      return blocked === 2 ? gate.promise : { status: 'succeeded', value: null }
    })
    h.scheduler.registerExecutor(python)
    const runId = await startRun(h, revision)

    const ticking = h.scheduler.tick({ projectId: h.projectId, runId })
    await waitFor(() => python.calls.length === 2)
    const signal = python.calls[1]?.signal
    await h.disposeScheduler()
    expect(signal?.aborted).toBe(true)
    gate.resolve({ status: 'succeeded', value: null })
    await expect(ticking).resolves.toMatchObject({ status: 'succeeded' })
    await expect(refusal(() => h.scheduler.tick({ projectId: h.projectId, runId })))
      .resolves.toBe('scheduler/closed')
  })
})

describe('pause with several attempts in flight', () => {
  it('waits for every dispatched attempt before the pass returns', async () => {
    const h = await mounted({ maxConcurrent: 2 })
    const revision = await define(h, definition(
      [pythonNode('a'), pythonNode('b'), pythonNode('c')],
      [edge('a', 'b'), edge('a', 'c')],
    ))
    const first = deferred<{ status: 'succeeded'; value: null }>()
    const second = deferred<{ status: 'succeeded'; value: null }>()
    const gates = [first, second]
    let branch = 0
    const python = new FakeExecutor('python', (call) => {
      if (call.activation.node.id === 'a') return { status: 'succeeded', value: null }
      const gate = gates[branch]
      branch += 1
      return gate === undefined ? { status: 'succeeded', value: null } : gate.promise
    })
    h.scheduler.registerExecutor(python)
    const runId = await startRun(h, revision)

    const ticking = h.scheduler.tick({ projectId: h.projectId, runId })
    await waitFor(() => python.calls.length === 3)
    await h.scheduler.pause({ projectId: h.projectId, runId })
    first.resolve({ status: 'succeeded', value: null })
    // The pass keeps waiting for the second attempt it already dispatched.
    await new Promise(resolve => setTimeout(resolve, 10))
    second.resolve({ status: 'succeeded', value: null })
    const result = await ticking
    expect(result.status).toBe('paused')
    const attempts = await h.scheduler.listAttempts({ projectId: h.projectId, runId })
    expect(attempts.map(attempt => attempt.status)).toEqual(['succeeded', 'canceled', 'canceled'])
  })

  it('refuses a step on an activation that is no longer pending', async () => {
    const h = await mounted()
    const revision = await define(h, definition([pythonNode('a'), pythonNode('b')], [edge('a', 'b')]))
    h.scheduler.registerExecutor(new FakeExecutor('python', () => ({ status: 'succeeded', value: null })))
    const runId = await startRun(h, revision)
    const [entry] = await h.scheduler.listActivations({ projectId: h.projectId, runId })
    if (entry === undefined) throw new Error('the entry activation is missing')
    await h.scheduler.step({ projectId: h.projectId, runId, activationId: entry.activationId })
    await expect(refusal(() => h.scheduler.step({ projectId: h.projectId, runId, activationId: entry.activationId })))
      .resolves.toBe('scheduler/activation-not-ready')
  })
})
