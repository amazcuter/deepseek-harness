/**
 * Host project Remote owner: the `projects` namespace the dashboard and the
 * workbench read.
 *
 * The verbs are thin: project identity and titles belong to
 * `ctx.mwfProjectStore`, the session account and the display order belong to
 * `ctx.workspaceRegistry`, the definition graph belongs to
 * `@metaworkflow/workflow-definition`, and runs and decisions belong to
 * `ctx.mwfScheduler` and `ctx.mwfCoordinator`. This service composes those into
 * one list row per project plus the workbench verbs, and refuses a request with
 * the stable failure vocabulary instead of leaking a store or scheduler error.
 */

import { Context } from '@deepseek-ai/cordis'
import { Remote, RemoteError, TypertRemoteService, remoteErrorOf } from '@metaworkflow/typert-protocol'
import {
  parseDefinitionDocument, serializeDefinition, validateDefinition,
} from '@metaworkflow/workflow-definition'
import type { WorkflowDefinition, WorkflowNode } from '@metaworkflow/workflow-definition'
// Type-only: the coordinator and scheduler plugins declare the `mwfCoordinator`
// and `mwfScheduler` Context services this Remote reads through `ctx.get`.
import type {} from '@metaworkflow/workflow-coordinator'
import type {} from '@metaworkflow/workflow-scheduler'
import type Scheduler from '@metaworkflow/workflow-scheduler'
import { WorkflowSchedulerError } from '@metaworkflow/workflow-scheduler'
import type { ActivationView, AttemptView, RunView } from '@metaworkflow/workflow-scheduler'
import { WorkflowProjectStoreError } from '@metaworkflow/workflow-project-store'
import type { DefinitionRecord, ProjectRecord, RunId } from '@metaworkflow/workflow-project-store'
import type { Workspace, WorkspaceId } from '@metaworkflow/workspace'
import {
  nodeViews, patchNode, pendingDecisionView, violationView,
} from './project-workflow.ts'
import type {
  ProjectActivationView,
  ProjectAnswerDecisionRequest,
  ProjectAnswerDecisionValue,
  ProjectAttemptsRequest,
  ProjectAttemptsValue,
  ProjectAttemptView,
  ProjectCoordinatorValue,
  ProjectCreateRequest,
  ProjectDefinitionValue,
  ProjectImportDefinitionRequest,
  ProjectImportDefinitionValue,
  ProjectListValue,
  ProjectNodeTargetRequest,
  ProjectPendingDecisionsValue,
  ProjectRemoveValue,
  ProjectRenameRequest,
  ProjectRunControlValue,
  ProjectRunStartValue,
  ProjectRunTargetRequest,
  ProjectRunView,
  ProjectSummary,
  ProjectTargetRequest,
  ProjectToolView,
  ProjectToolsValue,
  ProjectUpdateNodeRequest,
  ProjectUpdateNodeValue,
  ProjectValue,
} from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Host service backing the generated `ctx.remote.projects` namespace. */
    mwProjectController: MwProjectController
  }
}

/**
 * Host service backing the generated `ctx.remote.projects` namespace.
 * It serves the dashboard: list what is registered, create, open, rename, and
 * remove — never a directory-tree deletion.
 */
export class MwProjectController extends TypertRemoteService {
  static inject = ['mwfProjectStore', 'workspaceRegistry']

  /** @param ctx - Host context carrying the project store and the workspace registry. */
  constructor(ctx: Context) {
    super(ctx, 'mwProjectController', { namespace: 'projects' })
  }

  /**
   * List every registered project in registry display order.
   * @returns one row per project, with its live directory state.
   */
  @Remote('list')
  async list(): Promise<ProjectListValue> {
    const revisions = await this.revisions()
    const items: ProjectSummary[] = []
    for (const workspace of this.ctx.workspaceRegistry.list()) {
      items.push(await this.summary(workspace, revisions.get(workspace.id) ?? 0))
    }
    return { items }
  }

