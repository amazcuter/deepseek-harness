/**
 * Host project Remote owner: the `projects` namespace the dashboard reads.
 *
 * The verbs are thin: project identity and titles belong to
 * `ctx.mwfProjectStore`, the session account and the display order belong to
 * `ctx.workspaceRegistry`. This service composes the two into one list row per
 * project and refuses a request with the stable failure vocabulary instead of
 * leaking a store error.
 */

import { Context } from '@deepseek-ai/cordis'
import { Remote, RemoteError, TypertRemoteService, remoteErrorOf } from '@metaworkflow/typert-protocol'
import type { Workspace, WorkspaceId } from '@metaworkflow/workspace'
import type {
  ProjectCreateRequest,
  ProjectListValue,
  ProjectRemoveValue,
  ProjectRenameRequest,
  ProjectSummary,
  ProjectTargetRequest,
  ProjectValue,
} from './types.ts'
import { WorkflowProjectStoreError } from '@metaworkflow/workflow-project-store'
import type { ProjectRecord } from '@metaworkflow/workflow-project-store'

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

export default MwProjectController
