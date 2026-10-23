/**
 * Workflow project persistence (`ctx.mwfProjectStore`): one global registry
 * database plus one SQLite database per project.
 *
 * The registry holds a row per project — id, working directory, database path,
 * title, timestamps, and a definition-revision hint. Each project database
 * lives in the store's own `<home>/mwf/projects/<projectId>` directory and owns
 * the definition revisions and the run, activation, attempt, artifact,
 * decision, and session-outbox records of that project; the project's working
 * directory holds the user's code and artifacts and no store file at all.
 * Storage is host-side only: the store contributes no prompt, tool, or session
 * event.
 *
 * Every database is opened under the fixed protocol in `open.ts`, held as one
 * `DatabaseSync` connection per process, and written through its own serial
 * queue. Transactions never span databases; the registry is a hint holder, and
 * each project database stays authoritative for its own content.
 *
 * @module @metaworkflow/workflow-project-store
 */

import { randomUUID } from 'node:crypto'
import { mkdir, rm, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { brandString } from '@metaworkflow/brand'
import { expandHomePath, resolveMwfHome } from '@metaworkflow/home-paths'
import { DatabaseSlot } from './database.ts'
import { WorkflowProjectStoreError } from './errors.ts'
import { OWNER_ONLY_DIRECTORY_MODE } from './open.ts'
import {
  openProjectDatabase,
  insertDefinition,
  nextDefinitionRevision,
  selectDefinition,
  selectLatestDefinition,
  selectRuns,
  ackOutboxRow,
  stageOutboxRow,
  selectOutboxRows,
  PROJECT_DATABASE_FILE_NAME,
} from './project-database.ts'
import {
  deleteRegistryProject,
  insertRegistryProject,
  openRegistryDatabase,
  selectRegistryProject,
  selectRegistryProjectByPath,
  selectRegistryProjects,
  updateRegistryDatabasePath,
  updateRegistryDefinitionRevision,
  updateRegistryTitle,
} from './registry.ts'
import { moveProjectDatabase } from './relocate.ts'
import { runTransaction } from './transaction.ts'
import type {
  AttemptId,
  CreateProjectRequest,
  DefinitionRecord,
  OutboxRecord,
  ProjectId,
  ProjectRecord,
  RemoveProjectOptions,
  RunRecord,
} from './types.ts'

export type * from './types.ts'
export { WorkflowProjectStoreError, type WorkflowProjectStoreErrorCode } from './errors.ts'
export {
  SQLITE_BUSY,
  WORKFLOW_STORE_BUSY_TIMEOUT_MS,
  WORKFLOW_STORE_WAL_RETRY_ATTEMPTS,
  WORKFLOW_STORE_WAL_RETRY_DELAY_MS,
  openWorkflowDatabase,
  type OpenWorkflowDatabaseOptions,
  type WorkflowDatabaseOpenOptions,
  type WorkflowDatabaseUpgrade,
} from './open.ts'
export {
  WORKFLOW_PROJECT_REGISTRY_APPLICATION_ID,
  WORKFLOW_PROJECT_REGISTRY_SCHEMA_VERSION,
  openRegistryDatabase,
} from './registry.ts'
export {
  PROJECT_DATABASE_FILE_NAME,
  WORKFLOW_PROJECT_DATABASE_APPLICATION_ID,
  WORKFLOW_PROJECT_DATABASE_SCHEMA_VERSION,
  openProjectDatabase,
} from './project-database.ts'
export { moveProjectDatabase } from './relocate.ts'
export { runTransaction } from './transaction.ts'

/** Canonical project ids are UUIDs; anything else would address files outside the layout. */
const PROJECT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u

/** Registry database file name inside `<home>/mwf`. */
const REGISTRY_DATABASE_NAME = 'projects.db'

/** Project directory name inside `<home>/mwf`. */
const PROJECTS_DIRECTORY_NAME = 'projects'

/** Working-directory name inside one project's store directory. */
const WORKSPACE_DIRECTORY_NAME = 'workspace'

declare module '@deepseek-ai/cordis' {
  interface Context {
    mwfProjectStore: WorkflowProjectStore
  }
}

/** Plugin configuration. */
export interface Config {
  /**
   * Harness home override. Omitted resolves `$MWF_HOME` and then `~/.mwf`
   * through `@metaworkflow/home-paths`; the store never hard-codes a home.
   */
  readonly mwfHome?: string
}

/** Schemastery validator for {@link Config}. */
export const Config: z<Config> = z.object({
  mwfHome: z.string(),
})

/**
 * Absolute registry path for one resolved harness home.
 * @param home - resolved harness home.
 * @returns `<home>/mwf/projects.db`.
 */
function registryDatabasePath(home: string): string {
  return join(home, 'mwf', REGISTRY_DATABASE_NAME)
}

/**
 * Absolute project-directory root for one resolved harness home.
 * @param home - resolved harness home.
 * @returns `<home>/mwf/projects`.
 */
function projectsRoot(home: string): string {
  return join(home, 'mwf', PROJECTS_DIRECTORY_NAME)
}

/**
 * Store-owned directory of one project, holding its database.
 * @param root - absolute `<home>/mwf/projects`.
 * @param id - project id.
 * @returns `<root>/<projectId>`.
 */
function projectStoreDirectory(root: string, id: ProjectId): string {
  return join(root, id)
}

/**
 * Default working directory of one project.
 * @param root - absolute `<home>/mwf/projects`.
 * @param id - project id.
 * @returns `<root>/<projectId>/workspace`.
 */
function defaultWorkspacePath(root: string, id: ProjectId): string {
  return join(projectStoreDirectory(root, id), WORKSPACE_DIRECTORY_NAME)
}

/**
 * Canonical project database path of one project.
 * @param root - absolute `<home>/mwf/projects`.
 * @param id - project id.
 * @returns `<root>/<projectId>/project.db`.
 */
function projectDatabasePath(root: string, id: ProjectId): string {
  return join(projectStoreDirectory(root, id), PROJECT_DATABASE_FILE_NAME)
}

/**
 * Whether one path names an existing directory.
 * @param path - absolute path to check.
 * @returns `true` when the path resolves to a directory.
 */
async function directoryExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    // A missing, dangling, or unreadable path is not a usable directory.
    return false
  }
}

