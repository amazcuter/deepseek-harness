/**
 * Workspace entity registry (`ctx.workspaceRegistry`): registered workflow
 * projects seen as session groups. Project identity — id, directory, title —
 * belongs to `ctx.mwfProjectStore`; this registry owns the ordered session
 * account of each project, the display order, the first-use identity, and the
 * registry-global archive and pin sets.
 * @module @metaworkflow/workspace
 */

import { mkdir, stat } from 'node:fs/promises'
import { Context, Service } from '@deepseek-ai/cordis'
import { brandString } from '@metaworkflow/brand'
import type { SessionHeader, SessionId } from '@metaworkflow/session'
import type {} from '@metaworkflow/session-persistence'
import type { DomainGlobal, KvTable } from '@metaworkflow/storage-domain'
import { WorkflowProjectStoreError } from '@metaworkflow/workflow-project-store'
import type { CreateProjectRequest, ProjectId, ProjectRecord } from '@metaworkflow/workflow-project-store'
import { WorkspaceEntity } from './entity.ts'
import type { WorkspaceEntityHost } from './entity.ts'

export { WorkspaceMoveInvalidError } from './entity.ts'
import { defaultWorkspaceTitle, fullyQualifiedWorkspacePath, realpathNormalize } from './paths.ts'
import { legacyWorkspaceDomainSpec, workspaceDomainSpec } from './spec.ts'
import type {
  LegacyWorkspaceRecord,
  LegacyWorkspaceState,
  WorkspaceGroupRecord,
  WorkspaceProjectState,
} from './spec.ts'
import type { SessionActivity, Workspace, WorkspaceId as WorkspaceIdBrand } from './types.ts'

export type {
  SessionActivity, SessionActivityItem, SessionActivityKind, SessionActivityKindMap, Workspace,
} from './types.ts'
export {
  legacyWorkspaceDomainSpec, legacyWorkspaceRecord, workspaceDomainSpec, workspaceGroupRecord, workspaceProjectState,
} from './spec.ts'
export type {
  LegacyWorkspaceRecord, LegacyWorkspaceState, WorkspaceGroupRecord, WorkspaceProjectState,
} from './spec.ts'
export { realpathNormalize } from './paths.ts'

/** Identifies one workspace: the project identity it groups (see `src/types.ts`). */
export type WorkspaceId = WorkspaceIdBrand

/**
 * Brand a string as a {@link WorkspaceId}.
 * @param id - Raw project id string.
 * @returns the same string, branded at compile time.
 */
export function WorkspaceId(id: string): WorkspaceId {
  return brandString<ProjectId>(id)
}

/**
 * An archiveSession or pinSession request named a session neither live nor in
 * session persistence — a definite miss only; storage faults propagate as
 * themselves.
 */
export class WorkspaceUnknownSessionError extends Error {
  /**
   * @param sessionId - The unknown session id.
   * @param verb - The registry operation that named the session.
   */
  constructor(readonly sessionId: SessionId, verb: 'archive' | 'pin') {
    super(`cannot ${verb} session '${sessionId}': live sessions and session persistence hold no such session`)
    this.name = 'WorkspaceUnknownSessionError'
  }
}

/**
 * An archiveSession request named a session that at least one
 * `workspace/session-activity` listener reported active. Nothing was written;
 * `activity` names what must stop before the session can be archived.
 */
export class WorkspaceActiveSessionError extends Error {
  /**
   * @param sessionId - The active session id.
   * @param activity - The reported activity, in listener order.
   */
  constructor(readonly sessionId: SessionId, readonly activity: readonly SessionActivity[]) {
    super(`cannot archive session '${sessionId}': the session is active (${activity.map(entry => entry.kind).join(', ')})`)
    this.name = 'WorkspaceActiveSessionError'
  }
}

/** A pinSession request named a session currently in the archive set; pinning and archival are mutually exclusive. */
export class WorkspaceArchivedSessionPinError extends Error {
  /**
   * @param sessionId - The archived session id.
   */
  constructor(readonly sessionId: SessionId) {
    super(`cannot pin session '${sessionId}': the session is archived`)
    this.name = 'WorkspaceArchivedSessionPinError'
  }
}

/** A workspace reorder named a source or anchor absent from the durable registry order. */
export class WorkspaceOrderInvalidError extends Error {
  /**
   * @param workspaceId - Missing source or anchor id.
   */
  constructor(readonly workspaceId: WorkspaceId) {
    super(`cannot reorder unknown workspace '${workspaceId}'`)
    this.name = 'WorkspaceOrderInvalidError'
  }
}

/** The session an archive request is about to write into the archive set. */
export interface SessionActivityRequest {
  readonly sessionId: SessionId
}

/** Caller choices for {@link WorkspaceRegistry.archiveSession}. */
export interface ArchiveSessionOptions {
  /**
   * Ask the composed providers to stop the session's running work instead of
   * refusing the archive because of it. The archive is written first, then
   * the stops are requested; running work is never awaited to settlement, and
   * a provider failure is logged without undoing the archive.
   */
  readonly stopActivity?: boolean
}