  /**
   * Register a project and its session group.
   * @param request - title and optional existing directory.
   * @returns the registered project.
   */
  @Remote('create')
  async create(request: ProjectCreateRequest): Promise<ProjectValue> {
    const title = request.title.trim()
    if (title === '') {
      throw new RemoteError('gateway/bad-request', 'project.create requires a non-blank title', {})
    }
    try {
      const workspace = await this.ctx.workspaceRegistry.createProject({
        title,
        ...request.path === undefined ? {} : { path: request.path },
      })
      return { project: await this.summary(workspace, await this.revisionOf(workspace.id)) }
    } catch (error) {
      throw projectFailure(error, request.path)
    }
  }

  /**
   * Open one project, materializing its database when the directory exists
   * without one.
   * @param request - project identity.
   * @returns the opened project.
   */
  @Remote('open')
  async open(request: ProjectTargetRequest): Promise<ProjectValue> {
    const workspace = this.requireWorkspace(request.id)
    try {
      const record = await this.ctx.mwfProjectStore.openProject(request.id)
      return { project: await this.summary(workspace, record.definitionRevision) }
    } catch (error) {
      throw projectFailure(error)
    }
  }

  /**
   * Rename one project.
   * @param request - project identity and proposed title.
   * @returns the updated project.
   */
  @Remote('rename')
  async rename(request: ProjectRenameRequest): Promise<ProjectValue> {
    const title = request.title.trim()
    if (title === '') {
      throw new RemoteError('gateway/bad-request', 'project.rename requires a non-blank title', {})
    }
    const workspace = this.requireWorkspace(request.id)
    try {
      await workspace.setTitle(title)
      return { project: await this.summary(workspace, await this.revisionOf(workspace.id)) }
    } catch (error) {
      throw projectFailure(error)
    }
  }

  /**
   * Remove one project registration. The directory and every Session are
   * retained.
   * @param request - project identity.
   * @returns deletion confirmation.
   */
  @Remote('delete')
  async delete(request: ProjectTargetRequest): Promise<ProjectRemoveValue> {
    try {
      if (!await this.ctx.workspaceRegistry.delete(request.id)) throw projectNotFound(request.id)
    } catch (error) {
      throw projectFailure(error)
    }
    return { deleted: true }
  }

  /**
   * Read the project's coordinator Session, creating it on first use.
   * @param request - project identity.
   * @returns the coordinator Session identity, or `null` when the Host
   * composition serves no coordinator.
   */
  @Remote('coordinator')
  async coordinator(request: ProjectTargetRequest): Promise<ProjectCoordinatorValue> {
    this.requireWorkspace(request.id)
    const coordinator = this.ctx.get('mwfCoordinator')
    if (coordinator === undefined) return { sessionId: null }
    try {
      return { sessionId: await coordinator.ensureSession(request.id) }
    } catch (error: unknown) {
      throw projectFailure(error)
    }
  }

  /**
   * Read the project's newest stored definition with its nodes and violations.
   *
   * A stored document that no longer validates is reported, not refused: the
   * inspector exists to show what is wrong with it.
   * @param request - project identity.
   * @returns the newest revision, its nodes, and every violation.
   */
  @Remote('definition')
  async definition(request: ProjectTargetRequest): Promise<ProjectDefinitionValue> {
    this.requireWorkspace(request.id)
    const record = await this.ctx.mwfProjectStore.readDefinition(request.id)
    if (record === undefined) return EMPTY_DEFINITION
    const parsed = parseDefinitionDocument(record.document)
    return parsed.ok
      ? {
        revision: record.revision,
        document: record.document,
        valid: true,
        violations: [],
        nodes: nodeViews(parsed.definition),
      }
      : {
        revision: record.revision,
        document: record.document,
        valid: false,
        violations: parsed.violations.map(violationView),
        nodes: [],
      }
  }

  /**
   * Store one hand-written definition document as a new revision.
   *
   * The document is validated before it is written, so an unusable graph never
   * becomes the project's newest revision. It is stored in canonical form.
   * @param request - project identity and document text.
   * @returns the revision it was stored under and how many nodes it declares.
   */
  @Remote('importDefinition')
  async importDefinition(request: ProjectImportDefinitionRequest): Promise<ProjectImportDefinitionValue> {
    this.requireWorkspace(request.id)
    const parsed = parseDefinitionDocument(request.document)
    if (!parsed.ok) throw definitionInvalid(parsed.violations.map(violation => violation.message))
    try {
      const revision = await this.ctx.mwfProjectStore.writeDefinition(
        request.id,
        serializeDefinition(parsed.definition),
      )
      return { revision, nodeCount: parsed.definition.nodes.length }
    } catch (error: unknown) {
      throw projectFailure(error)
    }
  }