/**
 * Whether one path names an existing file.
 * @param path - absolute path to check.
 * @returns `true` when the path resolves to a file or another existing entry.
 */
async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    // A missing or unreadable path is not a file the store can move.
    return false
  }
}

/**
 * Refuse an id that is not a canonical UUID.
 * @param id - candidate project id.
 * @returns nothing.
 * @throws {@link WorkflowProjectStoreError} `invalid-project-id` for any other value.
 */
function assertProjectId(id: ProjectId): void {
  if (!PROJECT_ID_PATTERN.test(id)) {
    throw new WorkflowProjectStoreError('invalid-project-id', `'${id}' is not a canonical project id`)
  }
}

/**
 * Require a registry row for one id.
 * @param id - project id the caller addressed.
 * @param record - matching registry record, when the read found one.
 * @returns the registry record.
 * @throws {@link WorkflowProjectStoreError} `project-not-found` when the id is not registered.
 */
function requireProjectRecord(id: ProjectId, record: ProjectRecord | undefined): ProjectRecord {
  if (record === undefined) {
    throw new WorkflowProjectStoreError('project-not-found', `no workflow project '${id}' is registered`)
  }
  return record
}

/**
 * Refuse an event sequence outside the accepted range.
 * @param eventSeq - candidate per-attempt event sequence.
 * @returns nothing.
 * @throws {@link WorkflowProjectStoreError} `invalid-request` for a negative or non-integer value.
 */
function assertEventSeq(eventSeq: number): void {
  if (!Number.isSafeInteger(eventSeq) || eventSeq < 0) {
    throw new WorkflowProjectStoreError('invalid-request', `event sequence must be a non-negative integer, got ${String(eventSeq)}`)
  }
}

/**
 * The workflow project store service.
 *
 * The registry database opens on first use and every project database opens
 * when its project is first touched; each connection stays open until the
 * service is disposed or its project is removed from the registry. Writes are
 * serialized per database, so concurrent callers never rely on `busy_timeout`
 * to order them.
 */
