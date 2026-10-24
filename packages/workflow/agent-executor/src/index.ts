/**
 * Agent node executor for the workflow scheduler (`ctx.mwfAgentExecutor`).
 *
 * The scheduler owns readiness, retries, concurrency, and persistence, and it
 * ships no node implementation. This plugin supplies the `agent` kind: one
 * ready activation becomes one DSH child Agent composed from the node's stored
 * configuration — its instructions, its tool allow list, its completion tool,
 * and its memory policy — and the node's result is whatever value that child
 * reports through the completion tool. Ordinary assistant text is never a
 * result.
 *
 * The executor owns no scheduling state: it reads the run's stored definition
 * revision and the project working directory, and reports one outcome. Every
 * durable fact about the attempt stays in the project database the scheduler
 * commits; the one exception is the retained-session mapping, which the
 * executor owns because it alone decides whether a node continues an earlier
 * conversation.
 *
 * @module @metaworkflow/workflow-agent-executor
 */

import { randomUUID } from 'node:crypto'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent, AgentHandle, AgentOptions } from '@metaworkflow/agent'
import { brandString } from '@metaworkflow/brand'
import { createUserMessage } from '@metaworkflow/llm'
import type { SessionId, TurnEndReason } from '@metaworkflow/session'
import { createCompleteNodeTool } from '@metaworkflow/tool-complete-node'
import { createRequestDecisionTool } from '@metaworkflow/tool-request-decision'
import type { DecisionRequest } from '@metaworkflow/tool-request-decision'
import type { JsonValue } from '@metaworkflow/util-values'
import { parseDefinitionDocument } from '@metaworkflow/workflow-definition'
import type { AgentNodeConfig } from '@metaworkflow/workflow-definition'
import type { NodeActivation, NodeExecutor, NodeInputs, NodeResult, RunView } from '@metaworkflow/workflow-scheduler'
import type { DefinitionRecord, ProjectRecord } from '@metaworkflow/workflow-project-store'
// Type-only: brings the scheduler, store, Agent registry, default-model, and
// coordinator services into the Context type the plugin injects and reads.
import type {} from '@metaworkflow/workflow-scheduler'
import type {} from '@metaworkflow/workflow-project-store'
import type {} from '@metaworkflow/workflow-coordinator'
import type {} from '@metaworkflow/agent-default-model'
import type {} from '@metaworkflow/session-persistence'
import { NodeSessionRegistry } from './node-sessions.ts'
import { retainedSessionKey, selectRetainedSessions, upsertRetainedSession } from './retained-sessions.ts'
import type { AgentExecutorErrorCode, Config, DecisionRequestedInfo } from './types.ts'

export type * from './types.ts'
export { NodeSessionRegistry } from './node-sessions.ts'
export { COMPLETION_INSTRUCTION, COMPLETION_TOOL_NAME } from '@metaworkflow/tool-complete-node'
export { DECISION_TOOL_DESCRIPTION, DECISION_TOOL_NAME } from '@metaworkflow/tool-request-decision'
export { RETAINED_SESSIONS_KEY } from './retained-sessions.ts'

/** The deadline one node turn gets when the plugin configuration omits one. */
export const DEFAULT_TURN_TIMEOUT_MS = 600_000

/** Schemastery validator for {@link Config}. */
export const ConfigSchema: z<Config> = z.object({
  turnTimeoutMs: z.natural(),
})

/**
 * One failure this executor reports, distinguished from an unexpected error so
 * the scheduler keeps the stable code and the retry verdict.
 */
class AgentExecutorError extends Error {
  override readonly name: string = 'AgentExecutorError'

  /** Stable code the scheduler records on the attempt. */
  readonly code: AgentExecutorErrorCode

  /** Whether another attempt of the same activation may still succeed. */
  readonly retryable: boolean

  /**
   * @param code - stable failure code.
   * @param message - actionable description naming the node, run, or session.
   * @param retryable - whether another attempt may succeed.
   * @param options - standard `Error` options, including the underlying `cause`.
   */
  constructor(code: AgentExecutorErrorCode, message: string, retryable: boolean, options?: ErrorOptions) {
    super(message, options)
    this.code = code
    this.retryable = retryable
  }
}

/**
 * One attempt's outcome cell, filled by the tools the child Agent composes: the
 * value a completion call accepted, or the decision request that suspended it.
 */