/** Request to register one workflow project and its session group. */
export interface CreateWorkspaceProjectRequest {
  /** Display title of a newly registered project. */
  readonly title: string
  /**
   * Existing directory to own, in a fully qualified path spelling. Omitted
   * registers a project in the project store's own project root; a repeated
   * canonical path resolves the existing registration instead of creating one.
   */
  readonly path?: string
}

/** The project identity whose registry record changed. */
export interface WorkspaceChanged {
  readonly workspaceId: WorkspaceId
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    workspaceRegistry: WorkspaceRegistry
  }

  interface Events {
    /**
     * Ask the composed providers what still runs for a session before it is
     * archived. A listener prepends its own {@link SessionActivity} entries to
     * the result of `next()`; the registry's innermost callback returns an
     * empty list, so a composition without providers archives freely. Any
     * non-empty result refuses the archive without a write.
     * @param request - the session about to be archived.
     * @param next - delegate to the remaining providers.
     * @mode waterfall
     */
    'workspace/session-activity'(
      request: SessionActivityRequest,
      next: () => Promise<readonly SessionActivity[]>,
    ): Promise<readonly SessionActivity[]>
    /**
     * Stop a session's running work because the caller archived it with
     * `stopActivity`; the archive set is durable when this dispatches. Each
     * provider stops its own families — cancelling a turn, its subagent
     * descendants, owned jobs, or active schedules — through the same cancel
     * paths the user's own stop actions use, so the session log ends every
     * open turn regularly and a later unarchive can continue the
     * conversation. Listeners issue their stop requests without waiting for
     * running work to settle; a listener may await its own durability
     * barrier. A rejection is logged by the registry and does not undo the
     * archive.
     * @param request - the session being archived.
     * @mode parallel
     */
    'workspace/session-stop'(request: SessionActivityRequest): Promise<void> | void
    /**
     * One workspace projection changed: a rename replaced the project title, or
     * a committed session-account write replaced its members. The entity that
     * commits the change has already published it, so a listener reads the new
     * value from the registry. Change streams use this instead of waiting for
     * the durable write they may observe before the snapshot moves.
     * @param change - the workspace whose projection changed.
     * @mode emit
     */
    'workspace/changed'(change: WorkspaceChanged): void
  }
}

interface BootstrapGroup {
  readonly path: string
  readonly headers: SessionHeader[]
  readonly newestAt: number
}

const sameIds = (left: readonly ProjectId[], right: readonly ProjectId[]): boolean =>
  left.length === right.length && left.every((id, index) => id === right[index])

const compareHeaders = (left: SessionHeader, right: SessionHeader): number =>
  right.createdAt - left.createdAt || String(left.id).localeCompare(String(right.id))

/**
 * Durable workspace registry over the project store and the session-account
 * domain. Startup waits for `sessionPersistence` and `mwfProjectStore`, imports
 * the legacy v2 registry once, completes the one-time grouping bootstrap, and
 * reconciles its display order with the registered projects before the service
 * becomes active. Both dependencies are mandatory so an unavailable peer can
 * never be mistaken for an empty history.
 */
export class WorkspaceRegistry extends Service {
  static inject = ['storageDomain', 'sessionPersistence', 'mwfProjectStore']

  private table?: KvTable<ProjectId, WorkspaceGroupRecord>
  private global?: DomainGlobal<WorkspaceProjectState>
  private state?: WorkspaceProjectState
  private readonly projects = new Map<ProjectId, ProjectRecord>()
  private readonly entities = new Map<ProjectId, WorkspaceEntity>()
  private readonly headers = new Map<SessionId, SessionHeader>()
  private readonly sessionPaths = new Map<SessionId, string>()
  private readonly missingSessionPaths = new Set<SessionId>()
  private readonly invalidSessionPaths = new Map<SessionId, string>()
  private operationTail: Promise<void> = Promise.resolve()

  private readonly host: WorkspaceEntityHost = {
    renameProject: async (id, title) => {
      const record = await this.ctx.mwfProjectStore.renameProject(id, title)
      this.projects.set(id, record)
      return record
    },
    projectChanged: (id) => {
      this.ctx.emit('workspace/changed', { workspaceId: id })
    },
    groupTable: () => this.requireTable(),
    candidateMatches: (id, path) => this.sessionPaths.get(id) === path || this.missingSessionPaths.has(id),
    readSessionHeader: id => this.readSessionHeader(id),
    rememberSessionPath: (id, path) => {
      this.sessionPaths.set(id, path)
      this.missingSessionPaths.delete(id)
      this.invalidSessionPaths.delete(id)
    },
  }

  constructor(ctx: Context) {
    super(ctx, 'workspaceRegistry')
  }

