/**
 * Execution slots: one run never exceeds its concurrency budget, a freed slot
 * admits the next ready activation, and a suspending node gives its slot back.
 */

import { afterEach, describe, expect, it } from 'vitest'
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

/** A graph where `a` starts five independent branches. */
async function fanOfFive(h: Harness): Promise<number> {
  const branches = ['b1', 'b2', 'b3', 'b4', 'b5'].map(id => pythonNode(id))
  return define(h, definition([pythonNode('a'), ...branches], [
    edge('a', 'b1'),
    edge('a', 'b2'),
    edge('a', 'b3'),
    edge('a', 'b4'),
    edge('a', 'b5'),
  ]))
}

/** An executor that records how many executions overlap. */
function overlapping(delayMs: number): { executor: FakeExecutor; observed: () => number } {
  let active = 0
  let maximum = 0
  const executor = new FakeExecutor('python', async (call) => {
    if (call.activation.node.id === 'a') return { status: 'succeeded', value: null }
    active += 1
    maximum = Math.max(maximum, active)
    await new Promise(resolve => setTimeout(resolve, delayMs))
    active -= 1
    return { status: 'succeeded', value: null }
  })
  return { executor, observed: () => maximum }
}

describe('concurrency slots', () => {
  it('never exceeds the configured budget and admits the fifth branch after a release', async () => {
    const h = await mounted({ maxConcurrent: 4 })
    const revision = await fanOfFive(h)
    const { executor, observed } = overlapping(5)
    h.scheduler.registerExecutor(executor)
    const runId = await startRun(h, revision)

    await expect(h.scheduler.tick({ projectId: h.projectId, runId })).resolves.toMatchObject({ status: 'succeeded' })
    expect(observed()).toBe(4)
    expect(executor.calls.filter(call => call.activation.node.id !== 'a')).toHaveLength(5)
  })

  it('honors a smaller configured budget', async () => {
    const h = await mounted({ maxConcurrent: 2 })
    const revision = await fanOfFive(h)
    const { executor, observed } = overlapping(5)
    h.scheduler.registerExecutor(executor)
    const runId = await startRun(h, revision)

    await h.scheduler.tick({ projectId: h.projectId, runId })
    expect(observed()).toBe(2)
    expect(executor.calls.filter(call => call.activation.node.id !== 'a')).toHaveLength(5)
  })

  it('gives the slot back when a node suspends itself', async () => {
    const h = await mounted({ maxConcurrent: 2 })
    const revision = await fanOfFive(h)
    const python = new FakeExecutor('python', (call) => {
      if (call.activation.node.id === 'a') return { status: 'succeeded', value: null }
      if (call.activation.node.id === 'b1') return { status: 'waiting', requestId: 'decision-1' }
      return { status: 'succeeded', value: null }
    })
    h.scheduler.registerExecutor(python)
    const runId = await startRun(h, revision)

    await expect(h.scheduler.tick({ projectId: h.projectId, runId })).resolves.toMatchObject({ status: 'running' })
    expect(python.calls.filter(call => call.activation.node.id !== 'a').map(call => call.activation.node.id))
      .toEqual(['b1', 'b2', 'b3', 'b4', 'b5'])
    const activations = await h.scheduler.listActivations({ projectId: h.projectId, runId })
    expect(activations.map(activation => [activation.nodeId, activation.status])).toEqual([
      ['a', 'succeeded'],
      ['b1', 'waiting'],
      ['b2', 'succeeded'],
      ['b3', 'succeeded'],
      ['b4', 'succeeded'],
      ['b5', 'succeeded'],
    ])
  })
})