  /**
   * List one node's tool switches: every tool this Host registers, plus any
   * name the node already declares that the Host no longer registers.
   * @param request - project and node identity.
   * @returns one switch per tool, sorted by name.
   */
  @Remote('availableTools')
  async availableTools(request: ProjectNodeTargetRequest): Promise<ProjectToolsValue> {
    const node = await this.requireNode(request)
    if (node.config.kind !== 'agent') return { items: [] }
    return { items: toolViews(node.config.tools, this.toolSchemas()) }
  }

  /**
   * Edit one node's title or tool list, storing the result as a new definition
   * revision.
   * @param request - project, node, and the writable fields to replace.
   * @returns the revision the edited definition was stored under.
   */
  @Remote('updateNode')
  async updateNode(request: ProjectUpdateNodeRequest): Promise<ProjectUpdateNodeValue> {
    const { definition } = await this.requireDefinition(request.id)
    const node = definition.nodes.find(candidate => candidate.id === request.nodeId)
    if (node === undefined) throw nodeNotFound(request.nodeId)
    if (request.patch.tools !== undefined && node.config.kind !== 'agent') {
      throw new RemoteError(
        'gateway/bad-request',
        `node "${request.nodeId}" is a python node and carries no tool list`,
        {},
      )
    }
    const patched = patchNode(definition, node, request.patch)
    const validation = validateDefinition(patched)
    if (!validation.ok) throw definitionInvalid(validation.violations.map(violation => violation.message))
    try {
      return {
        revision: await this.ctx.mwfProjectStore.writeDefinition(request.id, serializeDefinition(patched)),
      }
    } catch (error: unknown) {
      throw projectFailure(error)
    }
  }

  /**
   * List every decision the project is still waiting on, oldest first.
   * @param request - project identity.
   * @returns the unanswered requests.
   */
  @Remote('pendingDecisions')
  async pendingDecisions(request: ProjectTargetRequest): Promise<ProjectPendingDecisionsValue> {
    this.requireWorkspace(request.id)
    const records = await this.ctx.mwfProjectStore.listPendingDecisions(request.id)
    return { items: records.map(pendingDecisionView) }
  }

  /**
   * Record one answer and resume the activation that asked.
   * @param request - project, request id, and answer text.
   * @returns the run status once the resumed activation settled or the call returned.
   */
  @Remote('answerDecision')
  async answerDecision(request: ProjectAnswerDecisionRequest): Promise<ProjectAnswerDecisionValue> {
    this.requireWorkspace(request.id)
    const answer = request.answer.trim()
    if (answer === '') {
      throw new RemoteError('gateway/bad-request', 'projects.answerDecision requires a non-blank answer', {})
    }
    const scheduler = this.requireScheduler()
    const pending = await this.ctx.mwfProjectStore.listPendingDecisions(request.id)
    const target = pending.find(item => item.requestId === request.requestId)
    if (target === undefined) throw decisionUnavailable(request.requestId)
    try {
      await this.ctx.mwfProjectStore.answerDecision(request.id, request.requestId, answer)
      const tick = await scheduler.resumeActivation({
        projectId: request.id,
        runId: target.runId,
        activationId: target.activationId,
        decision: answer,
      })
      return { answered: true, runStatus: tick.status }
    } catch (error: unknown) {
      throw workflowFailure(error)
    }
  }