interface AttemptCell {
  /** The node result an accepted completion recorded. */
  value: JsonValue | undefined
  /** The request a `request_decision` call recorded, which makes the attempt wait. */
  requestId: string | undefined
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    mwfAgentExecutor: AgentExecutor
  }

  interface Events {
    /**
     * A workflow node asked its project coordinator for a decision, so its
     * activation is about to suspend. Paired with the coordinator's
     * `workflow/decision-answered` when the question is answered.
     * @param info - the asking attempt, its node, and the question.
     * @mode emit
     */
    'workflow/decision-requested'(info: DecisionRequestedInfo): void
  }
}

/**
 * Describe any thrown value for a failure message.
 * @param error - value a rejected call threw.
 * @returns the error's message, or the value rendered as text.
 */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * The session identity a new child Agent receives.
 * @returns a fresh, unbranded-then-branded session id shaped like every other entry point's.
 */
function newSessionId(): SessionId {
  return brandString<SessionId>(`session-${randomUUID()}`)
}

/**
 * The task message one activation sends to its child Agent.
 *
 * It names the durable facts the attempt already knows — the node, its
 * iteration, its attempt number — and carries the assembled input values as
 * JSON, so a resumed session's next turn is reconstructable from the log.
 * @param activation - the activation being executed.
 * @param inputs - the assembled input values, keyed by binding name.
 * @returns the user-role message text.
 */
function taskText(activation: NodeActivation, inputs: NodeInputs): string {
  // A resumed attempt carries the coordinator's answer as one more input, so the
  // model sees it in the same block as the values its bindings assembled.
  const rendered: NodeInputs = activation.decision === undefined
    ? inputs
    : { ...inputs, decision: activation.decision }
  return [
    `Workflow node ${JSON.stringify(activation.node.id)} — iteration ${String(activation.iteration)}, attempt ${String(activation.attemptNo)}.`,
    '',
    'Node inputs:',
    '```json',
    JSON.stringify(rendered, null, 2),
    '```',
  ].join('\n')
}

/**
 * Runs workflow agent nodes for the scheduler.
 *
 * One instance owns one executor registration for the `agent` kind, which is an
 * effect: disposing the plugin unregisters it, so a replaced plugin never leaves
 * a duplicate executor behind. It also owns `ctx.mwfNodeSessions`, the live
 * session-to-attempt registry, in the same scope.
 */
export default class AgentExecutor extends Service {
  static inject = [
    'mwfScheduler',
    'mwfProjectStore',
    'agents',
    'sessionPersistence',
    'systemPrompt',
    'tools',
    'agentDefaultModel',
  ]

  static Config: z<Config> = ConfigSchema

  /** The live child-Agent registry this executor owns. */
  readonly nodeSessions: NodeSessionRegistry

  private readonly turnTimeoutMs: number