export default class WorkflowProjectStore extends Service {
  static Config: z<Config> = Config

  private readonly registryPath: string
  private readonly projectsRoot: string
  private readonly registrySlot: DatabaseSlot
  private readonly projectSlots = new Map<ProjectId, DatabaseSlot>()
  private closed = false

  /**
   * @param ctx - plugin context that owns the service lifetime.
   * @param config - validated plugin configuration.
   */
  constructor(ctx: Context, config: Config) {
    super(ctx, 'mwfProjectStore')
    const home = resolveMwfHome(config.mwfHome)
    this.registryPath = registryDatabasePath(home)
    this.projectsRoot = projectsRoot(home)
    this.registrySlot = new DatabaseSlot(() => openRegistryDatabase(this.registryPath))
    ctx.effect(() => async () => {
      await this.close()
    }, 'workflowProjectStore.close')
  }

  /**
   * Every registered project, newest first.
   * @returns the registry records in registry order.
   */
  async listProjects(): Promise<ProjectRecord[]> {
    this.assertOpen()
    return selectRegistryProjects(await this.registrySlot.connection())
  }

  /**
   * Register a new project and materialize its working directory and database.
   *
   * The registry row is written first, so a directory already claimed by another
   * project fails before any file is created; a working directory or database
   * that then fails to materialize removes the row it just wrote. The database
   * always lands in the store's own project directory, whatever directory the
   * caller asked for, so the working directory never holds a store file.
   * @param request - title and optional working directory.
   * @returns the registered project record.
   * @throws {@link WorkflowProjectStoreError} `invalid-request` for an empty title,
   * `project-path-in-use` when another project claims the directory, and
   * `open-failed` when the working directory or project database cannot be created.
   */
  async createProject(request: CreateProjectRequest): Promise<ProjectRecord> {
    this.assertOpen()
    const title = request.title.trim()
    if (title.length === 0) {
      throw new WorkflowProjectStoreError('invalid-request', 'project title must not be empty')
    }
    const id = brandString<ProjectId>(randomUUID())
    const directory = request.path === undefined
      ? defaultWorkspacePath(this.projectsRoot, id)
      : resolve(expandHomePath(request.path))
    const now = Date.now()
    const record: ProjectRecord = {
      id,
      path: directory,
      dbPath: projectDatabasePath(this.projectsRoot, id),
      title,
      createdAt: now,
      updatedAt: now,
      definitionRevision: 0,
    }
    const taken = await this.registrySlot.queue.run(async () => {
      const db = await this.registrySlot.connection()
      if (selectRegistryProjectByPath(db, directory) !== undefined) return true
      runTransaction(db, () => {
        insertRegistryProject(db, record)
      })
      return false
    })
    if (taken) {
      throw new WorkflowProjectStoreError('project-path-in-use', `a workflow project already uses '${directory}'`)
    }
    const slot = this.projectSlot(record)
    try {
      await mkdir(directory, { recursive: true, mode: OWNER_ONLY_DIRECTORY_MODE })
      await slot.connection()
    } catch (error: unknown) {
      this.projectSlots.delete(id)
      await this.registrySlot.queue.run(async () => {
        const db = await this.registrySlot.connection()
        runTransaction(db, () => {
          deleteRegistryProject(db, id)
        })
      })
      if (error instanceof WorkflowProjectStoreError) throw error
      throw new WorkflowProjectStoreError(
        'open-failed',
        `workflow project directory at "${directory}" could not be created: ${String(error)}`,
        { cause: error },
      )
    }
    return record
  }

