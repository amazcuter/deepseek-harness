/**
 * Shared fixtures: one temporary home with a project store, a scheduler, a
 * python runner, and the python executor mounted on it, plus definition
 * builders, a scripted runner stand-in, and the interpreter this host can run.
 *
 * Interpreter detection is synchronous so a suite can decide between
 * `describe` and `describe.skipIf` at collection time. It picks the launcher
 * the runner's probe tier picks — `py -3` or `python` on Windows, `python3`
 * elsewhere — and skips suites on a host without one instead of failing.
 */

import { spawnSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import { serializeDefinition } from '@metaworkflow/workflow-definition'
import type { InputBinding, Predicate, WorkflowDefinition, WorkflowEdge, WorkflowNode } from '@metaworkflow/workflow-definition'
import ProjectStore from '@metaworkflow/workflow-project-store'
import type { ProjectId, ProjectRecord, RunId } from '@metaworkflow/workflow-project-store'
import PythonRunner from '@metaworkflow/workflow-python-runner'
import type { RunNodeRequest, RunNodeResult } from '@metaworkflow/workflow-python-runner'
import { interpreterCandidates } from '@metaworkflow/workflow-python-runner/src/interpreter.ts'
import Scheduler from '@metaworkflow/workflow-scheduler'
import type { Config as SchedulerConfig, NodeActivation, RunParams } from '@metaworkflow/workflow-scheduler'
import PythonExecutor from '../../src/index.ts'
import type { Config } from '../../src/index.ts'

/** One launcher this host can drive. */
export interface HostPython {
  /** Launcher name, such as `py` or `python3`. */
  readonly command: string
  /** Leading launcher arguments, such as the Windows launcher's `-3`. */
  readonly args: readonly string[]
  /** Absolute path the launcher reported for itself. */
  readonly executable: string
}

/** Program that prints the interpreter's own path on a supported, GIL-enabled build. */
const DETECT_PROGRAM = 'import sys, sysconfig\nif not sysconfig.get_config_var("Py_GIL_DISABLED") and sys.version_info[:2] >= (3, 10):\n    sys.stdout.write(sys.executable + "\\n")\n'

/**
 * Find one interpreter this host can run.
 * @returns the launcher and its executable, or `undefined` when no candidate qualifies.
 */
function detectHostPython(): HostPython | undefined {
  for (const candidate of interpreterCandidates(process.platform)) {
    const result = spawnSync(candidate.command, [...candidate.args, '-X', 'utf8', '-c', DETECT_PROGRAM], {
      encoding: 'utf8',
      timeout: 15_000,
    })
    if (result.status !== 0) continue
    const executable = result.stdout.trim().split('\n').at(-1)
    if (executable !== undefined && executable.length > 0) return { ...candidate, executable }
  }
  return undefined
}

/**
 * Interpreter the real-process suites run against.
 *
 * `undefined` on a host without a supported launcher; those suites then skip
 * with a named reason instead of failing.
 */
export const hostPython = detectHostPython()

/** Why a python-spawning suite is skipped on this host. */
export const PYTHON_SKIP_REASON = 'no supported GIL-enabled Python 3 launcher (py -3, python, or python3) resolves on this host, so real-child-process behavior cannot be exercised'

/** The facts a helper reads from any mounted composition. */
export interface Mounted {
  readonly store: ProjectStore
  readonly scheduler: Scheduler
  readonly projectId: ProjectId
}

/** One mounted composition and the temporary home behind it. */
export interface Harness<R extends PythonRunner | StubPythonRunner = PythonRunner> extends Mounted {
  readonly ctx: Context
  readonly executor: PythonExecutor
  readonly project: ProjectRecord
  /** Mounted python runner. */
  readonly runner: R
  /** Dispose only the python executor plugin, leaving the rest mounted. */
  disposeExecutor(): Promise<void>
  close(): Promise<void>
}

/** One mounted composition whose runner is the scripted stand-in. */
export type StubHarness = Harness<StubPythonRunner>

/**
 * A scripted stand-in for `ctx.mwfPythonRunner`: it never spawns a process, so
 * a case can exercise the executor's outcome mapping exactly.
 */
export class StubPythonRunner extends Service {
  /** Requests one run received, in call order. */
  readonly runs: RunNodeRequest[] = []
  /** Project directories whose environment was requested. */
  readonly environments: string[] = []
  /** Result the next run resolves with. */
  result: RunNodeResult = { ok: true, value: null, stdout: '', stderr: '', exitCode: 0, durationMs: 1, timedOut: false }
  /** Error the next run rejects with, when one is scripted. */
  runError: unknown
  /** Error environment preparation rejects with, when one is scripted. */
  environmentError: Error | undefined
  /** Hook run at the start of one run, before the scripted outcome settles. */
  beforeRun: ((request: RunNodeRequest) => void) | undefined

  /**
   * @param ctx - plugin context that owns the service.
   */
  constructor(ctx: Context) {
    super(ctx, 'mwfPythonRunner')
  }

  /**
   * Record one environment request.
   * @param projectDir - project directory that owns the environment.
   * @returns the interpreter path the request resolved to.
   */
  async ensureVenv(projectDir: string): Promise<string> {
    this.environments.push(projectDir)
    if (this.environmentError !== undefined) throw this.environmentError
    return join(projectDir, '.venv', 'python')
  }

  /**
   * Record one run request and answer it with the scripted outcome.
   * @param request - the run request.
   * @returns the scripted result.
   */
  async runNode(request: RunNodeRequest): Promise<RunNodeResult> {
    this.runs.push(request)
    this.beforeRun?.(request)
    if (this.runError !== undefined) throw this.runError
    return this.result
  }
}

/** Options one mount accepts. */
export interface MountOptions {
  /** Executor configuration. */
  readonly config?: Config
  /** Scheduler configuration. */
  readonly schedulerConfig?: SchedulerConfig
}

/**
 * Mount one project store, scheduler, python runner, and python executor over a
 * fresh temporary home.
 * @param options - plugin configuration.
 * @returns the mounted harness.
 */
export async function mount(options: MountOptions = {}): Promise<Harness> {
  return await mountWith(ctx => new PythonRunner(ctx), options)
}

/**
 * Mount the same composition over the scripted runner stand-in.
 * @param options - executor configuration.
 * @returns the mounted harness whose `runner` records every request.
 */
export async function mountStub(options: Omit<MountOptions, 'schedulerConfig'> = {}): Promise<StubHarness> {
  return await mountWith(ctx => new StubPythonRunner(ctx), options)
}

/**
 * Mount one composition around a runner the caller constructs.
 * @param createRunner - builds the runner the executor injects.
 * @param options - plugin configuration.
 * @returns the mounted harness.
 */
async function mountWith<R extends PythonRunner | StubPythonRunner>(
  createRunner: (ctx: Context) => R,
  options: MountOptions,
): Promise<Harness<R>> {
  const home = await mkdtemp(join(tmpdir(), 'mwf-python-executor-'))
  const ctx = new Context()
  await ctx.plugin(ProjectStore, { mwfHome: home })
  await ctx.plugin(Scheduler, options.schedulerConfig ?? {})
  const runner = createRunner(ctx)
  const executorFiber = await ctx.plugin(PythonExecutor, options.config ?? {})
  const store = ctx.mwfProjectStore
  const project = await store.createProject({ title: 'python executor suite' })
  return {
    ctx,
    store,
    scheduler: ctx.mwfScheduler,
    executor: ctx.mwfPythonExecutor,
    project,
    projectId: project.id,
    runner,
    async disposeExecutor() {
      await executorFiber.dispose()
    },
    async close() {
      await executorFiber.dispose()
      await ctx.fiber.dispose()
      await rm(home, { recursive: true, force: true })
    },
  }
}

/**
 * Build one definition document.
 * @param nodes - executable nodes in document order.
 * @param edges - directed edges in document order.
 * @returns the definition.
 */
export function definition(nodes: readonly WorkflowNode[], edges: readonly WorkflowEdge[]): WorkflowDefinition {
  return { version: 1, nodes, edges }
}

/**
 * Store one definition document and return its revision.
 * @param harness - mounted composition whose project receives the document.
 * @param definition - definition to store.
 * @returns the revision number the document was stored under.
 */
export async function define(harness: Mounted, definition: WorkflowDefinition): Promise<number> {
  return harness.store.writeDefinition(harness.projectId, serializeDefinition(definition))
}

/**
 * One python node.
 * @param id - node id.
 * @param source - complete Python module source.
 * @param extra - optional inputs and join policy.
 * @returns the node.
 */
export function pythonNode(
  id: string,
  source: string,
  extra: { readonly inputs?: readonly InputBinding[]; readonly join?: 'all' | 'first-success' } = {},
): WorkflowNode {
  return {
    id,
    kind: 'python',
    title: id,
    config: { kind: 'python', source: source.length === 0 ? `def nodemain_${id}(inputs):\n    return 'null'` : source },
    inputs: extra.inputs ?? [],
    join: extra.join ?? 'all',
  }
}

/**
 * One directed edge.
 * @param from - source node id.
 * @param to - target node id.
 * @param extra - optional id, condition, mode, fallback flag, and loop bound.
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
    readonly maxIterations?: number
  } = {},
): WorkflowEdge {
  return {
    id: extra.id ?? `${from}-${to}`,
    from,
    to,
    condition: extra.condition ?? null,
    mode: extra.mode ?? 'multiple',
    ...(extra.fallback === undefined ? {} : { fallback: extra.fallback }),
    ...(extra.maxIterations === undefined ? {} : { loop: { maxIterations: extra.maxIterations } }),
  }
}

/**
 * Build the activation one node execution receives, from the facts the
 * scheduler recorded for a run.
 * @param harness - mounted composition holding the run.
 * @param runId - run whose revision, params, and activation are read.
 * @param node - definition node to execute.
 * @param params - run parameters the activation reports.
 * @returns the activation the executor receives.
 */
export async function activationFor(
  harness: Mounted,
  runId: RunId,
  node: WorkflowNode,
  params: RunParams = {},
): Promise<NodeActivation> {
  const run = await harness.scheduler.getRun({ projectId: harness.projectId, runId })
  if (run === undefined) throw new Error(`run "${runId}" is not recorded`)
  const activations = await harness.scheduler.listActivations({ projectId: harness.projectId, runId })
  const activation = activations.find(candidate => candidate.nodeId === node.id)
  if (activation === undefined) throw new Error(`run "${runId}" has no activation of node "${node.id}"`)
  return {
    runId,
    activationId: activation.activationId,
    node,
    projectId: harness.projectId,
    definitionRevision: run.definitionRevision,
    iteration: activation.iteration,
    attemptNo: 1,
    params,
  }
}

/**
 * Wait until one predicate holds.
 * @param predicate - condition to poll.
 * @param timeoutMs - deadline for the condition, in milliseconds.
 * @returns nothing; rejects when the deadline expires.
 */
export async function waitFor(predicate: () => Promise<boolean> | boolean, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await predicate()) return
    if (Date.now() > deadline) throw new Error(`condition did not hold within ${String(timeoutMs)} ms`)
    await new Promise(resolve => setTimeout(resolve, 25))
  }
}
