/**
 * Package-private workspace entity: the single {@link Workspace}
 * implementation. Holds the project registry record plus a session-account
 * snapshot that is swapped in place after each durable mutation; every write
 * funnels through the private `mutate` so `updatedAt` stamping and
 * invalid-account pruning happen exactly once.
 * Not re-exported from the package entrypoint — consumers see only the
 * `Workspace` interface.
 * @module @metaworkflow/workspace/src/entity
 */

import { stat } from 'node:fs/promises'
import type { SessionHeader, SessionId } from '@metaworkflow/session'
import type { KvTable } from '@metaworkflow/storage-domain'
import type { ProjectId, ProjectRecord } from '@metaworkflow/workflow-project-store'
import type { WorkspaceGroupRecord } from './spec.ts'
import type { Workspace } from './types.ts'
import { realpathNormalize } from './paths.ts'

/** An insertSessionBefore request named a session or anchor not on the account (storage failures stay plain errors). */
export class WorkspaceMoveInvalidError extends Error {
  /**
   * @param message - Which id was unaccounted and where.
   */
  constructor(message: string) {
    super(message)
    this.name = 'WorkspaceMoveInvalidError'
  }
}

/**
 * The registry-owned machinery an entity mutates through. Entities never see
 * the registry itself — only the project registry reads, the open
 * session-account table, the canonical session-path index backing the
 * `sessionIds` projection, and attach-time header reads.
 */
export interface WorkspaceEntityHost {
  /**
   * Replace one project's display title in the project registry.
   * @param id - The entity's project id.
   * @param title - The new display title.
   * @returns the updated registry record.
   */
  renameProject(id: ProjectId, title: string): Promise<ProjectRecord>

  /**
   * Announce that one workspace projection changed, after the entity published
   * its own snapshot so a listener reads the committed value.
   * @param id - The workspace whose projection changed.
   */
  projectChanged(id: ProjectId): void

  /**
   * Resolve the open session-account table.
   * @returns the table; throws while the registry has not started yet.
   */
  groupTable(): KvTable<ProjectId, WorkspaceGroupRecord>

  /**
   * Validate an already-accounted session, preserving ownership when its fully
   * qualified cwd cannot resolve because a path component is missing.
   * @param id - Session already present in this project's candidate account.
   * @param path - Project's canonical directory.
   * @returns whether the candidate remains a member.
   */
  candidateMatches(id: SessionId, path: string): boolean

  /**
   * Read one stored session header for attach validation.
   * @param id - The session whose header to read.
   * @returns the header; rejects when session persistence is absent or holds
   * no session with this id.
   */
  readSessionHeader(id: SessionId): Promise<SessionHeader>

  /**
   * Publish a successfully validated canonical cwd to the projection index.
   * @param id - Validated session id.
   * @param path - Canonical existing directory from the immutable header cwd.
   */
  rememberSessionPath(id: SessionId, path: string): void
}

/** Chain-slot abort sentinel thrown by the update fn when the record needs no change; only `mutate` observes it. */
const unchangedSentinel = new Error('workspace session account unchanged (internal sentinel)')

/** The single {@link Workspace} implementation; constructed only by the registry. */
export class WorkspaceEntity implements Workspace {
  private group: WorkspaceGroupRecord
  private record: ProjectRecord

  /**
   * @param host - Registry-owned project reads, session-account table, session-path index, and header reads.
   * @param id - The project's stable id.
   * @param record - The validated project registry record.
   * @param group - The validated session-account snapshot loaded or just written.
   */
  constructor(
    private readonly host: WorkspaceEntityHost,
    readonly id: ProjectId,
    record: ProjectRecord,
    group: WorkspaceGroupRecord,
  ) {
    this.record = record
    this.group = group
  }

  get path(): string {
    return this.record.path
  }

  get title(): string {
    return this.record.title
  }

  get createdAt(): string {
    return new Date(this.record.createdAt).toISOString()
  }

  get updatedAt(): string {
    return new Date(Math.max(this.record.updatedAt, this.group.updatedAt)).toISOString()
  }

  get sessionIds(): readonly SessionId[] {
    return this.group.sessionIds.filter(id => this.host.candidateMatches(id, this.record.path))
  }

  async setTitle(title: string): Promise<void> {
    this.record = await this.host.renameProject(this.id, title)
    this.host.projectChanged(this.id)
  }

