/**
 * Workflow coordinator (`ctx.mwfCoordinator`): one persistent project Session
 * that owns a project's plan and answers its nodes' decision requests.
 *
 * Each project gets one coordinator Session, recorded in the project database so
 * every process resumes the same conversation. The Session's tools answer
 * pending decisions through the scheduler, list what is still waiting, and
 * report the project's runs and activations; answering a decision is what wakes
 * the node that asked and releases it from `waiting`.
 *
 * The coordinator starts no work of its own: the host drives its Session, and
 * the events this package emits are what a UI subscribes to instead of polling
 * the project database.
 *
 * @module @metaworkflow/workflow-coordinator
 */

import { randomUUID } from 'node:crypto'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { AgentHandle, AgentOptions } from '@metaworkflow/agent'
import { brandString } from '@metaworkflow/brand'
import type { SessionId } from '@metaworkflow/session'
import { selectCoordinatorSession, saveCoordinatorSession } from './session-store.ts'
import { registerCoordinatorTools } from './tools.ts'
import type { DecisionAnsweredInfo } from './types.ts'
// Type-only: brings the store, scheduler, Agent registry, and default-model
// services into the Context type the plugin injects.
import type {} from '@metaworkflow/workflow-project-store'
import type {} from '@metaworkflow/workflow-scheduler'
import type {} from '@metaworkflow/agent-default-model'
import type {} from '@metaworkflow/session-persistence'
import type { ProjectId } from '@metaworkflow/workflow-project-store'

export type * from './types.ts'
export { COORDINATOR_SESSION_KEY } from './session-store.ts'
export {
  ANSWER_DECISION_TOOL_NAME,
  LIST_DECISIONS_TOOL_NAME,
  PROJECT_STATE_TOOL_NAME,
  type CoordinatorToolDeps,
} from './tools.ts'

/** Stable failure codes the coordinator reports. */
export type WorkflowCoordinatorErrorCode =
  /** The project or its Agent Session could not be opened. */
  | 'coordinator/session-unavailable'

/** Typed failure from the workflow coordinator. */
export class WorkflowCoordinatorError extends Error {
  override readonly name: string = 'WorkflowCoordinatorError'

  /** The stable code callers switch on. */
  readonly code: WorkflowCoordinatorErrorCode

  /**
   * @param code - stable failure code.
   * @param message - actionable description naming the project or Session.
   * @param options - standard `Error` options such as `cause`.
   */
  constructor(code: WorkflowCoordinatorErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.code = code
  }
}

/** The system prompt section that states the coordinator's responsibilities. */
export const COORDINATOR_SECTION_NAME = 'workflow:coordinator'

/**
 * The coordinator's system prompt for one project.
 * @param project - the project the Session coordinates.
 * @returns the section text.
 */
function coordinatorPrompt(project: { readonly title: string; readonly path: string }): string {
  return [
    `You are the project coordinator for the workflow project "${project.title}", whose working directory is ${project.path}.`,
    '',
    'You own the project\'s workflow: keep its definition executable, answer the decisions its nodes ask, and report its state.',
    '',
    '- Use list_pending_decisions to see what is waiting, answer_decision to answer one, and get_project_state to inspect runs and activations.',
    '- A node resumes with your answer as its next input, so answer with the value it needs, not a description of what you decided.',
    '- Diagnose and repair nodes yourself, including their implementation, instructions, inputs, and output schemas.',
    '- A structural change to the whole workflow — adding, removing, or rewiring nodes — needs the user\'s explicit request; propose it first.',
    '- Never claim work finished that get_project_state does not show as succeeded.',
  ].join('\n')
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    mwfCoordinator: WorkflowCoordinator
  }

  interface Events {
    /**
     * The coordinator answered a node's decision request and resumed its
     * activation. Paired with the executor's `workflow/decision-requested`.
     * @param info - the answered decision, its answer, and the run it resumed.
     * @mode emit
     */
    'workflow/decision-answered'(info: DecisionAnsweredInfo): void
  }
}

/**
 * The workflow coordinator service.
 *
 * One instance owns every project's coordinator Session: it creates the
 * Session on first use, resumes the recorded one afterwards, and disposes both
 * with the plugin. The durable record that makes the resumption possible lives
 * in each project's database.
 */
export default class WorkflowCoordinator extends Service {
  static inject = [
    'mwfProjectStore',
    'mwfScheduler',
    'agents',
    'sessionPersistence',
    'systemPrompt',
    'tools',
    'agentDefaultModel',
  ]

  static Config = z.object({})