  /**
   * Read one run of the project with its activations and attempts.
   * @param request - project identity and the run to read, newest when omitted.
   * @returns the run and its attempts; `run` is `null` when the project has no run.
   */
  @Remote('attempts')
  async attempts(request: ProjectAttemptsRequest): Promise<ProjectAttemptsValue> {
    this.requireWorkspace(request.id)
    const scheduler = this.requireScheduler()
    const runs = await this.ctx.mwfProjectStore.listRuns(request.id)
    const chosen = request.runId === undefined
      ? runs[0]
      : runs.find(run => run.runId === request.runId)
    if (chosen === undefined) {
      if (request.runId === undefined) return { run: null, items: [] }
      throw runUnavailable(request.runId)
    }
    try {
      const view = await scheduler.getRun({ projectId: request.id, runId: chosen.runId })
      if (view === undefined) throw runUnavailable(chosen.runId)
      const activations = await scheduler.listActivations({ projectId: request.id, runId: chosen.runId })
      const attempts = await scheduler.listAttempts({ projectId: request.id, runId: chosen.runId })
      return { run: runViewOf(view, activations), items: attemptViews(attempts, activations) }
    } catch (error: unknown) {
      throw workflowFailure(error)
    }
  }

  /**
   * Start a run from the newest stored definition and advance it once.
   * @param request - project identity.
   * @returns the new run and its status after the first tick.
   */
  @Remote('startRun')
  async startRun(request: ProjectTargetRequest): Promise<ProjectRunStartValue> {
    this.requireWorkspace(request.id)
    const { record } = await this.requireDefinition(request.id)
    const scheduler = this.requireScheduler()
    try {
      const created = await scheduler.createRun({
        projectId: request.id,
        definitionRevision: record.revision,
      })
      const tick = await scheduler.tick({ projectId: request.id, runId: created.runId })
      return { runId: created.runId, status: tick.status }
    } catch (error: unknown) {
      throw workflowFailure(error)
    }
  }

  /**
   * Pause one run, stopping work from starting further activations.
   * @param request - project and run identity.
   * @returns the run status after the transition.
   */
  @Remote('pause')
  async pause(request: ProjectRunTargetRequest): Promise<ProjectRunControlValue> {
    this.requireWorkspace(request.id)
    const scheduler = this.requireScheduler()
    const runId = await this.requireRun(request.id, request.runId)
    try {
      const view = await scheduler.pause({ projectId: request.id, runId })
      return { runId: view.runId, status: view.status }
    } catch (error: unknown) {
      throw workflowFailure(error)
    }
  }

  /**
   * Resume one paused run and advance it once.
   * @param request - project and run identity.
   * @returns the run status after the transition.
   */
  @Remote('resume')
  async resume(request: ProjectRunTargetRequest): Promise<ProjectRunControlValue> {
    this.requireWorkspace(request.id)
    const scheduler = this.requireScheduler()
    const runId = await this.requireRun(request.id, request.runId)
    try {
      const view = await scheduler.resume({ projectId: request.id, runId })
      return { runId: view.runId, status: view.status }
    } catch (error: unknown) {
      throw workflowFailure(error)
    }
  }

  /** The stored identity of one run the project recorded. */
  private async requireRun(id: WorkspaceId, runId: string): Promise<RunId> {
    const runs = await this.ctx.mwfProjectStore.listRuns(id)
    const found = runs.find(run => run.runId === runId)
    if (found === undefined) throw runUnavailable(runId)
    return found.runId
  }

  /** The scheduler of this Host composition. */
  private requireScheduler(): Scheduler {
    const scheduler = this.ctx.get('mwfScheduler')
    if (scheduler === undefined) throw workflowUnavailable('mwfScheduler')
    return scheduler
  }

  /** Tool schemas the Host registers globally, which is the set a node may select. */
  private toolSchemas(): readonly ToolSwitchSchema[] {
    const tools = this.ctx.get('tools')
    return tools === undefined ? [] : tools.schemas()
  }

  /** One stored definition with the record it came from. */
  private async requireDefinition(id: WorkspaceId): Promise<{
    readonly record: DefinitionRecord
    readonly definition: WorkflowDefinition
  }> {
    const record = await this.ctx.mwfProjectStore.readDefinition(id)
    if (record === undefined) {
      throw new RemoteError('project/definition-missing', `project "${id}" has no stored definition`, {})
    }
    const parsed = parseDefinitionDocument(record.document)
    if (!parsed.ok) throw definitionInvalid(parsed.violations.map(violation => violation.message))
    return { record, definition: parsed.definition }
  }

  /** One node of the project's stored definition. */
  private async requireNode(request: ProjectNodeTargetRequest): Promise<WorkflowNode> {
    const { definition } = await this.requireDefinition(request.id)
    const node = definition.nodes.find(candidate => candidate.id === request.nodeId)
    if (node === undefined) throw nodeNotFound(request.nodeId)
    return node
  }

