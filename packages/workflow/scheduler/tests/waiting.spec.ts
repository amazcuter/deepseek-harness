/**
 * Waiting semantics: a node that suspends itself releases its slot, keeps its
 * activation and attempt waiting, blocks a join until it succeeds, survives a
 * recovery pass, and wakes through `resumeActivation` with the answer as its
 * next input.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { WorkflowSchedulerError } from '../src/index.ts'
import { PENDING_DECISIONS_KEY } from '../src/index.ts'
import { FakeExecutor, define, definition, edge, harness, pythonNode, startRun } from './support/harness.ts'
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

describe('waiting activations', () => {
  it('wakes one with the answer as its next input and continues the run', async () => {
    const h = await mounted()
    const revision = await define(h, definition(
      [pythonNode('a'), pythonNode('b'), pythonNode('c')],
      [edge('a', 'b'), edge('b', 'c')],
    ))
    const python = new FakeExecutor('python', (call) => {
      if (call.activation.node.id === 'b' && call.activation.decision === undefined) {
        return { status: 'waiting', requestId: 'decision-1' }
      }
      return { status: 'succeeded', value: { ok: true } }
    })
    h.scheduler.registerExecutor(python)
    const runId = await startRun(h, revision)

    await expect(h.scheduler.tick({ projectId: h.projectId, runId })).resolves.toMatchObject({
      status: 'running',
      dispatched: 2,
      completed: 2,
    })
    const waiting = (await h.scheduler.listActivations({ projectId: h.projectId, runId }))
      .find(activation => activation.nodeId === 'b')
    if (waiting === undefined) throw new Error('the waiting activation is missing')
    expect(waiting.status).toBe('waiting')
    const attempts = await h.scheduler.listAttempts({ projectId: h.projectId, runId, activationId: waiting.activationId })
    expect(attempts).toMatchObject([{ status: 'waiting', error: { code: 'scheduler/waiting' } }])
    // A waiting attempt records when it stopped, without committing a result.
    expect(attempts[0]?.endedAt).toBeTypeOf('number')

    const resumed = await h.scheduler.resumeActivation({
      projectId: h.projectId,
      runId,
      activationId: waiting.activationId,
      decision: { approved: true },
    })
    expect(resumed).toMatchObject({ status: 'succeeded', dispatched: 2, completed: 2 })
    const resumedCall = python.calls.find(call => call.activation.node.id === 'b' && call.activation.decision !== undefined)
    expect(resumedCall?.activation.decision).toEqual({ approved: true })
    // The answer is the resuming attempt's input, never one of its bindings.
    expect(resumedCall?.inputs).toEqual({})
    await expect(h.scheduler.listActivations({ projectId: h.projectId, runId })).resolves.toMatchObject([
      { nodeId: 'a', status: 'succeeded' },
      { nodeId: 'b', status: 'succeeded' },
      { nodeId: 'c', status: 'succeeded' },
    ])
  })

  it('does not satisfy an all join until the waiting activation succeeds', async () => {
    const h = await mounted()
    const revision = await define(h, definition(
      [pythonNode('a'), pythonNode('b'), pythonNode('c'), pythonNode('d')],
      [edge('a', 'b'), edge('a', 'c'), edge('b', 'd'), edge('c', 'd')],
    ))
    const python = new FakeExecutor('python', (call) => {
      if (call.activation.node.id === 'b' && call.activation.decision === undefined) {
        return { status: 'waiting', requestId: 'decision-1' }
      }
      return { status: 'succeeded', value: null }
    })
    h.scheduler.registerExecutor(python)
    const runId = await startRun(h, revision)

    await h.scheduler.tick({ projectId: h.projectId, runId })
    // `d` may already be activated by the branch that finished first, but an
    // `all` join never fires while a declared predecessor is still open.
    expect((await h.scheduler.listActivations({ projectId: h.projectId, runId }))
      .map(activation => [activation.nodeId, activation.status]))
      .toEqual([['a', 'succeeded'], ['b', 'waiting'], ['c', 'succeeded'], ['d', 'pending']])

    const waiting = (await h.scheduler.listActivations({ projectId: h.projectId, runId }))
      .find(activation => activation.nodeId === 'b')
    if (waiting === undefined) throw new Error('the waiting activation is missing')
    await h.scheduler.resumeActivation({
      projectId: h.projectId,
      runId,
      activationId: waiting.activationId,
      decision: { approved: true },
    })
    await expect(h.scheduler.getRun({ projectId: h.projectId, runId })).resolves.toMatchObject({ status: 'succeeded' })
  })

  it('refuses an activation that is not waiting', async () => {
    const h = await mounted()
    const revision = await define(h, definition([pythonNode('a')], []))
    h.scheduler.registerExecutor(new FakeExecutor('python', () => ({ status: 'succeeded', value: null })))
    const runId = await startRun(h, revision)
    const [activation] = await h.scheduler.listActivations({ projectId: h.projectId, runId })
    if (activation === undefined) throw new Error('the entry activation is missing')

    await expect(refusal(() => h.scheduler.resumeActivation({
      projectId: h.projectId,
      runId,
      activationId: activation.activationId,
    }))).resolves.toBe('scheduler/activation-not-resumable')
    await expect(refusal(() => h.scheduler.resumeActivation({
      projectId: h.projectId,
      runId,
      activationId: 'ghost' as never,
    }))).resolves.toBe('scheduler/activation-not-found')

    await h.scheduler.tick({ projectId: h.projectId, runId })
    await expect(refusal(() => h.scheduler.resumeActivation({
      projectId: h.projectId,
      runId,
      activationId: activation.activationId,
    }))).resolves.toBe('scheduler/run-state-invalid')
  })

  it('reopens a run that a recovery pass parked', async () => {
    const h = await mounted()
    const revision = await define(h, definition(
      [pythonNode('a'), pythonNode('b')],
      [edge('a', 'b')],
    ))
    const python = new FakeExecutor('python', call => call.activation.node.id === 'b' && call.activation.decision === undefined
      ? { status: 'waiting', requestId: 'decision-1' }
      : { status: 'succeeded', value: null })
    h.scheduler.registerExecutor(python)
    const runId = await startRun(h, revision)
    await h.scheduler.tick({ projectId: h.projectId, runId })

    const recovered = await h.scheduler.reconcile({ projectId: h.projectId })
    expect(recovered.interrupted).toEqual([])
    expect(recovered.paused).toEqual([runId])
    expect(recovered.waiting.map(entry => [entry.runId, entry.nodeId, entry.iteration])).toEqual([[runId, 'b', 0]])
    expect(recovered.waiting[0]?.activationId).toBeTypeOf('string')
    expect(recovered.waiting[0]?.attemptId).toBeTypeOf('string')
    // The pass leaves a waiting activation alone: its attempt is not interrupted.
    const attempts = await h.scheduler.listAttempts({ projectId: h.projectId, runId })
    expect(attempts.map(attempt => attempt.status)).toEqual(['succeeded', 'waiting'])

    const waiting = (await h.scheduler.listActivations({ projectId: h.projectId, runId }))
      .find(activation => activation.nodeId === 'b')
    if (waiting === undefined) throw new Error('the waiting activation is missing')
    await h.scheduler.resumeActivation({
      projectId: h.projectId,
      runId,
      activationId: waiting.activationId,
      decision: 'go ahead',
    })
    await expect(h.scheduler.getRun({ projectId: h.projectId, runId })).resolves.toMatchObject({ status: 'succeeded' })
  })

  it('keeps the answer until an attempt commits and drops it afterwards', async () => {
    const h = await mounted()
    const revision = await define(h, definition([pythonNode('a')], []))
    const python = new FakeExecutor('python', (call) => {
      if (python.calls.length === 1) return { status: 'waiting', requestId: 'decision-1' }
      if (call.activation.decision === 'again') return { status: 'waiting', requestId: 'decision-2' }
      return { status: 'succeeded', value: null }
    })
    h.scheduler.registerExecutor(python)
    const runId = await startRun(h, revision)
    await h.scheduler.tick({ projectId: h.projectId, runId })
    const [activation] = await h.scheduler.listActivations({ projectId: h.projectId, runId })
    if (activation === undefined) throw new Error('the activation is missing')

    // The resumed attempt asked again, so its commit consumed the answer.
    await h.scheduler.resumeActivation({ projectId: h.projectId, runId, activationId: activation.activationId, decision: 'again' })
    await h.scheduler.resumeActivation({ projectId: h.projectId, runId, activationId: activation.activationId })
    const last = python.calls[python.calls.length - 1]
    expect(last?.activation.decision).toBeUndefined()
    await expect(h.scheduler.getRun({ projectId: h.projectId, runId })).resolves.toMatchObject({ status: 'succeeded' })
  })

  it('refuses a corrupt pending-decision record instead of guessing', async () => {
    const h = await mounted()
    const revision = await define(h, definition([pythonNode('a')], []))
    h.scheduler.registerExecutor(new FakeExecutor('python', () => ({ status: 'succeeded', value: null })))
    for (const value of ['not json', '[]']) {
      await h.store.transact(h.projectId, (db) => {
        db.prepare('INSERT INTO schema_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
          .run(PENDING_DECISIONS_KEY, value)
      })
      const runId = await startRun(h, revision)
      await expect(h.scheduler.tick({ projectId: h.projectId, runId })).rejects.toThrow(PENDING_DECISIONS_KEY)
    }
  })
})
