/**
 * Shared fixtures: one temporary home with a project store, a scheduler, a JSONL
 * session backend, a production Agent loop, and the agent executor mounted over
 * them, plus definition builders and scheduler helpers.
 *
 * The composition mirrors the app bundle's ordering — persistence and the loop
 * before the executor — because the executor resumes retained sessions from the
 * durable backend and composes real child Agents.
 *
 * @module @metaworkflow/workflow-agent-executor/tests/support/harness
 */

import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@metaworkflow/agent-loop'
import AgentDefaultModelConfig from '@metaworkflow/agent-default-model'
import { mountAgentLoopTestDependencies } from '@metaworkflow/agent-loop-testkit'
import { brandString } from '@metaworkflow/brand'
import { SessionId } from '@metaworkflow/session'
import type { SessionEvent } from '@metaworkflow/session'
import * as JsonlSessionPersistence from '@metaworkflow/session-persistence-jsonl'
import type {} from '@metaworkflow/session-persistence'
import { parseDefinitionDocument, serializeDefinition } from '@metaworkflow/workflow-definition'
import type { JsonSchemaNode } from '@metaworkflow/tools'
import type { AgentNodeConfig, InputBinding, WorkflowDefinition, WorkflowNode } from '@metaworkflow/workflow-definition'
import ProjectStore from '@metaworkflow/workflow-project-store'
import type { AttemptId, ProjectId, ProjectRecord, RunId } from '@metaworkflow/workflow-project-store'
import Scheduler from '@metaworkflow/workflow-scheduler'
import type { NodeActivation, TickResult } from '@metaworkflow/workflow-scheduler'
import AgentExecutor from '../../src/index.ts'
import type { Config } from '../../src/index.ts'
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
  readonly executor: AgentExecutor
  readonly project: ProjectRecord
  readonly projectId: ProjectId
  /** Scripted transport every child Agent of this composition uses. */
  readonly adapter: ScriptedAdapter
  /** Store one definition document and return the revision it was stored under. */
  define(definition: WorkflowDefinition): Promise<number>
  /** Start one run of a stored revision. */
  start(revision: number): Promise<RunId>
  /** Drive one run until it settles or nothing else can start. */
  tick(runId: RunId): Promise<TickResult>
  /** Absolute path of the project database behind this composition. */
  readonly databasePath: string
  /** Dispose only the executor plugin, leaving the composition mounted. */
  disposeExecutor(): Promise<void>
  /** Dispose the Agent loop, leaving the rest of the composition mounted. */
  disposeLoop(): Promise<void>
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
  /** Executor configuration. */
  readonly config?: Config
  /** Reasoning effort the deployment default model selects, when one is selected. */
  readonly reasoningEffort?: string
  /** Real provider to mount instead of the scripted transport. */
  readonly provider?: RealProvider
}

/**
 * Mount one composition over a fresh temporary home.
 * @param options - the LLM script and executor configuration.
 * @returns the mounted harness.
 */