  /**
   * @param ctx - plugin context that owns the service and the registration lifetime.
   * @param config - validated plugin configuration.
   */
  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'mwfAgentExecutor')
    this.turnTimeoutMs = config.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS
    this.nodeSessions = new NodeSessionRegistry(ctx)
    ctx.effect(() => this.ctx.mwfScheduler.registerExecutor(this.executor()), 'mwfAgentExecutor.register')
  }

  /**
   * Run one activation's agent node.
   *
   * The stored definition revision is authoritative: the executor builds the
   * child Agent from that revision's node configuration, never from the
   * scheduler-supplied copy, so a run executes the composition the project
   * stored.
   * @param activation - the node, its iteration and attempt number, and the run's parameters.
   * @param inputs - the assembled input values, keyed by binding name.
   * @param signal - aborted when the run is paused or canceled.
   * @returns the completed value, or a structured failure.
   * @throws the abort reason when `signal` aborted, because that outcome is not a node failure.
   */
  async execute(activation: NodeActivation, inputs: NodeInputs, signal: AbortSignal): Promise<NodeResult> {
    signal.throwIfAborted()
    let handle: AgentHandle | undefined
    let sessionId: SessionId | undefined
    try {
      const config = await this.storedConfig(activation)
      const project = await this.openProject(activation)
      const agentOptions = this.agentOptions()
      const retained = config.memory === 'retained'
      const resumed = retained ? await this.retainedSession(activation) : undefined
      // A resumed conversation keeps the lineage it was created with, so only a
      // fresh one asks the coordinator for its parent.
      const parentSession = resumed === undefined ? await this.coordinatorSession(activation) : undefined
      sessionId = resumed ?? newSessionId()
      this.nodeSessions.bind({
        sessionId,
        projectId: activation.projectId,
        runId: activation.runId,
        attemptId: activation.attemptId,
        nodeId: activation.node.id,
        revision: activation.definitionRevision,
      })
      const cell: AttemptCell = { value: undefined, requestId: undefined }
      const setup = (childCtx: Context): void => { this.composeChild(childCtx, activation, config, cell) }
      handle = await this.openChild({
        activation,
        project,
        agentOptions,
        setup,
        sessionId,
        resume: resumed !== undefined,
        parentSession,
        signal,
      })
      if (retained && resumed === undefined) await this.recordSession(activation, sessionId)
      return await this.drive(handle.agent, activation, inputs, cell, signal)
    } catch (error: unknown) {
      // An abort is not a node failure: the scheduler must see the attempt stop on purpose.
      if (signal.aborted) throw error
      /* v8 ignore else -- every failure this executor owns is an AgentExecutorError above */
      if (error instanceof AgentExecutorError) {
        return { status: 'failed', error: { code: error.code, message: error.message }, retryable: error.retryable }
      }
      /* v8 ignore next 5 -- a foreign rejection is still reportable, without a stable code of its own */
      return {
        status: 'failed',
        error: { code: 'agent/executor-failed', message: `the agent executor failed: ${describe(error)}` },
        retryable: false,
      }
    } finally {
      if (sessionId !== undefined) this.nodeSessions.forget(sessionId)
      await handle?.dispose()
    }
  }

  /**
   * The exported registration the scheduler dispatches `agent` activations to.
   * @returns the executor for one node kind.
   */
  private executor(): NodeExecutor {
    return { kind: 'agent', execute: async (activation, inputs, signal) => await this.execute(activation, inputs, signal) }
  }

  /**
   * Create or resume the child Agent one attempt runs.
   * @param options - the attempt's activation, project, model route, setup, identity, and cancellation.
   * @returns the owned Agent handle; disposing it ends the attempt.
   * @throws {@link AgentExecutorError} `agent/session-unavailable` when the Agent
   * cannot be created or resumed, and `agent/composition-failed` from setup.
   */
  private async openChild(options: {
    readonly activation: NodeActivation
    readonly project: ProjectRecord
    readonly agentOptions: AgentOptions
    readonly setup: (childCtx: Context) => void
    readonly sessionId: SessionId
    readonly resume: boolean
    readonly parentSession: SessionId | undefined
    readonly signal: AbortSignal
  }): Promise<AgentHandle> {
    const { activation, project, agentOptions, setup, sessionId, resume, parentSession, signal } = options
    try {
      return resume
        ? await this.ctx.agents.resume({ resumeSessionId: sessionId, agentOptions, signal, setup })
        : await this.ctx.agents.create({
          sessionId,
          meta: {
            cwd: project.path,
            ...parentSession === undefined ? {} : { parentSession },
          },
          agentOptions,
          signal,
          setup,
        })
    } catch (error: unknown) {
      if (error instanceof AgentExecutorError) throw error
      const operation = resume ? 'resume' : 'create'
      throw new AgentExecutorError(
        'agent/session-unavailable',
        `the agent executor could not ${operation} the session of node "${activation.node.id}": ${describe(error)}`,
        false,
        { cause: error },
      )
    }
  }

  /**
   * Compose the child Agent's scoped world from the node's stored configuration.
   *
   * The instruction section is the node's persona; the tool allow list selects
   * capabilities without inferring permissions; the completion tool and the
   * decision tool are always present, so no configuration can leave a node
   * unable to report a result or ask for a decision.
   * @param childCtx - the child Agent's scope context, during its creation window.
   * @param activation - the activation being executed.
   * @param config - the node's stored agent configuration.
   * @param cell - the attempt's outcome slot.
   * @returns nothing; every registration belongs to the child's scope.
   * @throws {@link AgentExecutorError} `agent/composition-failed` when the node
   * names a tool this deployment does not register.
   */
  private composeChild(
    childCtx: Context,
    activation: NodeActivation,
    config: AgentNodeConfig,
    cell: AttemptCell,
  ): void {
    childCtx.systemPrompt.section({
      name: 'workflow:node-instructions',
      order: childCtx.systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA_PREFIX'),
      text: config.instructions,
      // The stored instructions are the node's literal persona; deployment
      // prompt variables do not rewrite authored text.
      interpolate: false,
    })
    const completion = createCompleteNodeTool({
      outputSchema: config.outputSchema,
      // The sink closes over this activation's slot, so an accepted value can
      // only ever settle the attempt whose session the registry already mapped.
      onAccept: (value) => { cell.value = value },
    })
    completion.attach(childCtx)
    const decision = createRequestDecisionTool({
      // The sink closes over this attempt's identity, so the recorded request can
      // only ever name the attempt whose session the registry already mapped.
      onRequest: async (request) => {
        const requestId = await this.recordDecision(activation, request)
        cell.requestId = requestId
        return requestId
      },
    })
    decision.attach(childCtx)
    try {
      childCtx.tools.restrict({ allow: [...config.tools] })
    } catch (error: unknown) {
      throw new AgentExecutorError(
        'agent/composition-failed',
        `node "${activation.node.id}" declares a tool this deployment does not register: ${describe(error)}`,
        false,
        { cause: error },
      )
    }
  }

  /**
   * Send the activation's task and wait for the turn to settle.
   *
   * The turn ends in exactly one of four ways: the completion tool recorded a
   * value, the decision tool recorded a request, the loop ended the turn without
   * either, or the deadline expired. A value is a success, a request suspends the
   * attempt, and assistant text is neither.
   * @param agent - the live child Agent.
   * @param activation - the activation being executed.
   * @param inputs - the assembled input values.
   * @param cell - the attempt's outcome slot.
   * @param signal - aborted when the run is paused or canceled.
   * @returns the node's outcome.
   * @throws the abort reason when `signal` aborted while the turn ran.
   */
  private async drive(
    agent: Agent,
    activation: NodeActivation,
    inputs: NodeInputs,
    cell: AttemptCell,
    signal: AbortSignal,
  ): Promise<NodeResult> {
    let turnEnd: TurnEndReason | undefined
    // Agent-scoped dispatch delivers this Agent's own Session events, so concurrent
    // nodes never observe each other's turns.
    const stopTurnEnd = agent.ctx.on('session/event', (_session, event) => {
      if (event.type === 'turn/end') turnEnd = event.data.reason
    })
    const state: { timedOut: boolean } = { timedOut: false }
    const deadline = setTimeout(() => {
      state.timedOut = true
      agent.cancel({ kind: 'hook', reason: 'workflow node turn deadline expired' })
    }, this.turnTimeoutMs)
    const cancelTurn = (): void => { agent.cancel({ kind: 'user' }) }
    signal.addEventListener('abort', cancelTurn, { once: true })
    try {
      agent.followup(createUserMessage({
        content: [{ type: 'text', text: taskText(activation, inputs) }],
        source: { kind: 'user' },
      }))
      await agent.whenIdle()
    } finally {
      clearTimeout(deadline)
      signal.removeEventListener('abort', cancelTurn)
      stopTurnEnd()
    }
    if (state.timedOut) {
      return {
        status: 'failed',
        error: {
          code: 'agent/timeout',
          message: `node "${activation.node.id}" did not report a result within ${String(this.turnTimeoutMs)} ms`,
        },
        retryable: true,
      }
    }
    if (cell.value !== undefined) return { status: 'succeeded', value: cell.value }
    // A recorded request is a suspension, not a failure: the scheduler releases
    // the slot and answers wake the activation through `resumeActivation`.
    if (cell.requestId !== undefined) return { status: 'waiting', requestId: cell.requestId }
    signal.throwIfAborted()
    return this.turnFailure(activation, turnEnd)
  }

  /**
   * The failure one turn ended with when it recorded no value.
   * @param activation - the activation being executed.
   * @param turnEnd - the turn's recorded reason, or `undefined` when it never reported one.
   * @returns the structured failure; a missing completion is retryable because a
   * second attempt starts a fresh turn.
   */
  private turnFailure(activation: NodeActivation, turnEnd: TurnEndReason | undefined): NodeResult {
    const missing = (reason: string): NodeResult => ({
      status: 'failed',
      error: {
        code: 'agent/completion-missing',
        message: `node "${activation.node.id}" ${reason} without reporting a result through the completion tool`,
      },
      retryable: true,
    })
    switch (turnEnd?.kind) {
      case 'error':
        return {
          status: 'failed',
          error: { code: 'agent/turn-failed', message: `node "${activation.node.id}" failed: ${turnEnd.error.message}` },
          retryable: true,
        }
      case 'max-tokens':
        return {
          status: 'failed',
          error: {
            code: 'agent/turn-failed',
            message: `node "${activation.node.id}" reached the model's output-token ceiling before reporting a result`,
          },
          retryable: true,
        }
      case 'aborted':
        return {
          status: 'failed',
          error: { code: 'agent/canceled', message: `node "${activation.node.id}" had its turn canceled` },
          retryable: false,
        }
      // Only this executor cancels the turn it drives, and that path returns the
      // deadline failure above; an externally canceled turn carries its own code.
      case 'completed':
      case 'blocked':
      case 'interrupted':
      case 'forked':
      case undefined:
        return missing('ended its turn')
      /* v8 ignore start -- closed-union guard for a reason added to the merge-extensible map */
      default:
        return missing('ended its turn')
      /* v8 ignore stop */
    }
  }

  /**
   * Read the node's agent configuration from the run's stored definition revision.
   * @param activation - the activation whose node configuration is required.
   * @returns the stored agent configuration.
   * @throws {@link AgentExecutorError} with the code naming which lookup failed:
   * the run, its revision compared with the activation, the stored document, or
   * the node inside it.
   */
  private async storedConfig(activation: NodeActivation): Promise<AgentNodeConfig> {
    let run: RunView | undefined
    try {
      run = await this.ctx.mwfScheduler.getRun({ projectId: activation.projectId, runId: activation.runId })
    } catch (error: unknown) {
      throw new AgentExecutorError(
        'agent/run-unavailable',
        `run "${activation.runId}" of project "${activation.projectId}" could not be read: ${describe(error)}`,
        false,
        { cause: error },
      )
    }
    if (run === undefined) {
      throw new AgentExecutorError(
        'agent/run-unavailable',
        `workflow project "${activation.projectId}" records no run "${activation.runId}"`,
        false,
      )
    }
    if (run.definitionRevision !== activation.definitionRevision) {
      throw new AgentExecutorError(
        'agent/stale-activation',
        `the activation of node "${activation.node.id}" names definition revision ${String(activation.definitionRevision)}, `
        + `but run "${activation.runId}" executes revision ${String(run.definitionRevision)}`,
        false,
      )
    }
    let record: DefinitionRecord | undefined
    try {
      record = await this.ctx.mwfProjectStore.readDefinition(activation.projectId, activation.definitionRevision)
    } catch (error: unknown) {
      throw new AgentExecutorError(
        'agent/definition-unavailable',
        `definition revision ${String(activation.definitionRevision)} of project "${activation.projectId}" could not be read: ${describe(error)}`,
        false,
        { cause: error },
      )
    }
    if (record === undefined) {
      throw new AgentExecutorError(
        'agent/definition-unavailable',
        `workflow project "${activation.projectId}" stores no definition revision ${String(activation.definitionRevision)}`,
        false,
      )
    }
    const parsed = parseDefinitionDocument(record.document)
    if (!parsed.ok) {
      const reasons = parsed.violations
        .map(violation => `${violation.code} at ${violation.path.length === 0 ? '/' : violation.path}`)
        .join(', ')
      throw new AgentExecutorError(
        'agent/definition-unavailable',
        `definition revision ${String(record.revision)} of project "${activation.projectId}" is not executable: ${reasons}`,
        false,
      )
    }
    const node = parsed.definition.nodes.find(candidate => candidate.id === activation.node.id)
    if (node === undefined || node.config.kind !== 'agent') {
      throw new AgentExecutorError(
        'agent/node-unavailable',
        `definition revision ${String(record.revision)} of project "${activation.projectId}" declares no agent node "${activation.node.id}"`,
        false,
      )
    }
    return node.config
  }

  /**
   * Open the project that owns the run's working directory.
   * @param activation - the activation whose project is required.
   * @returns the project record, with its absolute working directory.
   * @throws {@link AgentExecutorError} `agent/project-unavailable` when the
   * project cannot be opened.
   */
  private async openProject(activation: NodeActivation): Promise<ProjectRecord> {
    try {
      return await this.ctx.mwfProjectStore.openProject(activation.projectId)
    } catch (error: unknown) {
      throw new AgentExecutorError(
        'agent/project-unavailable',
        `workflow project "${activation.projectId}" could not be opened: ${describe(error)}`,
        false,
        { cause: error },
      )
    }
  }

  /**
   * The model route every child Agent of this deployment uses.
   *
   * A workflow definition carries no model of its own in this stage, so the
   * deployment's default selection is the one authority for it.
   * @returns the deployment default provider, model, and optional reasoning effort.
   */
  private agentOptions(): AgentOptions {
    const selected = this.ctx.agentDefaultModel.currentSelection()
    return {
      provider: selected.provider,
      model: selected.model,
      ...selected.reasoningEffort === undefined ? {} : { reasoningEffort: selected.reasoningEffort },
    }
  }

  /**
   * The session a `retained` node continues.
   * @param activation - the activation being executed.
   * @returns the recorded session id, or `undefined` when this node has no earlier activation.
   * @throws {@link AgentExecutorError} `agent/session-unavailable` when the
   * retained-session record cannot be read.
   */
  private async retainedSession(activation: NodeActivation): Promise<SessionId | undefined> {
    const key = retainedSessionKey(activation.runId, activation.node.id)
    let mapping: Readonly<Record<string, string>>
    try {
      mapping = await this.ctx.mwfProjectStore.transact(activation.projectId, db => selectRetainedSessions(db))
    } catch (error: unknown) {
      throw new AgentExecutorError(
        'agent/session-unavailable',
        `the retained session of node "${activation.node.id}" could not be read: ${describe(error)}`,
        false,
        { cause: error },
      )
    }
    const recorded = mapping[key]
    return recorded === undefined ? undefined : brandString<SessionId>(recorded)
  }

  /**
   * Record the session a `retained` node continues on its next activation.
   * @param activation - the activation being executed.
   * @param sessionId - the freshly created session.
   * @returns nothing; the record commits before the turn runs.
   * @throws {@link AgentExecutorError} `agent/session-unavailable` when the
   * record cannot be written.
   */
  private async recordSession(activation: NodeActivation, sessionId: SessionId): Promise<void> {
    const key = retainedSessionKey(activation.runId, activation.node.id)
    try {
      await this.ctx.mwfProjectStore.transact(activation.projectId, (db) => {
        upsertRetainedSession(db, key, sessionId)
      })
    } catch (error: unknown) {
      throw new AgentExecutorError(
        'agent/session-unavailable',
        `the retained session of node "${activation.node.id}" could not be recorded: ${describe(error)}`,
        true,
        { cause: error },
      )
    }
  }

  /**
   * The project's coordinator session, which owns the decision this node asks.
   *
   * The node's conversation is a child of the coordinator's: `parentSession`
   * names that lineage, so a reader of the session log can tell which project
   * conversation a node serves. A deployment without the coordinator service
   * runs nodes unparented instead of failing them.
   * @param activation - the activation being executed.
   * @returns the coordinator session id, or `undefined` when this deployment mounts none.
   */
  private async coordinatorSession(activation: NodeActivation): Promise<SessionId | undefined> {
    const coordinator = this.ctx.get('mwfCoordinator')
    return coordinator === undefined ? undefined : await coordinator.ensureSession(activation.projectId)
  }

  /**
   * Record one decision request the node's tool asked and announce it.
   * @param activation - the activation whose attempt is asking.
   * @param request - the question, its optional answers, and its optional detail.
   * @returns the request identity the coordinator answers with.
   * @throws {@link AgentExecutorError} `agent/decision-unavailable` when the
   * request cannot be recorded.
   */
  private async recordDecision(activation: NodeActivation, request: DecisionRequest): Promise<string> {
    const requestId = randomUUID()
    try {
      await this.ctx.mwfProjectStore.requestDecision(activation.projectId, {
        requestId,
        activationId: activation.activationId,
        attemptId: activation.attemptId,
        payload: request,
      })
    } catch (error: unknown) {
      throw new AgentExecutorError(
        'agent/decision-unavailable',
        `the decision request of node "${activation.node.id}" could not be recorded: ${describe(error)}`,
        false,
        { cause: error },
      )
    }
    this.ctx.emit('workflow/decision-requested', {
      projectId: activation.projectId,
      runId: activation.runId,
      activationId: activation.activationId,
      attemptId: activation.attemptId,
      nodeId: activation.node.id,
      requestId,
      payload: request,
    })
    return requestId
  }
}
