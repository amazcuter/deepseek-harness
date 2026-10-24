/**
 * The deterministic Python fixture: a real interpreter runs four node
 * functions that report JSON values, and the assertions follow the scheduler's
 * durable rows — the values every attempt committed, which edge each result
 * selected, how many loop iterations the gate used, what each activation's
 * join collected, the run's final status, and the outbox event per attempt.
 *
 * A host without a supported interpreter skips these suites with a named
 * reason; the adapter's decisions are covered without one in `executor.spec.ts`.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { JsonValue } from '@metaworkflow/util-values'
import type { ActivationView, AttemptView, RunView } from '@metaworkflow/workflow-scheduler'
import type { RunId } from '@metaworkflow/workflow-project-store'
import { define, definition, edge, hostPython, mount, PYTHON_SKIP_REASON, pythonNode } from './support/harness.ts'
import type { Harness } from './support/harness.ts'

/** One attempt with the activation it belongs to and the events it staged. */
interface AttemptRow {
  readonly nodeId: string
  readonly iteration: number
  readonly attemptNo: number
  readonly status: AttemptView['status']
  readonly events: readonly AttemptEvent[]
}

/** One staged outbox payload. */
interface AttemptEvent {
  readonly type: string
  readonly nodeId: string
  readonly iteration: number
  readonly attemptNo: number
  readonly status: string
  readonly value?: JsonValue
}

const PREPARE = `
import json, pathlib

STATE = pathlib.Path(__file__).resolve().parents[2] / 'state.json'


def nodemain_prepare(inputs):
    STATE.write_text(json.dumps({'n': inputs['start']}), encoding='utf-8')
    return json.dumps({'n': inputs['start']})
`

const GATE = `
import json, pathlib

STATE = pathlib.Path(__file__).resolve().parents[2] / 'state.json'


def nodemain_gate(inputs):
    n = json.loads(STATE.read_text(encoding='utf-8'))['n']
    return json.dumps({'passed': n >= inputs['target'], 'n': n})
`

const REVISE = `
import json, pathlib

STATE = pathlib.Path(__file__).resolve().parents[2] / 'state.json'


def nodemain_revise(inputs):
    n = json.loads(STATE.read_text(encoding='utf-8'))['n'] + 1
    STATE.write_text(json.dumps({'n': n}), encoding='utf-8')
    return json.dumps({'n': n})
`

const PUBLISH = `
import json


def nodemain_publish(inputs):
    return json.dumps({'published': inputs['n']})
`

const PASSED_TRUE = { op: 'eq', field: 'passed', value: true } as const
const PASSED_FALSE = { op: 'eq', field: 'passed', value: false } as const

/**
 * The fixture graph: prepare seeds the state, gate branches, revise bumps the
 * state and loops back to the gate, and publish reads the gate's passing value.
 * @param maxIterations - bound on the revise-to-gate loop.
 * @returns the definition.
 */
function reviseLoop(maxIterations: number) {
  return definition(
    [
      pythonNode('prepare', PREPARE, { inputs: [{ name: 'start', source: { kind: 'run', key: 'start' } }] }),
      pythonNode('gate', GATE, { inputs: [{ name: 'target', source: { kind: 'run', key: 'target' } }] }),
      pythonNode('revise', REVISE),
      pythonNode('publish', PUBLISH, { inputs: [{ name: 'n', source: { kind: 'node', nodeId: 'gate', field: 'n' } }] }),
    ],
    [
      edge('prepare', 'gate'),
      edge('gate', 'publish', { mode: 'exclusive', condition: PASSED_TRUE }),
      edge('gate', 'revise', { mode: 'exclusive', condition: PASSED_FALSE }),
      edge('revise', 'gate', { maxIterations }),
    ],
  )
}

/**
 * Read one run's attempts with their activation facts and staged events.
 * @param harness - mounted harness holding the run.
 * @param runId - run to read.
 * @returns the attempts in attempt-number order.
 */
async function attemptRows(harness: Harness, runId: RunId): Promise<AttemptRow[]> {
  const activations = new Map((await harness.scheduler.listActivations({ projectId: harness.projectId, runId }))
    .map(activation => [activation.activationId, activation]))
  const attempts = await harness.scheduler.listAttempts({ projectId: harness.projectId, runId })
  const rows: AttemptRow[] = []
  for (const attempt of attempts) {
    const activation = activations.get(attempt.activationId)
    if (activation === undefined) throw new Error(`attempt "${attempt.attemptId}" has no activation row`)
    const outbox = await harness.store.listOutbox(harness.projectId, attempt.attemptId)
    rows.push({
      nodeId: activation.nodeId,
      iteration: activation.iteration,
      attemptNo: attempt.attemptNo,
      status: attempt.status,
      events: outbox.map(entry => JSON.parse(entry.payload) as AttemptEvent),
    })
  }
  return rows
}

/**
 * The committed value of one attempt.
 * @param rows - attempts of one run.
 * @param nodeId - node to read.
 * @param iteration - loop iteration to read.
 * @returns the JSON value the attempt committed, or `undefined`.
 */
function committedValue(rows: readonly AttemptRow[], nodeId: string, iteration: number): JsonValue | undefined {
  return rows.find(row => row.nodeId === nodeId && row.iteration === iteration)?.events[0]?.value
}