export async function mount(options: MountOptions = {}): Promise<Harness> {
  const home = await mkdtemp(join(tmpdir(), 'mwf-agent-executor-'))
  const sessionsRoot = join(home, 'sessions')
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(JsonlSessionPersistence, { root: sessionsRoot })
  const loopFiber = await ctx.plugin(AgentLoop, { agents: [] })
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
  const executorFiber = await ctx.plugin(AgentExecutor, options.config ?? {})
  const store = ctx.mwfProjectStore
  const project = await store.createProject({ title: 'agent executor suite' })
  return {
    ctx,
    store,
    scheduler: ctx.mwfScheduler,
    executor: ctx.mwfAgentExecutor,
    project,
    projectId: project.id,
    adapter,
    async define(definition) {
      return await store.writeDefinition(project.id, serializeDefinition(definition))
    },
    async start(revision) {
      return (await ctx.mwfScheduler.createRun({ projectId: project.id, definitionRevision: revision })).runId
    },
    async tick(runId) {
      return await ctx.mwfScheduler.tick({ projectId: project.id, runId })
    },
    databasePath: join(home, 'mwf', 'projects', project.id, 'project.db'),
    async disposeExecutor() {
      await executorFiber.dispose()
    },
    async disposeLoop() {
      await loopFiber.dispose()
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
 * @param edges - directed edges in document order; omitted for a single-node run.
 * @returns the definition.
 */
export function definition(nodes: readonly WorkflowNode[], edges: WorkflowDefinition['edges'] = []): WorkflowDefinition {
  return { version: 1, nodes, edges }
}

/** Options one agent node builder accepts. */
export interface AgentNodeOptions {
  /** Task instructions; defaults to a stable sentence. */
  readonly instructions?: string
  /** Tool names the node may use; defaults to none. */
  readonly tools?: readonly string[]
  /** Memory policy; defaults to `fresh`. */
  readonly memory?: 'retained' | 'fresh'
  /** Output schema; defaults to one required string field `answer`. */
  readonly outputSchema?: AgentNodeConfig['outputSchema']
  /** Named inputs; defaults to none. */
  readonly inputs?: readonly InputBinding[]
}

/** The output schema most cases use. */
export const ANSWER_SCHEMA: JsonSchemaNode = {
  type: 'object',
  properties: { answer: { type: 'string' } },
  required: ['answer'],
  additionalProperties: false,
}

/**
 * One directed edge.
 * @param from - source node id.
 * @param to - target node id.
 * @param extra - optional condition and loop bound.
 * @returns the edge.
 */
export function edge(
  from: string,
  to: string,
  extra: { readonly id?: string; readonly condition?: WorkflowDefinition['edges'][number]['condition']; readonly loop?: number } = {},
): WorkflowDefinition['edges'][number] {
  return {
    id: extra.id ?? `${from}-${to}`,
    from,
    to,
    condition: extra.condition ?? null,
    mode: 'multiple',
    ...extra.loop === undefined ? {} : { loop: { maxIterations: extra.loop } },
  }
}

/**
 * One agent node.
 * @param id - node id.
 * @param options - instructions, tools, memory, schema, and inputs.
 * @returns the node.
 */
export function agentNode(id: string, options: AgentNodeOptions = {}): WorkflowNode {
  return {
    id,
    kind: 'agent',
    title: id,
    config: {
      kind: 'agent',
      outputSchema: options.outputSchema ?? ANSWER_SCHEMA,
      instructions: options.instructions ?? `Complete node ${id} and report the result.`,
      tools: options.tools ?? [],
      memory: options.memory ?? 'fresh',
    },
    inputs: options.inputs ?? [],
    join: 'all',
  }
}

/**
 * The activation one node execution receives, from the facts the scheduler
 * recorded for a run.
 * @param harness - mounted composition holding the run.
 * @param runId - run whose revision and activation are read.
 * @param nodeId - node to build the activation for.
 * @param attemptNo - attempt number the activation reports.
 * @returns the activation the executor receives.
 */
export async function activationFor(
  harness: Harness,
  runId: RunId,
  nodeId: string,
  attemptNo = 1,
): Promise<NodeActivation> {
  const run = await harness.scheduler.getRun({ projectId: harness.projectId, runId })
  if (run === undefined) throw new Error(`run "${runId}" is not recorded`)
  const record = await harness.store.readDefinition(harness.projectId, run.definitionRevision)
  if (record === undefined) throw new Error(`run "${runId}" has no stored revision`)
  const parsed = parseDefinitionDocument(record.document)
  if (!parsed.ok) throw new Error(`run "${runId}" stores a document that does not parse`)
  const node = parsed.definition.nodes.find(candidate => candidate.id === nodeId)
  if (node === undefined) throw new Error(`run "${runId}" declares no node "${nodeId}"`)
  const activations = await harness.scheduler.listActivations({ projectId: harness.projectId, runId })
  const activation = activations.find(candidate => candidate.nodeId === nodeId)
  if (activation === undefined) throw new Error(`run "${runId}" has no activation of node "${nodeId}"`)
  return {
    runId,
    activationId: activation.activationId,
    node,
    projectId: harness.projectId,
    definitionRevision: run.definitionRevision,
    iteration: activation.iteration,
    attemptNo,
    attemptId: brandString<AttemptId>(`attempt-${nodeId}-${String(attemptNo)}`),
    params: {},
  }
}

/**
 * The session id a retained node recorded in the project database.
 * @param harness - mounted composition holding the project.
 * @param runId - run whose mapping is read.
 * @param nodeId - node whose mapping is read.
 * @returns the recorded session id, or `undefined` when the node recorded none.
 */
export async function retainedSessionOf(
  harness: Harness,
  runId: RunId,
  nodeId: string,
): Promise<string | undefined> {
  return await harness.store.transact(harness.projectId, (db) => {
    const row = db.prepare("SELECT value FROM schema_meta WHERE key = 'agent-executor/node-sessions'").get() as
      | { value: string }
      | undefined
    if (row === undefined) return undefined
    const mapping = JSON.parse(row.value) as Record<string, string>
    return mapping[`${runId}/${nodeId}`]
  })
}

/**
 * Replace the retained-session row of one project with arbitrary text, so a
 * case can exercise a corrupted record.
 * @param harness - mounted composition holding the project.
 * @param value - raw JSON text to store; `null` deletes the row.
 * @returns nothing.
 */
export async function writeRetainedRow(harness: Harness, value: string | null): Promise<void> {
  await harness.store.transact(harness.projectId, (db) => {
    if (value === null) {
      db.prepare("DELETE FROM schema_meta WHERE key = 'agent-executor/node-sessions'").run()
      return
    }
    db.prepare("INSERT INTO schema_meta (key, value) VALUES ('agent-executor/node-sessions', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(value)
  })
}

/**
 * Run one statement batch against the project database through a second
 * connection, which is how a case reproduces media that a live store would
 * refuse to damage — a table dropped underneath the run.
 * @param harness - mounted composition holding the project.
 * @param statements - SQL to execute on the separate connection.
 * @returns nothing.
 */
export function corruptProjectDatabase(harness: Harness, statements: string): void {
  // Foreign keys stay off on this second connection: the point is to damage
  // media the store itself would refuse to damage.
  const db = new DatabaseSync(harness.databasePath, { enableForeignKeyConstraints: false })
  try {
    db.exec(statements)
  } finally {
    db.close()
  }
}

/**
 * Read one stored session's complete event log through a read handle.
 * @param harness - mounted composition that owns the session backend.
 * @param sessionId - session to read, as the model requests named it.
 * @returns every stored event in log order.
 */
export async function storedEvents(harness: Harness, sessionId: string): Promise<readonly SessionEvent[]> {
  const handle = await harness.ctx.sessionPersistence.open(SessionId(sessionId), 'read')
  try {
    return (await handle.read()).events
  } finally {
    await handle.close()
  }
}

/**
 * The model-facing text of every tool result one stored session recorded.
 * @param harness - mounted composition that owns the session backend.
 * @param sessionId - session to read.
 * @returns the rendered tool result texts in log order.
 */
export async function toolResultTexts(harness: Harness, sessionId: string): Promise<string[]> {
  return (await storedEvents(harness, sessionId)).flatMap(event => event.type === 'tool/result'
    ? event.data.message.content.flatMap(block => block.type === 'text' ? [block.text] : [])
    : [])
}

/**
 * Replace one stored definition revision's document, so a case can exercise a
 * revision whose stored content no longer matches what the run started from.
 * @param harness - mounted composition holding the project.
 * @param revision - revision to overwrite.
 * @param document - replacement document text.
 * @returns nothing.
 */
export async function overwriteDefinition(harness: Harness, revision: number, document: string): Promise<void> {
  await harness.store.transact(harness.projectId, (db) => {
    db.prepare('UPDATE definitions SET document = ? WHERE revision = ?').run(document, revision)
  })
}

/**
 * Rebuild the compatibility table so a retained-session write fails while a read
 * still succeeds, so a case can exercise a project database that cannot record
 * the mapping.
 * @param harness - mounted composition holding the project.
 * @returns nothing.
 */
export async function rejectRetainedWrites(harness: Harness): Promise<void> {
  await harness.store.transact(harness.projectId, (db) => {
    db.exec('DROP TABLE schema_meta')
    db.exec('CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL CHECK (length(value) = 0)) STRICT')
  })
}

/**
 * A session identity no attempt ever created.
 * @returns the unused identity.
 */
export function unusedSessionId(): SessionId {
  return SessionId(`session-${randomUUID()}`)
}

/**
 * Every tool name one recorded model request offered the model.
 * @param request - the request to inspect.
 * @returns the tool names in request order.
 */
export function toolNames(request: { readonly tools?: readonly { readonly name: string }[] }): string[] {
  return (request.tools ?? []).map(tool => tool.name)
}

/** One message of a recorded model request, reduced to what the assertions read. */
export interface RecordedMessage {
  readonly role: string
  readonly content: readonly { readonly type: string; readonly text?: string }[]
}

/** One recorded model request, reduced to what the assertions read. */
export interface RecordedRequest {
  readonly messages: readonly RecordedMessage[]
}

/**
 * The system prompt text one recorded model request carried.
 * @param request - the request to inspect.
 * @returns the leading system-role text, or the empty string.
 */
export function systemText(request: RecordedRequest): string {
  const head = request.messages[0]
  if (head?.role !== 'system') return ''
  return head.content.flatMap(block => block.type === 'text' ? [block.text ?? ''] : []).join('')
}
