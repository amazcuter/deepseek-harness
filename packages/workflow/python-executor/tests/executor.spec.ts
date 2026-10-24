/**
 * The executor against a scripted runner: what one execution reports for a
 * successful node, every structured failure the runner can produce, the
 * stored-definition authority, an abort, and the registration's lifetime.
 *
 * These cases exercise the adapter's own decisions; the real child process is
 * the subject of `python-nodes.spec.ts` and `restart.spec.ts`.
 */

import { rm } from 'node:fs/promises'
import { afterEach, describe, expect, it } from 'vitest'
import { PythonRunnerError } from '@metaworkflow/workflow-python-runner'
import type { RunNodeResult } from '@metaworkflow/workflow-python-runner'
import type { WorkflowNode } from '@metaworkflow/workflow-definition'
import PythonExecutor from '../src/index.ts'
import type { Config } from '../src/index.ts'
import { activationFor, define, definition, edge, mountStub, pythonNode } from './support/harness.ts'
import type { StubHarness } from './support/harness.ts'

/** Source the scripted runner never executes; the executor still reads it from the store. */
const PREPARE_SOURCE = 'def nodemain_prepare(inputs):\n    return \'{"n": 1}\''

const harnesses: StubHarness[] = []

afterEach(async () => {
  for (const harness of harnesses.splice(0)) await harness.close()
})

/**
 * Mount one scripted composition.
 * @param config - executor configuration.
 * @returns the mounted harness.
 */
async function stubHarness(config?: Config): Promise<StubHarness> {
  const harness = await mountStub(config === undefined ? {} : { config })
  harnesses.push(harness)
  return harness
}

/**
 * Encode one successful runner result.
 * @param value - JSON value the node returned.
 * @returns the run result.
 */
function succeeded(value: unknown): RunNodeResult {
  return { ok: true, value, stdout: '', stderr: '', exitCode: 0, durationMs: 4, timedOut: false }
}

/**
 * Store one single-node definition and start one run from it.
 * @param harness - mounted harness.
 * @param node - the run's only node.
 * @returns the created run.
 */
async function startedRun(harness: StubHarness, node: WorkflowNode): Promise<Awaited<ReturnType<StubHarness['scheduler']['createRun']>>> {
  const revision = await define(harness, definition([node], []))
  return await harness.scheduler.createRun({ projectId: harness.projectId, definitionRevision: revision })
}

