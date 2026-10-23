/**
 * Global project registry: one SQLite database at `<home>/mwf/projects.db`
 * holding a row per workflow project. Rows carry no definition content; each
 * project database owns that. A row names both the project's working directory
 * and the database file the store keeps for it.
 *
 * @module @metaworkflow/workflow-project-store/registry
 */

import { isAbsolute, join } from 'node:path'
import type { DatabaseSync, SQLOutputValue } from 'node:sqlite'
import { brandString } from '@metaworkflow/brand'
import { WorkflowProjectStoreError } from './errors.ts'
import type { ProjectId, ProjectRecord } from './types.ts'
import {
  openWorkflowDatabase,
  type WorkflowDatabaseOpenOptions,
  type WorkflowDatabaseUpgrade,
} from './open.ts'
import { PROJECT_DATABASE_FILE_NAME } from './project-database.ts'

/**
 * Registry layout version in `PRAGMA user_version`. A database stamped with
 * another version is upgraded through the declared steps in
 * {@link REGISTRY_UPGRADES} or, with no step from its version, refused.
 */
export const WORKFLOW_PROJECT_REGISTRY_SCHEMA_VERSION = 2

/**
 * Registry `PRAGMA application_id` identity (`MWRP`). It differs from the
 * project database identity, so neither file can be opened as the other.
 */
export const WORKFLOW_PROJECT_REGISTRY_APPLICATION_ID = 0x4d575250

/** Stable `schema_meta` row naming this database's role and version. */
const REGISTRY_FORMAT = 'workflow-projects/2'

/** One row as `node:sqlite` hands it back: column values keyed by column name. */
type SqlRow = Record<string, SQLOutputValue>

/** One registry row in column declaration order. */
interface RegistryRow extends SqlRow {
  readonly id: string
  readonly path: string
  readonly db_path: string
  readonly title: string
  readonly created_at: number
  readonly updated_at: number
  readonly definition_revision: number
}

/** Columns every registry read selects, in declaration order. */
const REGISTRY_COLUMNS = 'id, path, db_path, title, created_at, updated_at, definition_revision'

/**
 * Layout upgrades of the registry, applied only when an existing library is
 * older than {@link WORKFLOW_PROJECT_REGISTRY_SCHEMA_VERSION}.
 */
const REGISTRY_UPGRADES: readonly WorkflowDatabaseUpgrade[] = [
  { from: 1, apply: addDatabasePathColumn },
]

/**
 * Open the project registry, creating and materializing it when absent and
 * upgrading a v1 library in place.
 * @param path - registry database path.
 * @param options - timing knobs of the open protocol.
 * @returns the open registry connection.
 */
export async function openRegistryDatabase(
  path: string,
  options?: WorkflowDatabaseOpenOptions,
): Promise<DatabaseSync> {
  return openWorkflowDatabase({
    ...options,
    path,
    applicationId: WORKFLOW_PROJECT_REGISTRY_APPLICATION_ID,
    schemaVersion: WORKFLOW_PROJECT_REGISTRY_SCHEMA_VERSION,
    upgrades: REGISTRY_UPGRADES,
    materialize: materializeRegistrySchema,
  })
}

/**
 * Create every registry table and index that does not exist yet.
 *
 * `db_path` defaults to the empty string only because `ALTER TABLE` requires a
 * constant default for a column added to a v1 library; the v1 to v2 step
 * backfills every row, and a stored empty value is refused as an invalid record.
 * @param db - connection whose identity and version are already accepted.
 * @returns nothing.
 */
function materializeRegistrySchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id                  TEXT PRIMARY KEY,
      path                TEXT NOT NULL UNIQUE,
      db_path             TEXT NOT NULL DEFAULT '',
      title               TEXT NOT NULL,
      created_at          INTEGER NOT NULL,
      updated_at          INTEGER NOT NULL,
      definition_revision INTEGER NOT NULL
    ) STRICT
  `)
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    ) STRICT
  `)
  db.exec('CREATE INDEX IF NOT EXISTS projects_by_created ON projects(created_at)')
  db.prepare('INSERT OR IGNORE INTO schema_meta (key, value) VALUES (?, ?)').run('format', REGISTRY_FORMAT)
}

/**
 * Upgrade a v1 registry: record where each project database lives and refresh
 * the format marker.
 *
 * A v1 row kept its database inside the project's working directory, so the
 * backfilled path is that file. Opening the project later moves it out; a
 * registry that never opens the project keeps naming the v1 location, which is
 * where the file still is.
 * @param db - v1 registry connection holding the write lock of its upgrade batch.
 * @returns nothing.
 */
function addDatabasePathColumn(db: DatabaseSync): void {
  db.exec("ALTER TABLE projects ADD COLUMN db_path TEXT NOT NULL DEFAULT ''")
  const rows = db.prepare('SELECT id, path FROM projects').all() as { id: string; path: string }[]
  const backfill = db.prepare('UPDATE projects SET db_path = ? WHERE id = ?')
  for (const row of rows) backfill.run(join(row.path, PROJECT_DATABASE_FILE_NAME), row.id)
  db.prepare('UPDATE schema_meta SET value = ? WHERE key = ?').run(REGISTRY_FORMAT, 'format')
}