  /**
   * Open one project: require its working directory, and materialize its
   * database when the file is absent or still sits in an older library.
   * @param projectId - registered project to open.
   * @returns the registry record of the opened project.
   * @throws {@link WorkflowProjectStoreError} `invalid-project-id`, `project-not-found`,
   * `project-directory-missing` when the working directory is gone,
   * `relocation-failed` when an older database cannot be moved out of it, or the
   * project database's open failure.
   */
  async openProject(projectId: ProjectId): Promise<ProjectRecord> {
    this.assertOpen()
    assertProjectId(projectId)
    const record = await this.registryRecord(projectId)
    if (!await directoryExists(record.path)) {
      throw new WorkflowProjectStoreError(
        'project-directory-missing',
        `workflow project '${projectId}' has no working directory at "${record.path}"`,
      )
    }
    const { record: opened } = await this.openSlot(record)
    return opened
  }

  /**
   * Replace one project's display title.
   *
   * The registry row is the title's only owner, so a renaming consumer never
   * keeps a second title store. Titles may repeat across projects; the
   * directory stays the registry's uniqueness key.
   * @param projectId - registered project to rename.
   * @param title - the new display title; surrounding whitespace is trimmed and
   * an empty result is refused.
   * @returns the updated registry record.
   * @throws {@link WorkflowProjectStoreError} `invalid-project-id`, `project-not-found`,
   * or `invalid-request` for a blank title.
   */
  async renameProject(projectId: ProjectId, title: string): Promise<ProjectRecord> {
    this.assertOpen()
    assertProjectId(projectId)
    const trimmed = title.trim()
    if (trimmed.length === 0) {
      throw new WorkflowProjectStoreError('invalid-request', 'project title must not be empty')
    }
    return this.registrySlot.queue.run(async () => {
      const db = await this.registrySlot.connection()
      const record = requireProjectRecord(projectId, selectRegistryProject(db, projectId))
      const updatedAt = Date.now()
      runTransaction(db, () => {
        updateRegistryTitle(db, projectId, trimmed, updatedAt)
      })
      return { ...record, title: trimmed, updatedAt }
    })
  }

  /**
   * Remove one project from the registry.
   *
   * The project's connection is closed first; its working directory keeps every
   * file unless `deleteDirectory` asks for removal. Removing the directory also
   * removes the project's database, which the registration owns and nothing
   * else references. The returned directory is what a caller shows the human
   * before deciding.
   * @param projectId - registered project to remove.
   * @param options - whether to delete the working directory and the project database.
   * @returns the absolute working directory that is no longer registered.
   * @throws {@link WorkflowProjectStoreError} `invalid-project-id` or `project-not-found`.
   */
  async removeProject(projectId: ProjectId, options: RemoveProjectOptions = {}): Promise<string> {
    this.assertOpen()
    assertProjectId(projectId)
    const record = await this.registrySlot.queue.run(async () => {
      const db = await this.registrySlot.connection()
      const record = requireProjectRecord(projectId, selectRegistryProject(db, projectId))
      const slot = this.projectSlots.get(projectId)
      this.projectSlots.delete(projectId)
      await slot?.close()
      runTransaction(db, () => {
        deleteRegistryProject(db, projectId)
      })
      return record
    })
    if (options.deleteDirectory === true) {
      await rm(record.path, { recursive: true, force: true, maxRetries: 3 })
      await rm(projectStoreDirectory(this.projectsRoot, record.id), { recursive: true, force: true, maxRetries: 3 })
    }
    return record.path
  }

  /**
   * Read one definition revision, or the newest one.
   * @param projectId - registered project to read.
   * @param revision - revision to read; omitted reads the newest revision.
   * @returns the stored definition, or `undefined` when the project has none.
   * @throws {@link WorkflowProjectStoreError} `invalid-request` for a non-positive revision.
   */
  async readDefinition(projectId: ProjectId, revision?: number): Promise<DefinitionRecord | undefined> {
    if (revision !== undefined && (!Number.isSafeInteger(revision) || revision < 1)) {
      throw new WorkflowProjectStoreError('invalid-request', `definition revision must be a positive integer, got ${String(revision)}`)
    }
    const { slot } = await this.projectSlotFor(projectId)
    const db = await slot.connection()
    return revision === undefined ? selectLatestDefinition(db) : selectDefinition(db, revision)
  }