describe('one execution', () => {
  it('reports the node value and runs it in the project with the stored source', async () => {
    const harness = await stubHarness()
    const prepare = pythonNode('prepare', PREPARE_SOURCE)
    const { runId } = await startedRun(harness, prepare)
    harness.runner.result = succeeded({ n: 1 })

    const activation = await activationFor(harness, runId, prepare, { start: 1 })
    const controller = new AbortController()
    const result = await harness.executor.execute(activation, { start: 1 }, controller.signal)

    expect(result).toEqual({ status: 'succeeded', value: { n: 1 } })
    expect(harness.runner.environments).toEqual([harness.project.path])
    expect(harness.runner.runs).toHaveLength(1)
    expect(harness.runner.runs[0]).toMatchObject({
      projectDir: harness.project.path,
      nodeId: 'prepare',
      source: PREPARE_SOURCE,
      inputs: { start: 1 },
    })
    expect(harness.runner.runs[0]?.timeoutMs).toBeUndefined()
    expect(harness.runner.runs[0]?.signal).toBe(controller.signal)
  })

  it('reports a node that returned no value as JSON null', async () => {
    const harness = await stubHarness()
    const prepare = pythonNode('prepare', PREPARE_SOURCE)
    const { runId } = await startedRun(harness, prepare)
    harness.runner.result = { ok: true, stdout: '', stderr: '', exitCode: 0, durationMs: 2, timedOut: false }

    const result = await harness.executor.execute(await activationFor(harness, runId, prepare), {}, new AbortController().signal)

    expect(result).toEqual({ status: 'succeeded', value: null })
  })

  it('forwards a configured deadline', async () => {
    const harness = await stubHarness({ timeoutMs: 1_500 })
    const prepare = pythonNode('prepare', PREPARE_SOURCE)
    const { runId } = await startedRun(harness, prepare)

    await harness.executor.execute(await activationFor(harness, runId, prepare), {}, new AbortController().signal)

    expect(harness.runner.runs[0]?.timeoutMs).toBe(1_500)
  })

  it('reports a node failure with the captured stderr', async () => {
    const harness = await stubHarness()
    const prepare = pythonNode('prepare', PREPARE_SOURCE)
    const { runId } = await startedRun(harness, prepare)
    harness.runner.result = {
      ok: false,
      error: { code: 'node/exception', message: 'node "prepare" failed with exit code 1; see stderr' },
      stdout: '',
      stderr: 'Traceback (most recent call last):\nValueError: boom\n',
      exitCode: 1,
      durationMs: 9,
      timedOut: false,
    }

    const result = await harness.executor.execute(await activationFor(harness, runId, prepare), {}, new AbortController().signal)

    expect(result).toEqual({
      status: 'failed',
      error: {
        code: 'node/exception',
        message: 'node "prepare" failed with exit code 1; see stderr\n--- node stderr ---\nTraceback (most recent call last):\nValueError: boom',
      },
      retryable: false,
    })
  })

  it('reports a deadline as the one retryable failure', async () => {
    const harness = await stubHarness()
    const prepare = pythonNode('prepare', PREPARE_SOURCE)
    const { runId } = await startedRun(harness, prepare)
    harness.runner.result = {
      ok: false,
      error: { code: 'node/timeout', message: 'node "prepare" exceeded 2000 ms and its process tree was terminated' },
      stdout: '',
      stderr: '',
      exitCode: null,
      durationMs: 2_000,
      timedOut: true,
    }

    const result = await harness.executor.execute(await activationFor(harness, runId, prepare), {}, new AbortController().signal)

    expect(result).toEqual({
      status: 'failed',
      error: { code: 'node/timeout', message: 'node "prepare" exceeded 2000 ms and its process tree was terminated' },
      retryable: true,
    })
  })

  it('reports a failure that carries no detail', async () => {
    const harness = await stubHarness()
    const prepare = pythonNode('prepare', PREPARE_SOURCE)
    const { runId } = await startedRun(harness, prepare)
    harness.runner.result = { ok: false, stdout: '', stderr: '', exitCode: 2, durationMs: 3, timedOut: false }

    const result = await harness.executor.execute(await activationFor(harness, runId, prepare), {}, new AbortController().signal)

    expect(result).toEqual({
      status: 'failed',
      error: { code: 'node/exception', message: 'the node reported no failure detail' },
      retryable: false,
    })
  })

  it('keeps the runner code when the environment cannot be resolved', async () => {
    const harness = await stubHarness()
    const prepare = pythonNode('prepare', PREPARE_SOURCE)
    const { runId } = await startedRun(harness, prepare)
    harness.runner.environmentError = new PythonRunnerError('python/not-found', 'no usable python interpreter was found')

    const result = await harness.executor.execute(await activationFor(harness, runId, prepare), {}, new AbortController().signal)

    expect(result).toEqual({
      status: 'failed',
      error: { code: 'python/not-found', message: 'no usable python interpreter was found' },
      retryable: false,
    })
  })

  it('reports an unexpected environment failure', async () => {
    const harness = await stubHarness()
    const prepare = pythonNode('prepare', PREPARE_SOURCE)
    const { runId } = await startedRun(harness, prepare)
    harness.runner.environmentError = new Error('venv command could not start')

    const result = await harness.executor.execute(await activationFor(harness, runId, prepare), {}, new AbortController().signal)

    expect(result).toEqual({
      status: 'failed',
      error: { code: 'python/executor-failed', message: 'the python executor failed: venv command could not start' },
      retryable: false,
    })
  })

  it('reports an unexpected run failure', async () => {
    const harness = await stubHarness()
    const prepare = pythonNode('prepare', PREPARE_SOURCE)
    const { runId } = await startedRun(harness, prepare)
    harness.runner.runError = new Error('dispatch exploded')

    const result = await harness.executor.execute(await activationFor(harness, runId, prepare), {}, new AbortController().signal)

    expect(result).toEqual({
      status: 'failed',
      error: { code: 'python/executor-failed', message: 'the python executor failed: dispatch exploded' },
      retryable: false,
    })
  })

  it('reports a rejection that is not an error', async () => {
    const harness = await stubHarness()
    const prepare = pythonNode('prepare', PREPARE_SOURCE)
    const { runId } = await startedRun(harness, prepare)
    harness.runner.runError = 'dispatch exploded'

    const result = await harness.executor.execute(await activationFor(harness, runId, prepare), {}, new AbortController().signal)

    expect(result).toEqual({
      status: 'failed',
      error: { code: 'python/executor-failed', message: 'the python executor failed: dispatch exploded' },
      retryable: false,
    })
  })

  it('refuses an activation that is already aborted', async () => {
    const harness = await stubHarness()
    const prepare = pythonNode('prepare', PREPARE_SOURCE)
    const { runId } = await startedRun(harness, prepare)
    const controller = new AbortController()
    controller.abort(new Error('run paused'))

    await expect(harness.executor.execute(await activationFor(harness, runId, prepare), {}, controller.signal))
      .rejects.toThrow('run paused')
    expect(harness.runner.runs).toHaveLength(0)
    expect(harness.runner.environments).toHaveLength(0)
  })

  it('propagates an abort that arrives while the node runs', async () => {
    const harness = await stubHarness()
    const prepare = pythonNode('prepare', PREPARE_SOURCE)
    const { runId } = await startedRun(harness, prepare)
    const controller = new AbortController()
    harness.runner.beforeRun = () => {
      controller.abort(new Error('run canceled'))
      harness.runner.runError = new Error('run canceled')
    }

    await expect(harness.executor.execute(await activationFor(harness, runId, prepare), {}, controller.signal))
      .rejects.toThrow('run canceled')
  })
})

