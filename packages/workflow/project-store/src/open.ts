/**
 * The open protocol every store database follows, in one fixed order:
 * create the directory and file owner-only, set `busy_timeout`, switch to WAL
 * (bounded retry while another writer holds the file), enable foreign keys,
 * validate the application identity and layout version, materialize the schema,
 * and stamp fresh media last.
 *
 * @module @metaworkflow/workflow-project-store/open
 */

import { mkdir, open } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { setTimeout as sleep } from 'node:timers/promises'
import { WorkflowProjectStoreError } from './errors.ts'

/** Owner-only mode for a created database directory; ignored where POSIX modes are unavailable. */
const OWNER_ONLY_DIRECTORY_MODE = 0o700

/** Owner-only mode for a created database file; ignored where POSIX modes are unavailable. */
const OWNER_ONLY_FILE_MODE = 0o600

/** `SQLITE_BUSY`: another connection holds the lock this statement needs. */
export const SQLITE_BUSY = 5

/**
 * Milliseconds a connection waits for another writer before SQLite reports
 * `SQLITE_BUSY`. Writes are serialized in process, so this only absorbs
 * another process's short-lived lock.
 */
export const WORKFLOW_STORE_BUSY_TIMEOUT_MS = 5_000

/** Attempts at switching a connection to WAL while another connection holds the file. */
export const WORKFLOW_STORE_WAL_RETRY_ATTEMPTS = 5

/** Base delay before retrying the WAL switch; multiplied by the attempt number. */
export const WORKFLOW_STORE_WAL_RETRY_DELAY_MS = 20

/** Timing knobs of the open protocol; production opens use the defaults. */
export interface WorkflowDatabaseOpenOptions {
  /** Milliseconds the connection waits for another writer. */
  readonly busyTimeoutMs?: number
  /** Attempts at the WAL switch before the open fails. */
  readonly walRetryAttempts?: number
  /** Base WAL retry delay, multiplied by the attempt number. */
  readonly walRetryDelayMs?: number
  /** Delay primitive used between WAL attempts; defaults to a real timer. */
  readonly delay?: (milliseconds: number) => Promise<void>
}

/** Complete input of one database open. */
export interface OpenWorkflowDatabaseOptions extends WorkflowDatabaseOpenOptions {
  /** Database file path; missing parent directories are created owner-only. */
  readonly path: string
  /** Stable `PRAGMA application_id` identity this database file must carry. */
  readonly applicationId: number
  /** Current `PRAGMA user_version` layout version this database file must carry. */
  readonly schemaVersion: number
  /**
   * Schema statements run once the identity and version are accepted.
   * @param db - validated connection that the statements run on.
   */
  readonly materialize: (db: DatabaseSync) => void
}

/**
 * Create the medium when absent and open it under the store protocol.
 * @param options - file path, database identity, layout version, and schema statements.
 * @returns the open connection with pragmas applied and the schema materialized.
 * @throws {@link WorkflowProjectStoreError} when the file is unreadable, belongs
 * to another application, carries another layout version, or stays locked
 * through the WAL retry budget.
 */
export async function openWorkflowDatabase(options: OpenWorkflowDatabaseOptions): Promise<DatabaseSync> {
  const path = resolve(options.path)
  try {
    await mkdir(dirname(path), { recursive: true, mode: OWNER_ONLY_DIRECTORY_MODE })
    await assureOwnerOnlyFile(path)
    const db = new DatabaseSync(path)
    try {
      await configureConnection(db, path, options)
    } catch (error: unknown) {
      db.close()
      throw error
    }
    return db
  } catch (error: unknown) {
    if (error instanceof WorkflowProjectStoreError) throw error
    throw new WorkflowProjectStoreError(
      'open-failed',
      `workflow store database at "${path}" could not be opened: ${String(error)}`,
      { cause: error },
    )
  }
}

/**
 * Create a missing database file owner-only without touching an existing one.
 *
 * The file is opened for append rather than exclusively created: the process
 * owns the database through `DatabaseSync` either way, and an existing file
 * keeps its modes.
 * @param path - database file path.
 * @returns resolution once the file exists.
 */
async function assureOwnerOnlyFile(path: string): Promise<void> {
  const handle = await open(path, 'a+', OWNER_ONLY_FILE_MODE)
  await handle.close()
}