/**
 * The activations of one node, in creation order.
 * @param activations - every activation of one run.
 * @param nodeId - node to filter.
 * @returns the node's activations.
 */
function activationsOf(activations: readonly ActivationView[], nodeId: string): ActivationView[] {
  return activations.filter(activation => activation.nodeId === nodeId)
}

/**
 * Read one run back, requiring it to exist.
 * @param harness - mounted harness holding the run.
 * @param runId - run to read.
 * @returns the run view.
 */
async function readRun(harness: Harness, runId: RunId): Promise<RunView> {
  const run = await harness.scheduler.getRun({ projectId: harness.projectId, runId })
  if (run === undefined) throw new Error(`run "${runId}" is not recorded`)
  return run
}

describe.skipIf(hostPython === undefined)(`python nodes through the scheduler (${PYTHON_SKIP_REASON})`, () => {
  let harness: Harness

  beforeAll(async () => {
    harness = await mount()
  })

  afterAll(async () => {
    await harness.close()
  })

  it('routes a looping graph to publish and commits one outbox row per attempt', async () => {
    const revision = await define(harness, reviseLoop(3))
    const { runId } = await harness.scheduler.createRun({
      projectId: harness.projectId,
      definitionRevision: revision,
      params: { start: 0, target: 2 },
    })

    const tick = await harness.scheduler.tick({ projectId: harness.projectId, runId })
    const run = await readRun(harness, runId)
    const activations = await harness.scheduler.listActivations({ projectId: harness.projectId, runId })
    const rows = await attemptRows(harness, runId)

    expect(tick.status).toBe('succeeded')
    expect(tick.dispatched).toBe(7)
    expect(tick.diagnostics).toEqual([])
    expect(run).toMatchObject({ status: 'succeeded', reason: null, definitionRevision: revision })

    // Every node ran in the iteration its edges named: the gate three times, revise twice, publish once.
    expect(activationsOf(activations, 'prepare').map(activation => activation.iteration)).toEqual([0])
    expect(activationsOf(activations, 'gate').map(activation => activation.iteration)).toEqual([0, 1, 2])
    expect(activationsOf(activations, 'revise').map(activation => activation.iteration)).toEqual([0, 1])
    expect(activationsOf(activations, 'publish').map(activation => activation.iteration)).toEqual([2])

    // The join: the first gate round joins prepare, later rounds join the revise that re-entered it.
    expect(activationsOf(activations, 'gate').map(activation => activation.incoming)).toEqual([
      [{ nodeId: 'prepare', iteration: 0 }],
      [{ nodeId: 'revise', iteration: 0 }],
      [{ nodeId: 'revise', iteration: 1 }],
    ])

    // The values the real interpreter returned, as each attempt committed them.
    expect(committedValue(rows, 'prepare', 0)).toEqual({ n: 0 })
    expect(committedValue(rows, 'gate', 0)).toEqual({ passed: false, n: 0 })
    expect(committedValue(rows, 'gate', 1)).toEqual({ passed: false, n: 1 })
    expect(committedValue(rows, 'gate', 2)).toEqual({ passed: true, n: 2 })
    expect(committedValue(rows, 'revise', 0)).toEqual({ n: 1 })
    expect(committedValue(rows, 'revise', 1)).toEqual({ n: 2 })
    expect(committedValue(rows, 'publish', 2)).toEqual({ published: 2 })

    // Each attempt committed once and staged exactly one result event.
    expect(rows).toHaveLength(7)
    expect(rows.every(row => row.status === 'succeeded')).toBe(true)
    for (const row of rows) {
      expect(row.attemptNo).toBe(1)
      expect(row.events).toHaveLength(1)
      expect(row.events[0]).toMatchObject({
        type: 'scheduler/attempt-result',
        nodeId: row.nodeId,
        iteration: row.iteration,
        attemptNo: 1,
        status: 'succeeded',
      })
    }

    // Execution is read-only for the definition: the run still points at the only stored revision.
    await expect(harness.store.readDefinition(harness.projectId)).resolves.toMatchObject({ revision })
  }, 120_000)

  it('stops the loop at its iteration bound and fails the run', async () => {
    const revision = await define(harness, reviseLoop(2))
    const { runId } = await harness.scheduler.createRun({
      projectId: harness.projectId,
      definitionRevision: revision,
      params: { start: 0, target: 5 },
    })

    const tick = await harness.scheduler.tick({ projectId: harness.projectId, runId })
    const run = await readRun(harness, runId)
    const activations = await harness.scheduler.listActivations({ projectId: harness.projectId, runId })

    expect(tick.status).toBe('failed')
    expect(tick.diagnostics.map(diagnostic => diagnostic.code)).toContain('scheduler/loop-exhausted')
    expect(run.status).toBe('failed')
    expect(run.reason).toContain('scheduler/loop-exhausted')
    expect(activationsOf(activations, 'gate').map(activation => activation.iteration)).toEqual([0, 1, 2])
    expect(activationsOf(activations, 'revise').map(activation => activation.iteration)).toEqual([0, 1, 2])
    expect(activationsOf(activations, 'publish')).toEqual([])
  }, 120_000)
})
