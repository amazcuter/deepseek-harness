/**
 * Restart recovery over a real interpreter: a node that sleeps long enough to
 * be interrupted, the recovery pass a restarted backend runs, and the two ways
 * a run continues afterwards.
 *
 * A reconciled run keeps the interrupted attempt as history, parks itself, and
 * re-executes the activation on the next tick; the first execution's late
 * result is stale and commits nothing. A failed activation is retried as a new
 * attempt through `retry`, and the run continues from there.
 */

import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { fileExists } from '@metaworkflow/workflow-python-runner/src/venv.ts'
import { define, definition, hostPython, mount, PYTHON_SKIP_REASON, pythonNode, waitFor } from './support/harness.ts'
import type { Harness } from './support/harness.ts'

/**
 * Require one element of a list the surrounding assertions already bounded.
 * @param items - list to read.
 * @param index - position to read.
 * @param what - description used when the position is empty.
 * @returns the element at that position.
 */
function entry<T>(items: readonly T[], index: number, what: string): T {
  const item = items[index]
  if (item === undefined) throw new Error(`${what} is missing at position ${String(index)}`)
  return item
}

/** A node that records that it started, then sleeps long enough to be interrupted. */
const SLEEPY = `
import json, pathlib, time

STARTED = pathlib.Path(__file__).resolve().parents[2] / 'started.txt'


def nodemain_sleepy(inputs):
    STARTED.write_text('1', encoding='utf-8')
    time.sleep(inputs['seconds'])
    return json.dumps({'slept': inputs['seconds']})
`

/** A node whose first execution raises and whose later executions succeed. */
const FLAKY = `
import json, pathlib

ATTEMPTED = pathlib.Path(__file__).resolve().parents[2] / 'attempted.txt'


def nodemain_flaky(inputs):
    if not ATTEMPTED.exists():
        ATTEMPTED.write_text('1', encoding='utf-8')
        raise RuntimeError('the first attempt fails on purpose')
    return json.dumps({'ok': True})
`

