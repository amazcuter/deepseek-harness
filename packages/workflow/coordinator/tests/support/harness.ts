/**
 * Shared fixtures for the coordinator suites: one temporary home with a project
 * store, a scheduler, the agent executor, the coordinator, a JSONL session
 * backend, and a production Agent loop, plus definition builders and a scripted
 * LLM transport.
 *
 * The composition mirrors the app bundle's ordering — persistence and the loop
 * first, then the store and scheduler, then the executor and coordinator — so a
 * test drives the same wiring the product ships.
 *
 * @module @metaworkflow/workflow-coordinator/tests/support/harness
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@metaworkflow/agent'
import AgentLoop from '@metaworkflow/agent-loop'
import AgentDefaultModelConfig from '@metaworkflow/agent-default-model'
import { mountAgentLoopTestDependencies } from '@metaworkflow/agent-loop-testkit'
import * as JsonlSessionPersistence from '@metaworkflow/session-persistence-jsonl'
import type {} from '@metaworkflow/session-persistence'
import { serializeDefinition } from '@metaworkflow/workflow-definition'
import type { WorkflowDefinition, WorkflowNode } from '@metaworkflow/workflow-definition'
import ProjectStore from '@metaworkflow/workflow-project-store'
import type { ProjectId, ProjectRecord, RunId } from '@metaworkflow/workflow-project-store'
import Scheduler from '@metaworkflow/workflow-scheduler'
import type { TickResult } from '@metaworkflow/workflow-scheduler'
import AgentExecutor from '@metaworkflow/workflow-agent-executor'
import Coordinator from '../../src/index.ts'
import type { DecisionAnsweredInfo } from '../../src/index.ts'
import { ScriptedAdapter } from './mock-adapter.ts'
import type { ScriptEntry } from './mock-adapter.ts'

/** The provider route every suite registers its scripted adapter under. */
export const PROVIDER = 'scripted'

/** The model id every suite selects. */
export const MODEL = 'scripted-model'

/** One mounted composition and the temporary home behind it. */
export interface Harness {
  readonly ctx: Context
  readonly store: ProjectStore
  readonly scheduler: Scheduler
  /** The live coordinator service; a remount replaces it. */
  readonly coordinator: Coordinator
  readonly project: ProjectRecord
  readonly projectId: ProjectId
  /** Scripted transport every Agent of this composition uses. */
  readonly adapter: ScriptedAdapter
  /** Decision requests the executor announced, in emission order. */
  readonly requested: {
    readonly requestId: string
    readonly nodeId: string
    readonly runId: RunId
  }[]
  /** Answers the coordinator announced, in emission order. */
  readonly answered: DecisionAnsweredInfo[]
  /** Store one definition document and return the revision it was stored under. */
  define(definition: WorkflowDefinition): Promise<number>
  /** Start one run of a stored revision. */
  start(revision: number): Promise<RunId>
  /** Drive one run until it settles or nothing else can start. */
  tick(runId: RunId): Promise<TickResult>
  /** The live coordinator Agent of this project, opening its Session first. */
  coordinatorAgent(): Promise<Agent>
  /** Dispose only the coordinator plugin, leaving the composition mounted. */
  disposeCoordinator(): Promise<void>
  /** Mount a fresh coordinator plugin over the same project store and loop. */
  remountCoordinator(): Promise<void>
  close(): Promise<void>
}

/** A real model route one composition mounts instead of the scripted transport. */
export interface RealProvider {
  /** Registered provider route. */
  readonly provider: string
  /** Provider-owned model id. */
  readonly model: string
  /**
   * Mount the provider's plugin.
   * @param ctx - composition context that owns the plugin.
   * @returns after the provider registered its adapter.
   */
  mount(ctx: Context): Promise<void>
}

/** Options one mount accepts. */
export interface MountOptions {
  /** Responses the scripted transport serves. */
  readonly script?: readonly ScriptEntry[]
  /** Reasoning effort the deployment default model selects. */
  readonly reasoningEffort?: string
  /** Real provider to mount instead of the scripted transport. */
  readonly provider?: RealProvider
}