  /**
   * Store a new definition revision and refresh the registry hint.
   *
   * The revision is computed and inserted inside one `BEGIN IMMEDIATE` batch, so
   * concurrent writes get distinct consecutive revisions. The registry hint is
   * refreshed afterwards: a registry failure surfaces to the caller even though
   * the new revision is durable.
   * @param projectId - registered project to write.
   * @param document - complete definition document text.
   * @returns the revision number the document was stored under.
   * @throws {@link WorkflowProjectStoreError} `invalid-request` for an empty document.
   */
  async writeDefinition(projectId: ProjectId, document: string): Promise<number> {
    if (document.trim().length === 0) {
      throw new WorkflowProjectStoreError('invalid-request', 'definition document must not be empty')
    }
    const { slot } = await this.projectSlotFor(projectId)
    const revision = await slot.queue.run(async () => {
      const db = await slot.connection()
      return runTransaction(db, () => {
        const revision = nextDefinitionRevision(db)
        insertDefinition(db, { revision, document, createdAt: Date.now() })
        return revision
      })
    })
    await this.registrySlot.queue.run(async () => {
      const db = await this.registrySlot.connection()
      runTransaction(db, () => {
        updateRegistryDefinitionRevision(db, projectId, revision, Date.now())
      })
    })
    return revision
  }

  /**
   * Every run recorded for one project, newest first.
   * @param projectId - registered project to read.
   * @returns the run records.
   */
  async listRuns(projectId: ProjectId): Promise<RunRecord[]> {
    const { slot } = await this.projectSlotFor(projectId)
    return selectRuns(await slot.connection())
  }

  /**
   * Every outbox event of one attempt, in event order.
   * @param projectId - registered project to read.
   * @param attemptId - attempt whose events are read.
   * @returns the stored events, acknowledged or not.
   */
  async listOutbox(projectId: ProjectId, attemptId: AttemptId): Promise<OutboxRecord[]> {
    const { slot } = await this.projectSlotFor(projectId)
    return selectOutboxRows(await slot.connection(), attemptId)
  }

  /**
   * Stage one outbox event for a later replay into a session log.
   *
   * `(attemptId, eventSeq)` is the idempotency key: repeating an append returns
   * the row already stored, including a previous acknowledgement, instead of
   * writing a duplicate.
   * @param projectId - registered project to write.
   * @param attemptId - attempt the event belongs to; it must be recorded first.
   * @param eventSeq - per-attempt event sequence.
   * @param payload - event payload text.
   * @returns the stored event.
   * @throws {@link WorkflowProjectStoreError} `invalid-request` for an empty payload
   * or a negative sequence, and `unknown-attempt` when the attempt is not recorded.
   */
  async appendOutbox(
    projectId: ProjectId,
    attemptId: AttemptId,
    eventSeq: number,
    payload: string,
  ): Promise<OutboxRecord> {
    assertEventSeq(eventSeq)
    if (payload.length === 0) {
      throw new WorkflowProjectStoreError('invalid-request', 'outbox payload must not be empty')
    }
    const { slot } = await this.projectSlotFor(projectId)
    return slot.queue.run(async () => {
      const db = await slot.connection()
      return runTransaction(db, () => stageOutboxRow(db, attemptId, eventSeq, payload))
    })
  }

  /**
   * Acknowledge one staged outbox event.
   * @param projectId - registered project to write.
   * @param attemptId - attempt the event belongs to.
   * @param eventSeq - per-attempt event sequence.
   * @returns `true` when this call acknowledged the event, `false` when it was
   * absent or already acknowledged.
   */
  async markAcked(projectId: ProjectId, attemptId: AttemptId, eventSeq: number): Promise<boolean> {
    assertEventSeq(eventSeq)
    const { slot } = await this.projectSlotFor(projectId)
    return slot.queue.run(async () => {
      const db = await slot.connection()
      return runTransaction(db, () => ackOutboxRow(db, attemptId, eventSeq, Date.now()))
    })
  }

  /**
   * Close every open connection and refuse further work. Idempotent.
   * @returns resolution once every queued write settled and every handle closed.
   */
  async close(): Promise<void> {
    this.closed = true
    const slots = [this.registrySlot, ...this.projectSlots.values()]
    this.projectSlots.clear()
    await Promise.all(slots.map(async (slot) => {
      await slot.close()
    }))
  }

