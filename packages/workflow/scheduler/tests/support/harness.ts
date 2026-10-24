/**
 * Shared fixtures: a temporary harness that owns one project store and one
 * scheduler, definition builders that produce documents the validator accepts,
 * and fake executors that report exactly what a case needs.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { serializeDefinition } from '@metaworkflow/workflow-definition'
import type { InputBinding, Predicate, WorkflowDefinition, WorkflowEdge, WorkflowNode } from '@metaworkflow/workflow-definition'
import ProjectStore from '@metaworkflow/workflow-project-store'
import type { ProjectId, ProjectRecord, RunId } from '@metaworkflow/workflow-project-store'
import Scheduler from '../../src/index.ts'
import type { Config, NodeActivation, NodeExecutor, NodeInputs, NodeResult, RunParams } from '../../src/index.ts'

/** One mounted harness and the temporary home behind it. */
export interface Harness {
  readonly ctx: Context
  readonly store: ProjectStore
  readonly scheduler: Scheduler
  readonly project: ProjectRecord
  readonly projectId: ProjectId
  /** Dispose only the scheduler plugin, leaving the project store open. */
  disposeScheduler(): Promise<void>
  close(): Promise<void>
}

/**
 * Mount one project store and one scheduler over a fresh temporary home.
 * @param config - scheduler configuration; omitted uses the plugin defaults.
 * @returns the mounted harness.
 */
export async function harness(config?: Config): Promise<Harness> {
  const home = await mkdtemp(join(tmpdir(), 'mwf-scheduler-'))
  const ctx = new Context()
  await ctx.plugin(ProjectStore, { mwfHome: home })
  const schedulerFiber = await ctx.plugin(Scheduler, config ?? {})
  const store = ctx.mwfProjectStore
  const project = await store.createProject({ title: 'scheduler suite' })
  return {
    ctx,
    store,
    scheduler: ctx.mwfScheduler,
    project,
    projectId: project.id,
    async disposeScheduler() {
      await schedulerFiber.dispose()
    },
    async close() {
      await ctx.fiber.dispose()
      await rm(home, { recursive: true, force: true })
    },
  }
}

/**
 * Store one definition document and return its revision.
 * @param harness - mounted harness whose project receives the document.
 * @param definition - definition to store.
 * @returns the revision number the document was stored under.
 */
export async function define(harness: Harness, definition: WorkflowDefinition): Promise<number> {
  return harness.store.writeDefinition(harness.projectId, serializeDefinition(definition))
}

/**
 * One python node whose source the validator accepts; the fake executor never
 * runs it.
 * @param id - node id.
 * @param extra - optional inputs and join policy.
 * @returns the node.
 */
export function pythonNode(
  id: string,
  extra: { readonly inputs?: readonly InputBinding[]; readonly join?: 'all' | 'first-success' } = {},
): WorkflowNode {
  return {
    id,
    kind: 'python',
    title: id,
    config: { kind: 'python', source: `def nodemain_${id}(inputs):\n    return '{}'` },
    inputs: extra.inputs ?? [],
    join: extra.join ?? 'all',
  }
}

/**
 * One agent node whose configuration the validator accepts; the fake executor
 * never runs a model.
 * @param id - node id.
 * @param extra - optional inputs and join policy.
 * @returns the node.
 */
export function agentNode(
  id: string,
  extra: { readonly inputs?: readonly InputBinding[]; readonly join?: 'all' | 'first-success' } = {},
): WorkflowNode {
  return {
    id,
    kind: 'agent',
    title: id,
    config: {
      kind: 'agent',
      outputSchema: {
        type: 'object',
        properties: { answer: { type: 'string' } },
        required: ['answer'],
        additionalProperties: false,
      },
      instructions: `Answer node ${id}.`,
      tools: [],
      memory: 'fresh',
    },
    inputs: extra.inputs ?? [],
    join: extra.join ?? 'all',
  }
}

/**
 * One forward edge.
 * @param from - source node id.
 * @param to - target node id.
 * @param extra - optional id, condition, mode, and fallback flag.
 * @returns the edge.
 */
export function edge(
  from: string,
  to: string,
  extra: {
    readonly id?: string
    readonly condition?: Predicate | null
    readonly mode?: 'exclusive' | 'multiple'
    readonly fallback?: boolean
  } = {},
): WorkflowEdge {
  return {
    id: extra.id ?? `${from}-${to}`,
    from,
    to,
    condition: extra.condition ?? null,
    mode: extra.mode ?? 'multiple',
    ...(extra.fallback === undefined ? {} : { fallback: extra.fallback }),
  }
}

/**
 * One loop edge that re-enters an ancestor.
 * @param from - source node id.
 * @param to - target node id.
 * @param maxIterations - bound on re-entries.
 * @param extra - optional id and condition.
 * @returns the edge.
 */
export function loopEdge(
  from: string,
  to: string,
  maxIterations: number,
  extra: { readonly id?: string; readonly condition?: Predicate | null } = {},
): WorkflowEdge {
  return {
    id: extra.id ?? `${from}-${to}-loop`,
    from,
    to,
    condition: extra.condition ?? null,
    mode: 'multiple',
    loop: { maxIterations },
  }
}

/**
 * Assemble one definition document.
 * @param nodes - executable nodes.
 * @param edges - directed edges.
 * @returns the definition.
 */
export function definition(
  nodes: readonly WorkflowNode[],
  edges: readonly WorkflowEdge[],
): WorkflowDefinition {
  return { version: 1, nodes, edges }
}

/** One executor call the scheduler made. */
export interface ExecutorCall {
  readonly activation: NodeActivation
  readonly inputs: NodeInputs
  readonly signal: AbortSignal
}

/** A fake executor that records every call and answers through one handler. */
export class FakeExecutor implements NodeExecutor {
  readonly calls: ExecutorCall[] = []

  /**
   * @param kind - node kind this executor serves.
   * @param handler - answer for one call.
   */
  constructor(
    readonly kind: NodeExecutor['kind'],
    private readonly handler: (call: ExecutorCall) => NodeResult | Promise<NodeResult>,
  ) {}

  /**
   * Record one call and answer it.
   * @param activation - the node execution.
   * @param inputs - its assembled inputs.
   * @param signal - cancellation signal.
   * @returns the handler's answer.
   */
  async execute(activation: NodeActivation, inputs: NodeInputs, signal: AbortSignal): Promise<NodeResult> {
    const call: ExecutorCall = { activation, inputs, signal }
    this.calls.push(call)
    return this.handler(call)
  }
}

/** A promise a test settles by hand. */
export interface Deferred<T> {
  readonly promise: Promise<T>
  readonly resolve: (value: T) => void
  readonly reject: (error: unknown) => void
}

/**
 * Create a promise the caller settles.
 * @returns the promise and its settlement functions.
 */
export function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => {}
  let reject: (error: unknown) => void = () => {}
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

/**
 * Start one run and return its id.
 * @param harness - mounted harness.
 * @param revision - definition revision the run executes.
 * @param params - optional run parameters.
 * @returns the run id.
 */
export async function startRun(
  harness: Harness,
  revision: number,
  params?: RunParams,
): Promise<RunId> {
  const { runId } = await harness.scheduler.createRun({
    projectId: harness.projectId,
    definitionRevision: revision,
    ...(params === undefined ? {} : { params }),
  })
  return runId
}