/**
 * Every registered project, newest first.
 * @param db - open registry connection.
 * @returns the registry records.
 */
export function selectRegistryProjects(db: DatabaseSync): ProjectRecord[] {
  const rows = db.prepare(`SELECT ${REGISTRY_COLUMNS} FROM projects ORDER BY created_at DESC, id`).all()
  return rows.map(row => projectRecord(row as RegistryRow))
}

/**
 * One registered project by id.
 * @param db - open registry connection.
 * @param id - project id to look up.
 * @returns the matching record, or `undefined` when the id is not registered.
 */
export function selectRegistryProject(db: DatabaseSync, id: ProjectId): ProjectRecord | undefined {
  const row = db.prepare(`SELECT ${REGISTRY_COLUMNS} FROM projects WHERE id = ?`).get(id) as RegistryRow | undefined
  return row === undefined ? undefined : projectRecord(row)
}

/**
 * One registered project by directory, the registry's uniqueness key.
 * @param db - open registry connection.
 * @param path - absolute project directory.
 * @returns the matching record, or `undefined` when no project uses the directory.
 */
export function selectRegistryProjectByPath(db: DatabaseSync, path: string): ProjectRecord | undefined {
  const row = db.prepare(`SELECT ${REGISTRY_COLUMNS} FROM projects WHERE path = ?`).get(path) as RegistryRow | undefined
  return row === undefined ? undefined : projectRecord(row)
}

/**
 * Insert one project row.
 * @param db - open registry connection.
 * @param record - project to register.
 * @returns nothing; the row is visible to later reads after the caller commits.
 */
export function insertRegistryProject(db: DatabaseSync, record: ProjectRecord): void {
  db.prepare('INSERT INTO projects (id, path, db_path, title, created_at, updated_at, definition_revision) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(record.id, record.path, record.dbPath, record.title, record.createdAt, record.updatedAt, record.definitionRevision)
}

/**
 * Record where one project's database lives.
 *
 * Moving the file is store bookkeeping, not a change the caller made, so the
 * row's `updated_at` keeps naming the last user-visible change.
 * @param db - open registry connection.
 * @param id - project whose database location changes.
 * @param dbPath - absolute path the database now lives at.
 * @returns nothing; the row is visible to later reads after the caller commits.
 */
export function updateRegistryDatabasePath(db: DatabaseSync, id: ProjectId, dbPath: string): void {
  db.prepare('UPDATE projects SET db_path = ? WHERE id = ?').run(dbPath, id)
}

/**
 * Refresh the definition revision hint of one project.
 * @param db - open registry connection.
 * @param id - project whose hint changes.
 * @param revision - latest committed definition revision.
 * @param updatedAt - epoch milliseconds of the change.
 * @returns nothing; the row is visible to later reads after the caller commits.
 */
export function updateRegistryDefinitionRevision(
  db: DatabaseSync,
  id: ProjectId,
  revision: number,
  updatedAt: number,
): void {
  db.prepare('UPDATE projects SET definition_revision = ?, updated_at = ? WHERE id = ?').run(revision, updatedAt, id)
}

/**
 * Replace the display title of one project.
 * @param db - open registry connection.
 * @param id - project whose title changes.
 * @param title - the new display title.
 * @param updatedAt - epoch milliseconds of the change.
 * @returns nothing; the row is visible to later reads after the caller commits.
 */
export function updateRegistryTitle(
  db: DatabaseSync,
  id: ProjectId,
  title: string,
  updatedAt: number,
): void {
  db.prepare('UPDATE projects SET title = ?, updated_at = ? WHERE id = ?').run(title, updatedAt, id)
}

/**
 * Delete one project row.
 * @param db - open registry connection.
 * @param id - project to remove from the registry.
 * @returns nothing; the project directory stays untouched.
 */
export function deleteRegistryProject(db: DatabaseSync, id: ProjectId): void {
  db.prepare('DELETE FROM projects WHERE id = ?').run(id)
}

/**
 * Convert one registry row to its public record, validating the stored database
 * path.
 * @param row - registry row in column declaration order.
 * @returns the record with a branded project id.
 * @throws {@link WorkflowProjectStoreError} `invalid-record` when the row names no absolute database path.
 */
function projectRecord(row: RegistryRow): ProjectRecord {
  if (!isAbsolute(row.db_path)) {
    throw new WorkflowProjectStoreError(
      'invalid-record',
      `project '${row.id}' records database path '${row.db_path}', which is not absolute`,
    )
  }
  return {
    id: brandString<ProjectId>(row.id),
    path: row.path,
    dbPath: row.db_path,
    title: row.title,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    definitionRevision: row.definition_revision,
  }
}