  /** Open the domain, import or bootstrap once, reconcile, and rebuild the ordered cache. */
  protected async [Service.init](): Promise<void> {
    const domain = await this.ctx.storageDomain.open(workspaceDomainSpec)
    this.ctx.effect(() => () => domain.close(), 'workspace.domainClose')
    this.table = domain.table('projects')
    this.global = domain.global
    this.state = domain.global.get()

    await this.loadProjects()
    await this.importLegacyRegistry()
    if (!this.requireState().initialized) {
      const headers = await this.listStoredHeaders()
      await this.replaceHeaderIndex(headers)
      await this.bootstrap(headers)
    } else if (this.table.size > 0) {
      await this.replaceHeaderIndex(await this.listStoredHeaders())
    }

    await this.reconcile()
    await this.indexLiveSessions()
    this.validateStoredState()
    this.rebuildEntities()
    this.reportFilteredCandidates()
  }

  /**
   * Create or reuse a workspace for an existing directory. The fully qualified
   * path is canonicalized through `fs.realpath`; a relative, nonexistent, or
   * non-directory path rejects. Repeated calls for the same canonical path
   * return the existing entity without changing its title.
   * A newly created workspace is prepended to the durable display order.
   * Different canonical paths may share a display title.
   * @param path - Existing directory to own, in a fully qualified path spelling.
   * @param title - Display title used only when a new project is registered.
   * @returns the existing or newly durable workspace.
   */
  create(path: string, title?: string): Promise<Workspace> {
    return this.enqueueOperation(async () => {
      const canonical = await this.canonicalDirectory(path)
      return await this.createProjectCanonical(canonical, title ?? defaultWorkspaceTitle(canonical), false)
    })
  }

  /**
   * Register one workflow project and its session group.
   *
   * Identity comes from the project store, which also rejects a directory
   * another project already claims; a registration racing this call for the
   * same directory resolves the winner instead of failing. A repeated
   * canonical path returns the existing workspace without retitling it.
   * @param request - title and optional existing project directory.
   * @returns the existing or newly registered workspace.
   */
  createProject(request: CreateWorkspaceProjectRequest): Promise<Workspace> {
    const requestedPath = request.path
    return this.enqueueOperation(async () => {
      const canonical = requestedPath === undefined ? undefined : await this.canonicalDirectory(requestedPath)
      return await this.createProjectCanonical(canonical, request.title, false)
    })
  }

  /**
   * Initialize the default Workspace only while both the registry and Session
   * history are empty. Repeated requests reuse its durable identity; deleting
   * that registration permanently disables automatic creation.
   * @param resolveDirectory - resolve the absolute directory; called only for
   * eligible creation, inside the registry mutation queue. Missing directories
   * are created recursively before registration, and the initial title is the
   * requested directory's own final segment — not the canonical one, so a
   * symlink at that path does not retitle the Workspace after its target.
   * After resolution, caller cancellation does not roll back creation or registration.
   * @returns the initialized Workspace, or undefined when automatic creation is ineligible.
   */
  initializeDefault(resolveDirectory: () => Promise<string>): Promise<Workspace | undefined> {
    return this.enqueueOperation(async () => {
      const state = this.requireState()
      if (state.defaultProjectId !== undefined) return this.entities.get(state.defaultProjectId)
      const sessions = this.ctx.get('sessions')
      if (sessions === undefined) throw new Error('default Workspace initialization requires the Session store')
      if (state.projectIds.length > 0 || this.projects.size > 0 || state.archivedSessionIds.length > 0
        || sessions.list().length > 0 || (await this.listStoredHeaders()).length > 0) return undefined

      const path = await resolveDirectory()
      if (!fullyQualifiedWorkspacePath(path)) throw new TypeError(`Workspace path is not fully qualified: '${path}'`)
      await mkdir(path, { recursive: true })
      const canonical = await realpathNormalize(path)
      // A Session can start outside the registry queue while directory preparation awaits I/O.
      if ((await this.listStoredHeaders()).length > 0 || sessions.list().length > 0) return undefined
      return this.createProjectCanonical(canonical, defaultWorkspaceTitle(path), true)
    })
  }

  /**
   * Look up a workspace by id.
   * @param id - Workspace id.
   * @returns the workspace, or `undefined` when unknown.
   */
  get(id: WorkspaceId): Workspace | undefined {
    return this.entities.get(id)
  }

  /**
   * Synchronous workspace projection in durable display order. An entry whose
   * project registration is gone is skipped: the project store owns existence,
   * and the next startup reconciles the durable order. Every entity's
   * `sessionIds` getter is already filtered by the startup/live canonical-cwd
   * header index, so this method performs no persistence reads.
   * @returns a fresh ordered array of workspace entities.
   */
  list(): Workspace[] {
    return this.visibleOrder().map(id => this.requireEntity(id))
  }

  /**
   * Delete one workspace registration while retaining its directory and every
   * session log. The project registry row is removed first; the durable order
   * and session account follow, and a follow-up write that still fails is
   * logged because the requested state is already true — the next startup
   * reconciles both.
   * @param id - Workspace registration to remove.
   * @returns `true` when a registration was deleted, `false` when it was unknown.
   */
  delete(id: WorkspaceId): Promise<boolean> {
    return this.enqueueOperation(() => this.deleteKnown(id))
  }