/**
 * Apply the connection protocol in its fixed order.
 * @param db - freshly constructed connection.
 * @param path - database path used in diagnostics.
 * @param options - identity, version, and schema statements.
 * @returns resolution once the protocol finished.
 */
async function configureConnection(db: DatabaseSync, path: string, options: OpenWorkflowDatabaseOptions): Promise<void> {
  // Binds are not allowed in a PRAGMA, and both numbers are typed inputs.
  db.exec(`PRAGMA busy_timeout = ${String(options.busyTimeoutMs ?? WORKFLOW_STORE_BUSY_TIMEOUT_MS)}`)
  await switchToWal(db, path, options)
  db.exec('PRAGMA foreign_keys = ON')
  materializeSchema(db, path, options)
}

/**
 * Switch the connection to WAL, retrying while another connection holds the file.
 * @param db - connection being configured.
 * @param path - database path used in diagnostics.
 * @param options - retry budget and delay primitive.
 * @returns resolution once the journal mode is WAL.
 */
async function switchToWal(db: DatabaseSync, path: string, options: OpenWorkflowDatabaseOptions): Promise<void> {
  const attempts = options.walRetryAttempts ?? WORKFLOW_STORE_WAL_RETRY_ATTEMPTS
  const delayMs = options.walRetryDelayMs ?? WORKFLOW_STORE_WAL_RETRY_DELAY_MS
  const delay = options.delay ?? (async (milliseconds: number) => { await sleep(milliseconds) })
  for (let attempt = 1; ; attempt += 1) {
    try {
      db.exec('PRAGMA journal_mode = WAL')
      return
    } catch (error: unknown) {
      // Only a busy file is worth waiting for; every other failure is final.
      if ((error as { errcode?: number }).errcode !== SQLITE_BUSY) throw error
      if (attempt >= attempts) {
        throw new WorkflowProjectStoreError(
          'open-failed',
          `workflow store database at "${path}" stayed locked while switching to WAL after ${String(attempts)} attempts`,
          { cause: error },
        )
      }
      await delay(delayMs * attempt)
    }
  }
}

/**
 * Validate the durable identity and layout version, then materialize and stamp.
 *
 * Validation order matters: a file that belongs to another application, or one
 * that holds tables without the store's identity, is refused before any schema
 * statement runs. A zero `user_version` is a fresh medium (or an interrupted
 * materialization under the store's own identity) and is stamped only after the
 * schema is complete.
 * @param db - connection whose pragmas are already applied.
 * @param path - database path used in diagnostics.
 * @param options - identity, version, and schema statements.
 * @returns resolution once the schema is materialized.
 */
function materializeSchema(db: DatabaseSync, path: string, options: OpenWorkflowDatabaseOptions): void {
  const { application_id: applicationId } = db.prepare('PRAGMA application_id').get() as { application_id: number }
  const { user_version: version } = db.prepare('PRAGMA user_version').get() as { user_version: number }
  const userTables = listUserTables(db)
  if (applicationId !== 0 && applicationId !== options.applicationId) {
    throw new WorkflowProjectStoreError(
      'foreign-database',
      `workflow store database at "${path}" belongs to another application (application id ${String(applicationId)})`,
    )
  }
  if (applicationId === 0 && userTables.length > 0) {
    throw new WorkflowProjectStoreError(
      'foreign-database',
      `workflow store database at "${path}" is neither empty nor a workflow store database (tables: ${userTables.join(', ')})`,
    )
  }
  if (version !== 0 && version !== options.schemaVersion) {
    throw new WorkflowProjectStoreError(
      'version-mismatch',
      `workflow store database at "${path}" has schema version ${String(version)}, incompatible with this build (${String(options.schemaVersion)})`,
    )
  }
  // The identity is stamped before the schema so an interrupted materialization
  // is recognized as the store's own unfinished medium on the next open.
  if (applicationId === 0) db.exec(`PRAGMA application_id = ${String(options.applicationId)}`)
  options.materialize(db)
  if (version === 0) db.exec(`PRAGMA user_version = ${String(options.schemaVersion)}`)
}

/**
 * Names of the non-internal tables one database file holds, sorted.
 * @param db - open connection to inspect.
 * @returns the user table names.
 */
function listUserTables(db: DatabaseSync): string[] {
  const rows = db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT GLOB 'sqlite_*' ORDER BY name",
  ).all()
  return rows.map(row => row.name as string)
}