describe('the stored definition', () => {
  it('reports a revision the project never stored', async () => {
    const harness = await stubHarness()
    const prepare = pythonNode('prepare', PREPARE_SOURCE)
    const { runId } = await startedRun(harness, prepare)
    const activation = await activationFor(harness, runId, prepare)

    const result = await harness.executor.execute({ ...activation, definitionRevision: 9 }, {}, new AbortController().signal)

    expect(result).toMatchObject({
      status: 'failed',
      error: { code: 'python/definition-unavailable' },
      retryable: false,
    })
    expect(harness.runner.runs).toHaveLength(0)
  })

  it('reports a stored document that is not executable', async () => {
    const harness = await stubHarness()
    const prepare = pythonNode('prepare', PREPARE_SOURCE)
    const { runId } = await startedRun(harness, prepare)
    const activation = await activationFor(harness, runId, prepare)
    const revision = await harness.store.writeDefinition(harness.projectId, '{"version":1,"nodes":[],"edges":[]}')

    const result = await harness.executor.execute({ ...activation, definitionRevision: revision }, {}, new AbortController().signal)

    expect(result).toMatchObject({ status: 'failed', error: { code: 'python/definition-unavailable' }, retryable: false })
    expect(result.status === 'failed' ? result.error.message : '').toContain('definition/no-entry-node at nodes')
  })

  it('reports a stored document that is not JSON', async () => {
    const harness = await stubHarness()
    const prepare = pythonNode('prepare', PREPARE_SOURCE)
    const { runId } = await startedRun(harness, prepare)
    const activation = await activationFor(harness, runId, prepare)
    const revision = await harness.store.writeDefinition(harness.projectId, 'not a definition document')

    const result = await harness.executor.execute({ ...activation, definitionRevision: revision }, {}, new AbortController().signal)

    expect(result).toMatchObject({ status: 'failed', error: { code: 'python/definition-unavailable' }, retryable: false })
    expect(result.status === 'failed' ? result.error.message : '').toContain('definition/document-invalid-json at /')
  })

  it('reports a node the stored revision does not declare', async () => {
    const harness = await stubHarness()
    const prepare = pythonNode('prepare', PREPARE_SOURCE)
    const { runId } = await startedRun(harness, prepare)
    const activation = await activationFor(harness, runId, prepare)

    const result = await harness.executor.execute({ ...activation, node: pythonNode('absent', PREPARE_SOURCE) }, {}, new AbortController().signal)

    expect(result).toMatchObject({ status: 'failed', error: { code: 'python/node-unavailable' }, retryable: false })
  })

  it('reports a stored node of another kind', async () => {
    const harness = await stubHarness()
    const agent: WorkflowNode = {
      id: 'review',
      kind: 'agent',
      title: 'review',
      config: { kind: 'agent', instructions: 'review the draft', tools: [], memory: 'fresh', outputSchema: { type: 'object', properties: {} } },
      inputs: [],
      join: 'all',
    }
    const prepared = pythonNode('prepare', PREPARE_SOURCE)
    const revision = await define(harness, definition([prepared, agent], [edge('prepare', 'review')]))
    const { runId } = await harness.scheduler.createRun({ projectId: harness.projectId, definitionRevision: revision })
    const activation = await activationFor(harness, runId, prepared)

    const result = await harness.executor.execute({ ...activation, node: agent }, {}, new AbortController().signal)

    expect(result).toMatchObject({ status: 'failed', error: { code: 'python/node-unavailable' }, retryable: false })
  })

  it('reports a project whose working directory is gone', async () => {
    const harness = await stubHarness()
    const prepare = pythonNode('prepare', PREPARE_SOURCE)
    const { runId } = await startedRun(harness, prepare)
    const activation = await activationFor(harness, runId, prepare)
    await rm(harness.project.path, { recursive: true, force: true })

    const result = await harness.executor.execute(activation, {}, new AbortController().signal)

    expect(result).toMatchObject({ status: 'failed', error: { code: 'python/project-unavailable' }, retryable: false })
  })

  it('reports a definition the project store cannot read', async () => {
    const harness = await stubHarness()
    const prepare = pythonNode('prepare', PREPARE_SOURCE)
    const { runId } = await startedRun(harness, prepare)
    const activation = await activationFor(harness, runId, prepare)
    await harness.store.removeProject(harness.projectId)

    const result = await harness.executor.execute(activation, {}, new AbortController().signal)

    expect(result).toMatchObject({ status: 'failed', error: { code: 'python/definition-unavailable' }, retryable: false })
  })
})

describe('registration lifetime', () => {
  it('unregisters the python kind when the plugin is disposed and registers again on remount', async () => {
    const harness = await stubHarness()
    const prepare = pythonNode('prepare', PREPARE_SOURCE)
    const { runId } = await startedRun(harness, prepare)
    await harness.disposeExecutor()

    const withoutExecutor = await harness.scheduler.tick({ projectId: harness.projectId, runId })
    expect(withoutExecutor.diagnostics.map(diagnostic => diagnostic.code)).toContain('scheduler/executor-missing')

    await harness.ctx.plugin(PythonExecutor)
    const { runId: secondRun } = await startedRun(harness, pythonNode('prepare', PREPARE_SOURCE))
    const failedAgain = await harness.scheduler.tick({ projectId: harness.projectId, runId: secondRun })

    expect(failedAgain.dispatched).toBe(1)
    expect(failedAgain.status).toBe('succeeded')
  })
})