  /**
   * Refuse work once the service is disposed.
   * @returns nothing.
   * @throws {@link WorkflowProjectStoreError} `closed`.
   */
  private assertOpen(): void {
    if (this.closed) {
      throw new WorkflowProjectStoreError('closed', 'the workflow project store is closed')
    }
  }

  /**
   * One registry row by id.
   * @param projectId - project the caller addressed.
   * @returns the registry record.
   * @throws {@link WorkflowProjectStoreError} `project-not-found` when the id is not registered.
   */
  private async registryRecord(projectId: ProjectId): Promise<ProjectRecord> {
    const registry = await this.registrySlot.connection()
    return requireProjectRecord(projectId, selectRegistryProject(registry, projectId))
  }

  /**
   * The slot holding one project's connection, created on first use.
   * @param record - registry record naming the project database.
   * @returns the project's slot.
   */
  private projectSlot(record: ProjectRecord): DatabaseSlot {
    const existing = this.projectSlots.get(record.id)
    if (existing !== undefined) return existing
    const slot = new DatabaseSlot(() => openProjectDatabase(record.dbPath))
    this.projectSlots.set(record.id, slot)
    return slot
  }

  /**
   * Resolve one project and open its database connection.
   * @param record - registry record of the project.
   * @returns the record, with any relocation applied, and the slot that owns its connection.
   */
  private async openSlot(record: ProjectRecord): Promise<{ record: ProjectRecord; slot: DatabaseSlot }> {
    const relocated = await this.relocateDatabase(record)
    const slot = this.projectSlot(relocated)
    await slot.connection()
    return { record: relocated, slot }
  }

  /**
   * Move one project's database out of its working directory into the store's
   * own project directory.
   *
   * Idempotent in every resolved state: a record already naming the canonical
   * path needs no work, a working directory that holds no database only needs
   * the row repointed, and a canonical file that already exists stays
   * authoritative because a completed move leaves both copies rather than an
   * unverified one.
   * @param record - registry record naming the recorded database path.
   * @returns the record, updated when the row was repointed.
   * @throws {@link WorkflowProjectStoreError} `relocation-failed` when the copy cannot
   * complete; the source and the registry row are then unchanged.
   */
  private async relocateDatabase(record: ProjectRecord): Promise<ProjectRecord> {
    const target = projectDatabasePath(this.projectsRoot, record.id)
    if (record.dbPath === target) return record
    if (!await fileExists(record.dbPath)) return this.recordDatabasePath(record, target)
    if (await fileExists(target)) {
      this.ctx.logger.warn(
        `workflow project '${record.id}' keeps a stale database copy at "${record.dbPath}"; the store uses "${target}"`,
      )
      return this.recordDatabasePath(record, target)
    }
    try {
      await moveProjectDatabase(record.dbPath, target)
    } catch (error: unknown) {
      throw new WorkflowProjectStoreError(
        'relocation-failed',
        `workflow project database at "${record.dbPath}" could not be moved to "${target}"; the recorded location is unchanged`,
        { cause: error },
      )
    }
    return this.recordDatabasePath(record, target)
  }

  /**
   * Point one registry row at the database's new path.
   * @param record - registry record to repoint.
   * @param dbPath - absolute path the database now lives at.
   * @returns the record with the new path.
   */
  private async recordDatabasePath(record: ProjectRecord, dbPath: string): Promise<ProjectRecord> {
    await this.registrySlot.queue.run(async () => {
      const db = await this.registrySlot.connection()
      runTransaction(db, () => {
        updateRegistryDatabasePath(db, record.id, dbPath)
      })
    })
    return { ...record, dbPath }
  }

  /**
   * Resolve one registered project and its slot.
   * @param projectId - project the caller addressed.
   * @returns the registry record and the slot that owns its connection.
   */
  private async projectSlotFor(projectId: ProjectId): Promise<{ record: ProjectRecord; slot: DatabaseSlot }> {
    this.assertOpen()
    assertProjectId(projectId)
    return this.openSlot(await this.registryRecord(projectId))
  }
}