  /**
   * Move one workspace within the durable display order, DOM-insertBefore-like.
   * With an anchor it lands before that workspace; without one it appends.
   * @param id - Workspace to move.
   * @param beforeId - Workspace anchor; omitted appends.
   * @returns the complete committed workspace order.
   */
  insertBefore(id: WorkspaceId, beforeId?: WorkspaceId): Promise<readonly WorkspaceId[]> {
    return this.enqueueOperation(async () => {
      const state = this.requireState()
      const order = this.visibleOrder()
      if (!order.includes(id)) throw new WorkspaceOrderInvalidError(id)
      if (beforeId !== undefined && !order.includes(beforeId)) {
        throw new WorkspaceOrderInvalidError(beforeId)
      }
      if (beforeId === id) return order
      const without = order.filter(workspaceId => workspaceId !== id)
      const at = beforeId === undefined ? without.length : without.indexOf(beforeId)
      const projectIds = [...without.slice(0, at), id, ...without.slice(at)]
      if (sameIds(projectIds, state.projectIds)) return projectIds
      await this.setState({ ...state, projectIds })
      return projectIds
    })
  }

  /**
   * The registry-global archive set: sessions hidden from every grouping
   * surface. Archiving never touches project accounting — an archived
   * session keeps its `sessionIds` slot so unarchiving restores its position.
   * @returns the archived session ids in archive order.
   */
  get archivedSessionIds(): readonly SessionId[] {
    return this.requireState().archivedSessionIds
  }

  /**
   * Archive one session durably. The session must exist (live or in session
   * persistence); its project accounting — or lack of one — is irrelevant.
   * Without `stopActivity` the session must also be inactive: the
   * `workspace/session-activity` waterfall is asked once, and any reported
   * activity rejects with {@link WorkspaceActiveSessionError} before anything
   * is written. With `stopActivity` the archive is written without an
   * activity check, and the `workspace/session-stop` providers are then asked
   * to stop the session's work: the durable archive set is what a provider's
   * `agent/pre-step` gate reads, so every wake the stops induce is already
   * blocked. Archiving drops the session's pin in the same durable write
   * (pinning and archival are mutually exclusive). An already archived id
   * resolves without writing, asking, or stopping.
   * @param sessionId - The session to archive.
   * @param options - Whether running work is stopped instead of refusing.
   * @returns resolution after durability and, with `stopActivity`, after every stop request was issued.
   */
  archiveSession(sessionId: SessionId, options: ArchiveSessionOptions = {}): Promise<void> {
    return this.enqueueOperation(async () => {
      // The chain slot serializes against every other registry write, so this
      // check-then-write pair cannot interleave with another archive.
      if (this.requireState().archivedSessionIds.includes(sessionId)) return
      if (!(await this.sessionKnown(sessionId))) {
        throw new WorkspaceUnknownSessionError(sessionId, 'archive')
      }
      if (options.stopActivity !== true) {
        const activity = await this.ctx.waterfall(
          'workspace/session-activity', { sessionId }, () => Promise.resolve([]),
        )
        if (activity.length > 0) throw new WorkspaceActiveSessionError(sessionId, activity)
      }
      const state = this.requireState()
      await this.setState({
        ...state,
        archivedSessionIds: [...state.archivedSessionIds, sessionId],
        pinnedSessionIds: state.pinnedSessionIds.filter(id => id !== sessionId),
      })
      if (options.stopActivity === true) await this.stopSessionActivity(sessionId)
    })
  }

  /**
   * Unarchive one session durably by dropping it from the registry-global
   * archive set; the accounting slot was never touched, so the session
   * returns to its recorded position. Unarchiving runs no session-existence
   * check because removing an id cannot introduce an unknown one, so an
   * entry whose session is gone still resolves. An id that is not archived
   * resolves without writing.
   * @param sessionId - The session to unarchive.
   * @returns resolution after durability.
   */
  unarchiveSession(sessionId: SessionId): Promise<void> {
    return this.enqueueOperation(async () => {
      // The chain slot serializes against every other registry write, so this
      // check-then-write pair cannot interleave with a concurrent archive.
      const state = this.requireState()
      if (!state.archivedSessionIds.includes(sessionId)) return
      await this.setState({
        ...state,
        archivedSessionIds: state.archivedSessionIds.filter(id => id !== sessionId),
      })
    })
  }

  /**
   * The registry-global pin set: sessions surfaced ahead of every unpinned
   * session on grouping surfaces. Pinning never touches project accounting.
   * @returns Session ids in pin order (most recently pinned first).
   */
  get pinnedSessionIds(): readonly SessionId[] {
    return this.requireState().pinnedSessionIds
  }

  /**
   * Pin one session durably, prepending it to the registry-global pin set.
   * The session must exist (live or in session persistence) and must not be
   * archived. An already pinned id resolves without writing or reordering.
   * @param sessionId - The session to pin.
   * @returns resolution after durability.
   */
  pinSession(sessionId: SessionId): Promise<void> {
    return this.enqueueOperation(async () => {
      // The chain slot serializes against every other registry write, so this
      // check-then-write pair cannot interleave with another pin or archive.
      if (this.requireState().pinnedSessionIds.includes(sessionId)) return
      if (this.requireState().archivedSessionIds.includes(sessionId)) {
        throw new WorkspaceArchivedSessionPinError(sessionId)
      }
      if (!(await this.sessionKnown(sessionId))) {
        throw new WorkspaceUnknownSessionError(sessionId, 'pin')
      }
      const state = this.requireState()
      await this.setState({
        ...state,
        pinnedSessionIds: [sessionId, ...state.pinnedSessionIds],
      })
    })
  }