  async attachSession(sessionId: SessionId): Promise<void> {
    // Validation is skipped when the settled snapshot already accounts the
    // id: the cwd fact was checked when it first attached and both inputs
    // (stored header cwd, project directory) are immutable. Membership itself
    // is decided on the write chain inside `mutate`, never on this snapshot.
    if (!this.group.sessionIds.includes(sessionId)) {
      const header = await this.host.readSessionHeader(sessionId)
      if (header.cwd === undefined) {
        throw new Error(
          `cannot attach session '${sessionId}' to workspace '${this.record.path}': `
          + 'its stored header carries no cwd to validate against',
        )
      }
      let cwd: string
      try {
        cwd = await realpathNormalize(header.cwd)
      } catch (error) {
        throw new Error(
          `cannot attach session '${sessionId}' to workspace '${this.record.path}': `
          + `its cwd '${header.cwd}' does not resolve, so it cannot be validated`,
          { cause: error },
        )
      }
      if (!(await stat(cwd)).isDirectory()) {
        throw new Error(
          `cannot attach session '${sessionId}' to workspace '${this.record.path}': `
          + `its cwd '${header.cwd}' is not a directory`,
        )
      }
      if (cwd !== this.record.path) {
        throw new Error(
          `cannot attach session '${sessionId}' to workspace '${this.record.path}': `
          + `its cwd resolves to '${cwd}'`,
        )
      }
      this.host.rememberSessionPath(sessionId, cwd)
    }
    await this.mutate(group => group.sessionIds.includes(sessionId)
      ? group
      : { ...group, sessionIds: [sessionId, ...group.sessionIds] })
  }

  async insertSessionBefore(sessionId: SessionId, beforeSessionId?: SessionId): Promise<void> {
    await this.mutate((group) => {
      if (!group.sessionIds.includes(sessionId)) {
        throw new WorkspaceMoveInvalidError(
          `cannot move session '${sessionId}' in workspace '${this.record.path}': the session is not accounted`,
        )
      }
      if (beforeSessionId !== undefined && !group.sessionIds.includes(beforeSessionId)) {
        throw new WorkspaceMoveInvalidError(
          `cannot move session '${sessionId}' before '${beforeSessionId}' in workspace '${this.record.path}': `
          + 'the anchor session is not accounted',
        )
      }
      if (beforeSessionId === sessionId) return group
      const without = group.sessionIds.filter(id => id !== sessionId)
      const at = beforeSessionId === undefined ? without.length : without.indexOf(beforeSessionId)
      const sessionIds = [...without.slice(0, at), sessionId, ...without.slice(at)]
      return sessionIds.every((id, index) => id === group.sessionIds[index])
        ? group
        : { ...group, sessionIds }
    })
  }

  async detachSession(sessionId: SessionId): Promise<void> {
    await this.mutate(group => group.sessionIds.includes(sessionId)
      ? { ...group, sessionIds: group.sessionIds.filter(id => id !== sessionId) }
      : group)
  }

  async status(): Promise<'ok' | 'missing-dir'> {
    try {
      return (await stat(this.record.path)).isDirectory() ? 'ok' : 'missing-dir'
    } catch {
      // Any stat failure (ENOENT, dangling parent, permission loss) means the
      // directory is not usable right now; the record itself never mutates.
      return 'missing-dir'
    }
  }

  /**
   * The single write path: run `fn` on the domain write chain via
   * `table.update`, stamping `updatedAt` and pruning candidates that no
   * longer pass the candidate membership check, then swap the snapshot.
   *
   * `fn` sees the value current at its chain slot, so membership decisions
   * (attach/detach idempotence) are race-free against queued writes; a fn
   * signalling no change by returning `current` verbatim aborts the slot
   * through the sentinel when pruning also finds nothing, so a no-op neither
   * rewrites the medium nor emits a change event.
   */
  private async mutate(fn: (group: WorkspaceGroupRecord) => WorkspaceGroupRecord): Promise<void> {
    let next: WorkspaceGroupRecord
    try {
      next = await this.host.groupTable().update(this.id, (current) => {
        const changed = fn(current)
        const sessionIds = changed.sessionIds.filter(
          id => this.host.candidateMatches(id, this.record.path),
        )
        if (changed === current && sessionIds.length === current.sessionIds.length) {
          throw unchangedSentinel
        }
        return { sessionIds, updatedAt: Date.now() }
      })
    } catch (error) {
      if (error === unchangedSentinel) return
      throw error
    }
    this.group = next
    this.host.projectChanged(this.id)
  }
}