  /** One dashboard row for a workspace and its latest definition revision. */
  private async summary(workspace: Workspace, definitionRevision: number): Promise<ProjectSummary> {
    return {
      id: workspace.id,
      title: workspace.title,
      path: workspace.path,
      status: await workspace.status(),
      definitionRevision,
      sessionCount: workspace.sessionIds.length,
    }
  }

  /** Latest definition revision of one project, or `0` when the registry no longer lists it. */
  private async revisionOf(id: WorkspaceId): Promise<number> {
    return (await this.revisions()).get(id) ?? 0
  }

  /** Latest definition revision per project, from the registry's list hint. */
  private async revisions(): Promise<Map<WorkspaceId, number>> {
    const records = await this.ctx.mwfProjectStore.listProjects()
    return new Map(records.map((record: ProjectRecord) => [record.id, record.definitionRevision]))
  }

  private requireWorkspace(id: WorkspaceId): Workspace {
    const workspace = this.ctx.workspaceRegistry.get(id)
    if (workspace === undefined) throw projectNotFound(id)
    return workspace
  }
}

/**
 * Map one failure onto the Remote vocabulary.
 * @param error - caught failure.
 * @param path - requested directory, when the request named one.
 * @returns the failure to throw.
 */
function projectFailure(error: unknown, path?: string): Error {
  const remote = remoteErrorOf(error)
  if (remote !== undefined) return remote
  if (error instanceof WorkflowProjectStoreError) {
    switch (error.code) {
      case 'project-not-found':
        return new RemoteError('project/not-found', error.message, {})
      case 'project-path-in-use':
        return new RemoteError('project/path-in-use', error.message, {
          path: path ?? '',
        })
      case 'invalid-request':
        return new RemoteError('gateway/bad-request', error.message, {})
      /* v8 ignore start -- the store's remaining codes are storage faults the caller cannot act on. */
      default:
        return new RemoteError('gateway/internal', error.message, {}, { cause: error })
      /* v8 ignore stop */
    }
  }
  const message = error instanceof Error ? error.message : String(error)
  const details = { path: path ?? '' }
  return error instanceof Error
    ? new RemoteError('project/invalid-path', `cannot register a project at "${details.path}": ${message}`, details, { cause: error })
    : new RemoteError('project/invalid-path', `cannot register a project at "${details.path}": ${message}`, details)
}

/**
 * @param id - project identity no registration carries.
 * @returns the Remote failure to throw.
 */
function projectNotFound(id: WorkspaceId): RemoteError<'project/not-found'> {
  return new RemoteError('project/not-found', `project "${id}" not found`, {})
}

/**
 * @param nodeId - node id no stored definition carries.
 * @returns the Remote failure to throw.
 */
function nodeNotFound(nodeId: string): RemoteError<'project/node-not-found'> {
  return new RemoteError('project/node-not-found', `the definition has no node "${nodeId}"`, { nodeId })
}

/**
 * @param violations - every reason the document is not executable.
 * @returns the Remote failure to throw.
 */
function definitionInvalid(violations: readonly string[]): RemoteError<'project/definition-invalid'> {
  return new RemoteError(
    'project/definition-invalid',
    `the definition is not executable: ${violations.join('; ')}`,
    { violations },
  )
}

/**
 * @param requestId - decision id no pending row carries.
 * @returns the Remote failure to throw.
 */
function decisionUnavailable(requestId: string): RemoteError<'project/decision-unavailable'> {
  return new RemoteError(
    'project/decision-unavailable',
    `the project waits on no decision "${requestId}"`,
    { requestId },
  )
}

/**
 * @param runId - run id the project does not hold.
 * @returns the Remote failure to throw.
 */
function runUnavailable(runId: string): RemoteError<'project/run-unavailable'> {
  return new RemoteError('project/run-unavailable', `the project has no run "${runId}"`, { runId })
}

/**
 * @param capability - the missing Host service.
 * @returns the Remote failure to throw.
 */
function workflowUnavailable(capability: string): RemoteError<'project/workflow-unavailable'> {
  return new RemoteError(
    'project/workflow-unavailable',
    `this Host composition serves no workflow runtime (no "${capability}")`,
    { capability },
  )
}