  /**
   * Unpin one session durably by dropping it from the registry-global pin
   * set. Unpinning runs no session-existence check because removing an id
   * cannot introduce an unknown one, so an entry whose session is gone still
   * resolves. An id that is not pinned resolves without writing.
   * @param sessionId - The session to unpin.
   * @returns resolution after durability.
   */
  unpinSession(sessionId: SessionId): Promise<void> {
    return this.enqueueOperation(async () => {
      // The chain slot serializes against every other registry write, so this
      // check-then-write pair cannot interleave with a concurrent pin.
      const state = this.requireState()
      if (!state.pinnedSessionIds.includes(sessionId)) return
      await this.setState({
        ...state,
        pinnedSessionIds: state.pinnedSessionIds.filter(id => id !== sessionId),
      })
    })
  }

  /**
   * Resolve one workspace by canonical directory path without creating or
   * mutating a registration. A missing path rejects during `realpath`; an
   * existing unowned directory returns `undefined`.
   * @param path - Existing directory path in a fully qualified spelling.
   * @returns the workspace owning the canonical path, when one exists.
   */
  async resolveByPath(path: string): Promise<Workspace | undefined> {
    const canonical = await realpathNormalize(path)
    const project = this.projectByPath(canonical)
    return project === undefined ? undefined : this.entities.get(project.id)
  }

  /** Whether a session is live, header-indexed, or present in a fresh persistence listing. */
  private async sessionKnown(id: SessionId): Promise<boolean> {
    if (this.ctx.get('sessions')?.get(id) !== undefined) return true
    if (this.headers.has(id)) return true
    await this.indexHeaders(await this.listStoredHeaders())
    return this.headers.has(id)
  }

  /** Request every provider's stop; a failing provider is logged, never a reason to keep the session visible. */
  private async stopSessionActivity(sessionId: SessionId): Promise<void> {
    try {
      await this.ctx.parallel('workspace/session-stop', { sessionId })
    } catch (error: unknown) {
      // ctx.parallel settles every listener and rejects with one AggregateError.
      /* v8 ignore next -- the plain arm guards a rethrowing dispatcher. */
      const failures = error instanceof AggregateError ? error.errors : [error]
      for (const failure of failures) {
        this.ctx.logger.warn(`workspace: stopping session '${sessionId}' for archive failed: ${String(failure)}`)
      }
    }
  }

  /**
   * Import the shipped v2 `workspace` domain once: every stored workspace
   * becomes a project registration (reusing a project that already claims its
   * directory), its session account moves to the project, and the default
   * identity plus the global session sets carry over. The legacy medium is
   * opened read-only and closed; it is never rewritten or deleted.
   *
   * Idempotent and re-entrant: a project directory already registered is
   * reused rather than duplicated, a session account is rebuilt from the same
   * legacy record, and `migratedFromV2` is written only after every project and
   * account is durable. A crash anywhere before that write repeats the same
   * work on the next start.
   */
  private async importLegacyRegistry(): Promise<void> {
    const state = this.requireState()
    if (state.migratedFromV2) return
    const legacy = await this.ctx.storageDomain.open(legacyWorkspaceDomainSpec)
    let records: [string, LegacyWorkspaceRecord][]
    let legacyState: LegacyWorkspaceState
    try {
      records = [...legacy.table('workspaces').entries()]
      legacyState = legacy.global.get()
    } finally {
      await legacy.close()
    }

    const byLegacyId = new Map(records)
    const ordered: [string, LegacyWorkspaceRecord][] = []
    for (const legacyId of legacyState.workspaceIds) {
      const record = byLegacyId.get(legacyId)
      if (record === undefined) continue
      ordered.push([legacyId, record])
      byLegacyId.delete(legacyId)
    }
    for (const entry of [...byLegacyId].sort(([, left], [, right]) =>
      left.createdAt.localeCompare(right.createdAt))) ordered.push(entry)

    const migrated: ProjectId[] = []
    const legacyToProject = new Map<string, ProjectId>()
    const accounted = new Set<SessionId>()
    for (const [legacyId, record] of ordered) {
      const project = await this.adoptProject(record.path, record.title)
      legacyToProject.set(legacyId, project.id)
      const current = this.requireTable().get(project.id)
      const sessionIds = [...(current?.sessionIds ?? [])]
      for (const sessionId of record.sessionIds) {
        if (accounted.has(sessionId) || sessionIds.includes(sessionId)) continue
        sessionIds.push(sessionId)
      }
      for (const sessionId of sessionIds) accounted.add(sessionId)
      if (current === undefined || sessionIds.length !== current.sessionIds.length) {
        await this.requireTable().put(project.id, {
          sessionIds,
          updatedAt: Date.parse(record.updatedAt) || Date.now(),
        })
      }
      if (!migrated.includes(project.id)) migrated.push(project.id)
    }

    const defaultProjectId = legacyState.defaultWorkspaceId === undefined
      ? state.defaultProjectId
      : legacyToProject.get(legacyState.defaultWorkspaceId) ?? state.defaultProjectId
    await this.setState({
      initialized: legacyState.initialized,
      migratedFromV2: true,
      ...defaultProjectId === undefined ? {} : { defaultProjectId },
      projectIds: [...migrated, ...state.projectIds.filter(id => !migrated.includes(id))],
      archivedSessionIds: mergeSessionIds(state.archivedSessionIds, legacyState.archivedSessionIds),
      pinnedSessionIds: mergeSessionIds(state.pinnedSessionIds, legacyState.pinnedSessionIds),
    })
  }