describe.skipIf(hostPython === undefined)(`restart recovery (${PYTHON_SKIP_REASON})`, () => {
  let harness: Harness

  beforeAll(async () => {
    harness = await mount()
  })

  afterAll(async () => {
    await harness.close()
  })

  it('marks the interrupted attempt, parks the run, and re-executes it after a resume', async () => {
    const sleepy = pythonNode('sleepy', SLEEPY, { inputs: [{ name: 'seconds', source: { kind: 'run', key: 'seconds' } }] })
    const revision = await define(harness, definition([sleepy], []))
    const { runId } = await harness.scheduler.createRun({
      projectId: harness.projectId,
      definitionRevision: revision,
      params: { seconds: 2 },
    })

    const ticking = harness.scheduler.tick({ projectId: harness.projectId, runId })
    await waitFor(async () => await fileExists(join(harness.project.path, 'started.txt')))

    // The recovery pass a backend runs after a restart, while the node is still executing.
    const recovered = await harness.scheduler.reconcile({ projectId: harness.projectId })
    expect(recovered.interrupted).toHaveLength(1)
    expect(entry(recovered.interrupted, 0, 'the interrupted attempt')).toMatchObject({ runId, nodeId: 'sleepy', iteration: 0 })
    expect(recovered.paused).toEqual([runId])

    const stale = await ticking
    await expect(harness.scheduler.getRun({ projectId: harness.projectId, runId })).resolves.toMatchObject({
      status: 'paused',
      reason: 'recovered after restart',
    })
    const interruptedAttempts = await harness.scheduler.listAttempts({ projectId: harness.projectId, runId })
    expect(stale.diagnostics.map(diagnostic => diagnostic.code)).toContain('scheduler/stale-result')
    expect(interruptedAttempts).toHaveLength(1)
    const interrupted = entry(interruptedAttempts, 0, 'the interrupted attempt')
    expect(interrupted).toMatchObject({ attemptNo: 1, status: 'interrupted', error: null })
    // The interrupted attempt committed nothing: its only trace is the attempt row.
    await expect(harness.store.listOutbox(harness.projectId, interrupted.attemptId)).resolves.toEqual([])

    // A recovered activation is pending, not failed, so the recovery path re-executes it; retry refuses it.
    const activations = await harness.scheduler.listActivations({ projectId: harness.projectId, runId })
    expect(activations.map(activation => activation.status)).toEqual(['pending'])
    await expect(harness.scheduler.retry({ projectId: harness.projectId, runId, activationId: entry(activations, 0, 'the recovered activation').activationId }))
      .rejects.toMatchObject({ code: 'scheduler/activation-not-retryable' })

    await harness.scheduler.resume({ projectId: harness.projectId, runId })
    const resumed = await harness.scheduler.tick({ projectId: harness.projectId, runId })
    expect(resumed.status).toBe('succeeded')

    const attempts = await harness.scheduler.listAttempts({ projectId: harness.projectId, runId })
    expect(attempts.map(attempt => [attempt.attemptNo, attempt.status])).toEqual([[1, 'interrupted'], [2, 'succeeded']])
    const events = await harness.store.listOutbox(harness.projectId, entry(attempts, 1, 'the resumed attempt').attemptId)
    expect(events).toHaveLength(1)
    expect(JSON.parse(entry(events, 0, 'the staged result event').payload)).toMatchObject({
      type: 'scheduler/attempt-result',
      attemptNo: 2,
      status: 'succeeded',
      value: { slept: 2 },
    })
    await expect(harness.scheduler.getRun({ projectId: harness.projectId, runId })).resolves.toMatchObject({ status: 'succeeded', reason: null })
  }, 180_000)

  it('retries a failed activation as a new attempt and finishes the run', async () => {
    const flaky = pythonNode('flaky', FLAKY)
    const revision = await define(harness, definition([flaky], []))
    const { runId } = await harness.scheduler.createRun({ projectId: harness.projectId, definitionRevision: revision })

    const failed = await harness.scheduler.tick({ projectId: harness.projectId, runId })
    expect(failed.status).toBe('failed')
    expect(failed.diagnostics.map(diagnostic => diagnostic.code)).toContain('scheduler/node-failed')
    const failedRun = await harness.scheduler.getRun({ projectId: harness.projectId, runId })
    expect(failedRun?.status).toBe('failed')
    expect(failedRun?.reason).toContain('node/exception')
    const firstAttempts = await harness.scheduler.listAttempts({ projectId: harness.projectId, runId })
    expect(firstAttempts.map(attempt => [attempt.attemptNo, attempt.status])).toEqual([[1, 'failed']])
    expect(entry(firstAttempts, 0, 'the failed attempt').error).toMatchObject({ code: 'node/exception' })

    const activations = await harness.scheduler.listActivations({ projectId: harness.projectId, runId })
    await harness.scheduler.retry({ projectId: harness.projectId, runId, activationId: entry(activations, 0, 'the failed activation').activationId })
    const recovered = await harness.scheduler.tick({ projectId: harness.projectId, runId })
    expect(recovered.status).toBe('succeeded')

    const attempts = await harness.scheduler.listAttempts({ projectId: harness.projectId, runId })
    expect(attempts.map(attempt => [attempt.attemptNo, attempt.status])).toEqual([[1, 'failed'], [2, 'succeeded']])
    const failedEvents = await harness.store.listOutbox(harness.projectId, entry(attempts, 0, 'the failed attempt').attemptId)
    expect(JSON.parse(entry(failedEvents, 0, 'the staged failure event').payload)).toMatchObject({
      type: 'scheduler/attempt-result',
      attemptNo: 1,
      status: 'failed',
      error: { code: 'node/exception' },
    })
    const succeededEvents = await harness.store.listOutbox(harness.projectId, entry(attempts, 1, 'the retried attempt').attemptId)
    expect(JSON.parse(entry(succeededEvents, 0, 'the staged success event').payload)).toMatchObject({ attemptNo: 2, status: 'succeeded', value: { ok: true } })
  }, 180_000)
})