/**
 * Mount one composition over a fresh temporary home.
 * @param options - the LLM script.
 * @returns the mounted harness.
 */
export async function mount(options: MountOptions = {}): Promise<Harness> {
  const home = await mkdtemp(join(tmpdir(), 'mwf-coordinator-'))
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(JsonlSessionPersistence, { root: join(home, 'sessions') })
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(AgentDefaultModelConfig, {
    provider: options.provider?.provider ?? PROVIDER,
    model: options.provider?.model ?? MODEL,
    ...options.reasoningEffort === undefined ? {} : { reasoningEffort: options.reasoningEffort },
  })
  const adapter = new ScriptedAdapter(
    [...(options.script ?? [])],
    options.reasoningEffort === undefined ? [] : [options.reasoningEffort],
  )
  if (options.provider === undefined) ctx.llm.registerAdapter([PROVIDER], adapter)
  else await options.provider.mount(ctx)
  await ctx.plugin(ProjectStore, { mwfHome: home })
  await ctx.plugin(Scheduler, {})
  await ctx.plugin(AgentExecutor, {})
  let coordinatorFiber = await ctx.plugin(Coordinator)
  const store = ctx.mwfProjectStore
  const project = await store.createProject({ title: 'coordinator suite' })
  const requested: Harness['requested'][number][] = []
  const answered: DecisionAnsweredInfo[] = []
  ctx.on('workflow/decision-requested', (info) => {
    requested.push({ requestId: info.requestId, nodeId: info.nodeId, runId: info.runId })
  })
  ctx.on('workflow/decision-answered', (info) => {
    answered.push(info)
  })
  return {
    ctx,
    store,
    scheduler: ctx.mwfScheduler,
    get coordinator() {
      return ctx.mwfCoordinator
    },
    project,
    projectId: project.id,
    adapter,
    requested,
    answered,
    async define(definition) {
      return await store.writeDefinition(project.id, serializeDefinition(definition))
    },
    async start(revision) {
      return (await ctx.mwfScheduler.createRun({ projectId: project.id, definitionRevision: revision })).runId
    },
    async tick(runId) {
      return await ctx.mwfScheduler.tick({ projectId: project.id, runId })
    },
    async coordinatorAgent() {
      const sessionId = await ctx.mwfCoordinator.ensureSession(project.id)
      const agent = ctx.agents.get(sessionId)
      if (agent === undefined) throw new Error(`coordinator session "${sessionId}" has no live agent`)
      return agent
    },
    async disposeCoordinator() {
      await coordinatorFiber.dispose()
    },
    async remountCoordinator() {
      coordinatorFiber = await ctx.plugin(Coordinator)
    },
    async close() {
      await coordinatorFiber.dispose()
      await ctx.fiber.dispose()
      await rm(home, { recursive: true, force: true })
    },
  }
}

/**
 * One agent node that reports a structured result.
 * @param id - node id.
 * @param instructions - the node's persona.
 * @returns the node.
 */
export function agentNode(id: string, instructions = `Complete node ${id} and report the result.`): WorkflowNode {
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
      instructions,
      tools: [],
      memory: 'fresh',
    },
    inputs: [],
    join: 'all',
  }
}

/**
 * Build one definition document.
 * @param nodes - executable nodes in document order.
 * @param edges - directed edges; omitted for a single-node run.
 * @returns the definition.
 */
export function definition(
  nodes: readonly WorkflowNode[],
  edges: WorkflowDefinition['edges'] = [],
): WorkflowDefinition {
  return { version: 1, nodes, edges }
}

/**
 * The coordinator session one project recorded.
 * @param harness - mounted composition holding the project.
 * @returns the recorded session id, or `undefined` when none was recorded.
 */
export async function recordedCoordinatorSession(harness: Harness): Promise<string | undefined> {
  return await harness.store.transact(harness.projectId, (db) => {
    const row = db.prepare("SELECT value FROM schema_meta WHERE key = 'coordinator/session'").get() as
      | { value: string }
      | undefined
    return row?.value
  })
}