  /**
   * Account the stored session history by canonical cwd the first time a
   * profile starts without one. Each cwd group becomes a project registration
   * in newest-session order; already-accounted sessions are never re-homed, so
   * a partially completed bootstrap repeats safely.
   */
  private async bootstrap(headers: readonly SessionHeader[]): Promise<void> {
    const groupsByPath = new Map<string, SessionHeader[]>()
    for (const header of headers) {
      const path = this.sessionPaths.get(header.id)
      if (path === undefined) continue
      const group = groupsByPath.get(path)
      if (group === undefined) groupsByPath.set(path, [header])
      else group.push(header)
    }
    const groups: BootstrapGroup[] = [...groupsByPath].map(([path, groupHeaders]) => {
      groupHeaders.sort(compareHeaders)
      const newest = groupHeaders[0] as SessionHeader
      return { path, headers: groupHeaders, newestAt: newest.createdAt }
    }).sort((left, right) =>
      right.newestAt - left.newestAt || left.path.localeCompare(right.path))

    const accounted = this.accountedSessions()
    const created: ProjectId[] = []
    for (const group of groups) {
      const existing = this.projectByPath(group.path)
      const sessionIds = group.headers
        .map(header => header.id)
        .filter(sessionId => !accounted.has(sessionId))
      if (sessionIds.length === 0) continue
      const project = existing ?? await this.adoptProject(group.path, defaultWorkspaceTitle(group.path))
      const current = this.requireTable().get(project.id)
      const merged = [...sessionIds, ...(current?.sessionIds ?? [])]
      await this.requireTable().put(project.id, {
        sessionIds: merged,
        updatedAt: Date.now(),
      })
      for (const sessionId of sessionIds) accounted.add(sessionId)
      if (existing === undefined) created.push(project.id)
    }

    const state = this.requireState()
    await this.setState({
      ...state,
      initialized: true,
      projectIds: [...created, ...state.projectIds.filter(id => !created.includes(id))],
    })
  }

  /**
   * Make the durable order and the session accounts agree with the project
   * registry, which owns existence: an account whose project row is gone is
   * dropped, a registered project without an account starts empty, and the
   * order lists exactly the registered projects — keeping the durable relative
   * order and prepending projects registered outside this registry.
   */
  private async reconcile(): Promise<void> {
    const table = this.requireTable()
    for (const id of [...table.keys()]) {
      if (!this.projects.has(id)) await table.delete(id)
    }
    for (const project of this.projects.values()) {
      if (table.get(project.id) === undefined) {
        await table.put(project.id, { sessionIds: [], updatedAt: Date.now() })
      }
    }

    const state = this.requireState()
    const ordered = new Set<ProjectId>()
    const projectIds: ProjectId[] = []
    for (const id of state.projectIds) {
      if (!this.projects.has(id) || ordered.has(id)) continue
      ordered.add(id)
      projectIds.push(id)
    }
    const unlisted = [...this.projects.values()]
      .filter(project => !ordered.has(project.id))
      .sort((left, right) => right.createdAt - left.createdAt || String(left.id).localeCompare(String(right.id)))
      .map(project => project.id)
    const next: ProjectId[] = [...unlisted, ...projectIds]
    if (!sameIds(next, state.projectIds)) await this.setState({ ...state, projectIds: next })
  }

  /** Fail loud on the one invariant the registry itself maintains; existence and order are reconciled. */
  private validateStoredState(): void {
    const accounted = new Map<SessionId, ProjectId>()
    for (const [id, group] of this.requireTable().entries()) {
      for (const sessionId of group.sessionIds) {
        const holder = accounted.get(sessionId)
        if (holder !== undefined) {
          throw new Error(
            `workspace domain is inconsistent: session '${sessionId}' is accounted `
            + `by both workspace '${holder}' and workspace '${id}'`,
          )
        }
        accounted.set(sessionId, id)
      }
    }
  }

  /** Canonical existing directory for one requested project path; anything else rejects. */
  private async canonicalDirectory(path: string): Promise<string> {
    const canonical = await realpathNormalize(path)
    if (!(await stat(canonical)).isDirectory()) {
      throw new Error(`cannot create a workspace at '${canonical}': path is not a directory`)
    }
    return canonical
  }