/**
 * Map one scheduler or store failure onto the Remote vocabulary.
 * @param error - caught failure.
 * @returns the failure to throw.
 */
function workflowFailure(error: unknown): Error {
  const remote = remoteErrorOf(error)
  if (remote !== undefined) return remote
  if (error instanceof WorkflowSchedulerError) {
    switch (error.code) {
      case 'scheduler/definition-unavailable':
        return new RemoteError('project/definition-missing', error.message, {}, { cause: error })
      case 'scheduler/definition-invalid':
        return new RemoteError('project/definition-invalid', error.message, { violations: [] }, { cause: error })
      case 'scheduler/run-not-found':
        return new RemoteError('project/run-unavailable', error.message, { runId: '' }, { cause: error })
      case 'scheduler/closed':
        return new RemoteError('gateway/internal', error.message, {}, { cause: error })
      // Every remaining code is a state refusal the workbench acts on: the run
      // already settled, the activation is not resumable, or its join does not
      // fire yet. `scheduler/duplicate-executor` lands here too: only executor
      // registration raises it, and no Remote verb registers one.
      default:
        return new RemoteError('gateway/bad-request', error.message, {}, { cause: error })
    }
  }
  return projectFailure(error)
}

/**
 * Project one scheduler run for the workbench.
 * @param view - the run as the scheduler reads it back.
 * @param activations - every activation of that run.
 * @returns the run with its activations, in the order the scheduler listed them.
 */
function runViewOf(view: RunView, activations: readonly ActivationView[]): ProjectRunView {
  const summaries: ProjectActivationView[] = activations.map(activation => ({
    activationId: activation.activationId,
    nodeId: activation.nodeId,
    iteration: activation.iteration,
    status: activation.status,
  }))
  return {
    runId: view.runId,
    definitionRevision: view.definitionRevision,
    status: view.status,
    reason: view.reason,
    createdAt: view.createdAt,
    updatedAt: view.updatedAt,
    activations: summaries,
  }
}

/**
 * Project scheduler attempts for the results tab.
 * @param attempts - every attempt of the run.
 * @param activations - that run's activations, which name each attempt's node.
 * @returns one row per attempt, in the order the scheduler listed them.
 */
function attemptViews(
  attempts: readonly AttemptView[],
  activations: readonly ActivationView[],
): ProjectAttemptView[] {
  const nodeOf = new Map(activations.map(activation => [activation.activationId, activation.nodeId]))
  return attempts.map(attempt => ({
    attemptId: attempt.attemptId,
    activationId: attempt.activationId,
    /* v8 ignore next -- the scheduler lists attempts of one run, so every attempt's activation is in that run's list. */
    nodeId: nodeOf.get(attempt.activationId) ?? '',
    attemptNo: attempt.attemptNo,
    status: attempt.status,
    startedAt: attempt.startedAt,
    endedAt: attempt.endedAt,
    error: attempt.error === null ? null : attempt.error.message,
  }))
}

/**
 * Project one node's tool switches.
 * @param declared - tool names the node's definition lists.
 * @param registered - schemas of the tools this Host registers.
 * @returns one switch per name, sorted, declaring unregistered names too so a
 * stale entry stays visible and switchable.
 */
function toolViews(
  declared: readonly string[],
  registered: readonly ToolSwitchSchema[],
): ProjectToolView[] {
  const enabled = new Set(declared)
  const items = registered.map((schema): ProjectToolView => ({
    name: schema.name,
    description: schema.description,
    enabled: enabled.has(schema.name),
  }))
  const known = new Set(items.map(item => item.name))
  for (const name of declared) {
    if (!known.has(name)) items.push({ name, description: '', enabled: true })
  }
  return items.sort((left, right) => left.name.localeCompare(right.name))
}

/** The part of one registered tool schema a switch needs. */
interface ToolSwitchSchema {
  readonly name: string
  readonly description: string
}

/** The definition view of a project that stores none. */
const EMPTY_DEFINITION: ProjectDefinitionValue = {
  revision: 0,
  document: null,
  valid: false,
  violations: [],
  nodes: [],
}

export default MwProjectController