  /** Live coordinator Sessions, by project. */
  private readonly sessions = new Map<ProjectId, SessionId>()
  /** The owned Agent handle of each live coordinator Session. */
  private readonly handles = new Map<ProjectId, AgentHandle>()
  /** Opens in flight, so two callers never create two coordinators for one project. */
  private readonly opening = new Map<ProjectId, Promise<SessionId>>()

  /**
   * @param ctx - plugin context that owns the service and its Sessions.
   */
  constructor(ctx: Context) {
    super(ctx, 'mwfCoordinator')
    ctx.effect(() => async () => {
      await this.dispose()
    }, 'workflowCoordinator.dispose')
  }

  /**
   * The coordinator Session of one project, created on first use.
   *
   * A recorded Session is resumed, so the conversation keeps the plan it
   * already made; a project that has none gets a fresh Session recorded before
   * it can answer anything, so the next process resumes the same one.
   * @param projectId - project whose coordinator Session is needed.
   * @returns the live coordinator Session identity.
   * @throws {@link WorkflowCoordinatorError} `coordinator/session-unavailable`
   * when the project or its Session cannot be opened.
   */
  async ensureSession(projectId: ProjectId): Promise<SessionId> {
    const live = this.sessions.get(projectId)
    if (live !== undefined) return live
    const inFlight = this.opening.get(projectId)
    if (inFlight !== undefined) return await inFlight
    const opening = this.open(projectId)
    this.opening.set(projectId, opening)
    try {
      return await opening
    } finally {
      this.opening.delete(projectId)
    }
  }

  /**
   * Create or resume one project's coordinator Session.
   * @param projectId - project whose Session is opened.
   * @returns the live coordinator Session identity.
   * @throws {@link WorkflowCoordinatorError} `coordinator/session-unavailable`
   * when the project or its Agent cannot be opened.
   */
  private async open(projectId: ProjectId): Promise<SessionId> {
    try {
      const project = await this.ctx.mwfProjectStore.openProject(projectId)
      const recorded = await this.ctx.mwfProjectStore.transact(projectId, db => selectCoordinatorSession(db))
      const sessionId = recorded ?? this.newSessionId()
      const agentOptions = this.agentOptions()
      const setup = (agentCtx: Context): void => { this.compose(agentCtx, projectId, project) }
      let handle: AgentHandle
      if (recorded === undefined) {
        handle = await this.ctx.agents.create({
          sessionId,
          meta: { cwd: project.path },
          agentOptions,
          setup,
        })
        // Record the identity only once the Session exists, so a project never
        // points at a conversation that failed to open.
        await this.ctx.mwfProjectStore.transact(projectId, (db) => {
          saveCoordinatorSession(db, sessionId)
        })
      } else {
        handle = await this.ctx.agents.resume({ resumeSessionId: sessionId, agentOptions, setup })
      }
      this.sessions.set(projectId, sessionId)
      this.handles.set(projectId, handle)
      return sessionId
    } catch (error: unknown) {
      throw new WorkflowCoordinatorError(
        'coordinator/session-unavailable',
        `the coordinator Session of workflow project "${projectId}" could not be opened: ${String(error)}`,
        { cause: error },
      )
    }
  }

  /**
   * Compose one coordinator Session's scoped world.
   * @param agentCtx - the coordinator Agent's scope context, during its creation window.
   * @param projectId - project the Session coordinates.
   * @param project - the project record, whose title and path the prompt names.
   * @returns nothing; every registration belongs to the Session's scope.
   */
  private compose(
    agentCtx: Context,
    projectId: ProjectId,
    project: { readonly title: string; readonly path: string },
  ): void {
    agentCtx.systemPrompt.section({
      name: COORDINATOR_SECTION_NAME,
      order: agentCtx.systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA_PREFIX'),
      text: coordinatorPrompt(project),
      // The title and path are runtime facts, not deployment prompt variables.
      interpolate: false,
    })
    registerCoordinatorTools(agentCtx, {
      projectId,
      store: this.ctx.mwfProjectStore,
      scheduler: this.ctx.mwfScheduler,
      announce: (info) => { this.ctx.emit('workflow/decision-answered', info) },
    })
  }

  /**
   * The model route every coordinator Session of this deployment uses.
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
   * The identity a fresh coordinator Session receives.
   * @returns a new session id shaped like every other entry point's.
   */
  private newSessionId(): SessionId {
    return brandString<SessionId>(`session-${randomUUID()}`)
  }

  /** Dispose every owned Session and refuse further work. */
  private async dispose(): Promise<void> {
    const handles = [...this.handles.values()]
    this.handles.clear()
    this.sessions.clear()
    for (const handle of handles) await handle.dispose()
  }
}