  /** Register one project and its group, or reuse the registration that already claims the directory. */
  private async createProjectCanonical(
    canonical: string | undefined,
    title: string,
    firstUse: boolean,
  ): Promise<WorkspaceEntity> {
    if (canonical !== undefined) {
      const existing = this.projectByPath(canonical)
      if (existing !== undefined) return this.requireEntity(existing.id)
    }

    const record = await this.registerProject(canonical === undefined
      ? { title }
      : { title, path: canonical })
    this.projects.set(record.id, record)
    let groupWritten = false
    let entity: WorkspaceEntity
    try {
      await this.requireTable().put(record.id, { sessionIds: [], updatedAt: Date.now() })
      groupWritten = true
      // Published before the order write so a change listener observes the new
      // project while handling that write.
      entity = new WorkspaceEntity(this.host, record.id, record, this.requireGroup(record.id))
      this.entities.set(record.id, entity)
      const state = this.requireState()
      await this.setState({
        ...state,
        initialized: true,
        ...(firstUse ? { defaultProjectId: record.id } : {}),
        projectIds: [record.id, ...state.projectIds.filter(id => id !== record.id)],
      })
    } catch (error) {
      this.projects.delete(record.id)
      this.entities.delete(record.id)
      const failures: unknown[] = [error]
      if (groupWritten) {
        try {
          await this.requireTable().delete(record.id)
        } catch (rollbackError) {
          failures.push(rollbackError)
        }
      }
      try {
        await this.ctx.mwfProjectStore.removeProject(record.id)
      /* v8 ignore start -- a failed registry-row delete is a storage fault the store reports itself. */
      } catch (rollbackError) {
        failures.push(rollbackError)
      }
      /* v8 ignore stop */
      if (failures.length > 1) {
        throw new AggregateError(
          failures,
          `workspace '${record.id}' registration rollback did not complete; its directory is kept`,
        )
      }
      throw error
    }
    return entity
  }

  /** Register a project in the project store, resolving the registration that won a racing create for the same directory. */
  private async registerProject(request: CreateProjectRequest): Promise<ProjectRecord> {
    try {
      return await this.ctx.mwfProjectStore.createProject(request)
    } catch (error) {
      if (!(error instanceof WorkflowProjectStoreError) || error.code !== 'project-path-in-use') throw error
      const requestedPath = request.path
      /* v8 ignore next -- a path-less registration allocates its own directory and cannot collide. */
      if (requestedPath === undefined) throw error
      await this.loadProjects()
      const winner = this.projectByPath(requestedPath)
      /* v8 ignore next -- a caller only reaches `project-path-in-use` when a row claims that directory. */
      if (winner === undefined) throw error
      return winner
    }
  }

  /** Register the project a legacy record or a bootstrap group names, or reuse the one that owns the directory. */
  private async adoptProject(path: string, title: string): Promise<ProjectRecord> {
    const existing = this.projectByPath(path)
    if (existing !== undefined) return existing
    const record = await this.registerProject({ title, path })
    this.projects.set(record.id, record)
    return record
  }

  /** Delete one registration; the directory and every session log stay. */
  private async deleteKnown(id: ProjectId): Promise<boolean> {
    if (!this.projects.has(id)) return false
    await this.ctx.mwfProjectStore.removeProject(id)
    this.projects.delete(id)
    this.entities.delete(id)
    const state = this.requireState()
    try {
      await this.setState({ ...state, projectIds: state.projectIds.filter(projectId => projectId !== id) })
    } catch (error) {
      // The requested state is already true; the next startup reconciles the order.
      this.ctx.logger.warn(`workspace '${id}' was deleted but its display order could not be updated: ${String(error)}`)
    }
    try {
      await this.requireTable().delete(id)
    } catch (error) {
      this.ctx.logger.warn(`workspace '${id}' was deleted but its session account could not be removed: ${String(error)}`)
    }
    return true
  }

  /** Reload every registered project, newest first, as the registry's identity cache. */
  private async loadProjects(): Promise<void> {
    this.projects.clear()
    for (const record of await this.ctx.mwfProjectStore.listProjects()) {
      this.projects.set(record.id, record)
    }
  }

  /** The durable display order restricted to registered projects. */
  private visibleOrder(): ProjectId[] {
    return this.requireState().projectIds.filter(id => this.projects.has(id))
  }

  private projectByPath(path: string): ProjectRecord | undefined {
    for (const project of this.projects.values()) {
      if (project.path === path) return project
    }
    return undefined
  }

  private accountedSessions(): Set<SessionId> {
    const accounted = new Set<SessionId>()
    for (const [, group] of this.requireTable().entries()) {
      for (const sessionId of group.sessionIds) accounted.add(sessionId)
    }
    return accounted
  }

  private rebuildEntities(): void {
    this.entities.clear()
    for (const id of this.visibleOrder()) {
      this.entities.set(id, new WorkspaceEntity(
        this.host, id, this.requireProject(id), this.requireGroup(id),
      ))
    }
  }

