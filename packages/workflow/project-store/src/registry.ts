/**
 * Global project registry: one SQLite database at `<home>/mwf/projects.db`
 * holding a row per workflow project. Rows carry no definition content; each
 * project database owns that.
 *
 * @module @metaworkflow/workflow-project-store/registry
 */

import type { DatabaseSync, SQLOutputValue } from 'node:sqlite'
import { brandString } from '@metaworkflow/brand'
import type { ProjectId, ProjectRecord } from './types.ts'
import { openWorkflowDatabase, type WorkflowDatabaseOpenOptions } from './open.ts'

/**
 * Registry layout version in `PRAGMA user_version`. A database stamped with any
 * other version is refused instead of migrated in place.
 */
export const WORKFLOW_PROJECT_REGISTRY_SCHEMA_VERSION = 1

/**
 * Registry `PRAGMA application_id` identity (`MWRP`). It differs from the
 * project database identity, so neither file can be opened as the other.
 */
export const WORKFLOW_PROJECT_REGISTRY_APPLICATION_ID = 0x4d575250

/** Stable `schema_meta` row naming this database's role and version. */
const REGISTRY_FORMAT = 'workflow-projects/1'

/** One row as `node:sqlite` hands it back: column values keyed by column name. */
type SqlRow = Record<string, SQLOutputValue>

/** One registry row in column declaration order. */
interface RegistryRow extends SqlRow {
  readonly id: string
  readonly path: string
  readonly title: string
  readonly created_at: number
  readonly updated_at: number
  readonly definition_revision: number
}

/** Columns every registry read selects, in declaration order. */
const REGISTRY_COLUMNS = 'id, path, title, created_at, updated_at, definition_revision'

/**
 * Open the project registry, creating and materializing it when absent.
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
    materialize: materializeRegistrySchema,
  })
}

/**
 * Create every registry table and index that does not exist yet.
 * @param db - connection whose identity and version are already accepted.
 * @returns nothing.
 */
function materializeRegistrySchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id                  TEXT PRIMARY KEY,
      path                TEXT NOT NULL UNIQUE,
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
  db.prepare('INSERT INTO projects (id, path, title, created_at, updated_at, definition_revision) VALUES (?, ?, ?, ?, ?, ?)')
    .run(record.id, record.path, record.title, record.createdAt, record.updatedAt, record.definitionRevision)
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
 * Delete one project row.
 * @param db - open registry connection.
 * @param id - project to remove from the registry.
 * @returns nothing; the project directory stays untouched.
 */
export function deleteRegistryProject(db: DatabaseSync, id: ProjectId): void {
  db.prepare('DELETE FROM projects WHERE id = ?').run(id)
}

/**
 * Convert one registry row to its public record.
 * @param row - registry row in column declaration order.
 * @returns the record with a branded project id.
 */
function projectRecord(row: RegistryRow): ProjectRecord {
  return {
    id: brandString<ProjectId>(row.id),
    path: row.path,
    title: row.title,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    definitionRevision: row.definition_revision,
  }
}