  private async replaceHeaderIndex(headers: readonly SessionHeader[]): Promise<void> {
    this.headers.clear()
    this.sessionPaths.clear()
    this.missingSessionPaths.clear()
    this.invalidSessionPaths.clear()
    await this.indexHeaders(headers)
  }

  private async indexHeaders(headers: readonly SessionHeader[]): Promise<void> {
    for (const header of headers) await this.indexHeader(header)
  }

  private async indexHeader(header: SessionHeader): Promise<void> {
    this.headers.set(header.id, header)
    this.sessionPaths.delete(header.id)
    this.missingSessionPaths.delete(header.id)
    if (header.cwd === undefined) {
      this.invalidSessionPaths.set(header.id, 'header has no cwd')
      return
    }
    try {
      const path = await realpathNormalize(header.cwd)
      if (!(await stat(path)).isDirectory()) {
        this.invalidSessionPaths.set(header.id, `cwd '${header.cwd}' is not a directory`)
        return
      }
      this.sessionPaths.set(header.id, path)
      this.invalidSessionPaths.delete(header.id)
    } catch (error) {
      if (fullyQualifiedWorkspacePath(header.cwd)
        && error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        this.missingSessionPaths.add(header.id)
      }
      this.invalidSessionPaths.set(header.id, `cwd '${header.cwd}' does not resolve`)
    }
  }

  /** Every stored session's header, projected from the persistence snapshot listing. */
  private async listStoredHeaders(): Promise<SessionHeader[]> {
    const snapshots = await this.ctx.sessionPersistence.list()
    return snapshots.map(snapshot => snapshot.header)
  }

  private async indexLiveSessions(): Promise<void> {
    const sessions = this.ctx.get('sessions')
    if (sessions === undefined) return
    await this.indexHeaders(sessions.list().map(session => session.header))
  }

  private reportFilteredCandidates(): void {
    for (const entity of this.entities.values()) {
      const project = this.requireProject(entity.id)
      const group = this.requireGroup(entity.id)
      for (const sessionId of group.sessionIds) {
        if (this.host.candidateMatches(sessionId, project.path)) continue
        const path = this.sessionPaths.get(sessionId)
        const reason = this.invalidSessionPaths.get(sessionId)
          ?? (this.headers.has(sessionId)
            ? `canonical cwd '${path}' differs from workspace path '${project.path}'`
            : 'session header is missing')
        this.ctx.logger.warn(
          `workspace '${entity.id}' filtered session '${sessionId}' from membership: ${reason}`,
        )
      }
    }
  }

  private async readSessionHeader(id: SessionId): Promise<SessionHeader> {
    const live = this.ctx.get('sessions')?.get(id)
    if (live !== undefined) {
      this.headers.set(id, live.header)
      return live.header
    }
    const cached = this.headers.get(id)
    if (cached !== undefined) return cached

    const headers = await this.listStoredHeaders()
    await this.indexHeaders(headers)
    const header = this.headers.get(id)
    if (header === undefined) {
      throw new Error(`cannot validate session '${id}': session persistence holds no such session`)
    }
    return header
  }

  private requireEntity(id: ProjectId): WorkspaceEntity {
    const entity = this.entities.get(id)
    /* v8 ignore next -- the visible order and the entity cache are rebuilt from one project snapshot. */
    if (entity === undefined) throw new Error(`workspace registry order references missing workspace '${id}'`)
    return entity
  }

  private requireProject(id: ProjectId): ProjectRecord {
    const project = this.projects.get(id)
    /* v8 ignore next -- callers name ids the visible order already filtered to registered projects. */
    if (project === undefined) throw new Error(`workspace '${id}' has no registered project`)
    return project
  }

  private requireGroup(id: ProjectId): WorkspaceGroupRecord {
    const group = this.requireTable().get(id)
    /* v8 ignore next -- startup reconciliation materializes one account per registered project. */
    if (group === undefined) throw new Error(`workspace '${id}' has no session account`)
    return group
  }

  private requireTable(): KvTable<ProjectId, WorkspaceGroupRecord> {
    /* v8 ignore next -- the service publishes only after its initialization await. */
    if (this.table === undefined) throw new Error('workspace registry is not started yet')
    return this.table
  }

  private requireState(): WorkspaceProjectState {
    /* v8 ignore next -- the service publishes only after its initialization await. */
    if (this.state === undefined) throw new Error('workspace registry is not started yet')
    return this.state
  }

  private async setState(state: WorkspaceProjectState): Promise<void> {
    await (this.global as DomainGlobal<WorkspaceProjectState>).set(state)
    this.state = state
  }

  private enqueueOperation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationTail.then(operation)
    this.operationTail = result.then(() => {}, () => {})
    return result
  }
}

/** Union two ordered id lists, keeping the first list's order and appending unseen ids. */
function mergeSessionIds(left: readonly SessionId[], right: readonly SessionId[]): SessionId[] {
  const merged = [...left]
  for (const id of right) {
    if (!merged.includes(id)) merged.push(id)
  }
  return merged
}

export default WorkspaceRegistry
